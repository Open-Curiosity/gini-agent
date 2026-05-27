import type { RuntimeConfig } from "../../types";
import { appendLog } from "../../state";
import { setRedactionPublicUrl, setRedactionSecret, redact } from "./redact";
import { launchCloudflared, type CloudflaredLaunch } from "./cloudflared";
import { probeNotesAvailable, writeNote, clearNote } from "./apple-notes";
import { ensureTunnelConfig, patchTunnelConfig, readTunnelConfig } from "./config-store";
import type { AppleNotesState, TunnelSnapshot, TunnelTransitionResult, TunnelPersistedConfig } from "./types";

// Tunnel manager. Owns the in-memory snapshot, the cloudflared subprocess,
// and the Apple Notes mirror. Every state transition (enable/disable/recycle/
// rotate) goes through a single serialized apply path. See PLAN.md
// "Operational invariants".

const NOTES_FOLDER = "gini";

let manager: TunnelManager | null = null;

export function tunnelManager(config: RuntimeConfig): TunnelManager {
  if (!manager) manager = new TunnelManager(config);
  return manager;
}

/** Test-only reset. */
export function __resetTunnelManagerForTests(): void {
  if (manager) {
    void manager.stopForShutdown();
  }
  manager = null;
}

class TunnelManager {
  private snapshot: TunnelSnapshot;
  private cloudflared: CloudflaredLaunch | null = null;
  private generation = 0;
  // Serialize every apply-path mutation. Promise chain serves as a queue.
  private applyChain: Promise<void> = Promise.resolve();
  private notesAvailable: boolean | null = null;

  constructor(private readonly config: RuntimeConfig) {
    // Eagerly populate config (mints secret if missing). The on-disk write is
    // idempotent — subsequent boots see the existing block and skip the
    // rewrite, so config.json's mtime doesn't leak enable history.
    const persisted = ensureTunnelConfig(config.instance);
    this.snapshot = {
      enabled: persisted.enabled,
      secret: persisted.secret,
      publicUrl: null,
      lastError: null,
      appleNotes: {
        enabled: persisted.appleNotes.enabled,
        notesAvailable: null,
        lastError: null
      }
    };
    setRedactionSecret(persisted.secret);
    // Probe Notes availability once on construction. Failures latch into
    // `lastError`, NOT into `notesAvailable` — that field stays null until a
    // successful probe answers it.
    void probeNotesAvailable().then((result) => {
      this.notesAvailable = result.available;
      this.snapshot = {
        ...this.snapshot,
        appleNotes: {
          ...this.snapshot.appleNotes,
          notesAvailable: result.available,
          lastError: result.available ? null : redact(result.error ?? "Notes unavailable")
        }
      };
    });
  }

  current(): TunnelSnapshot {
    return this.snapshot;
  }

  /** Current persisted-config view. Cheap; reads memory then disk. */
  private readPersisted(): TunnelPersistedConfig {
    return readTunnelConfig(this.config.instance);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let outerResolve!: (value: T) => void;
    let outerReject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => { outerResolve = res; outerReject = rej; });
    this.applyChain = this.applyChain.then(async () => {
      try {
        outerResolve(await fn());
      } catch (err) {
        outerReject(err);
      }
    });
    return promise;
  }

  async enable(webPort: number): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      try {
        // Commit enabled:true to config first. The proxy reads tunnel.enabled
        // on every request; ordering is important for the 5000 ms exposure cap.
        const persisted = patchTunnelConfig(this.config.instance, { enabled: true });
        setRedactionSecret(persisted.secret);
        // Stop any existing tunnel before spawning a new one — call sites use
        // this both to bring up after disable and to recycle on port change.
        if (this.cloudflared) {
          const prev = this.cloudflared;
          this.cloudflared = null;
          await prev.stop();
        }
        const launch = launchCloudflared({ port: webPort });
        this.cloudflared = launch;
        try {
          const url = await launch.publicUrl;
          this.snapshot = {
            ...this.snapshot,
            enabled: true,
            secret: persisted.secret,
            publicUrl: url,
            lastError: null
          };
          setRedactionPublicUrl(url);
          appendLog(this.config.instance, "tunnel.enabled", { generation: this.generation });
          // Fire Notes refresh asynchronously when enabled.
          if (this.snapshot.appleNotes.enabled) void this.refreshNotes();
        } catch (err) {
          this.cloudflared = null;
          const msg = err instanceof Error ? err.message : String(err);
          this.snapshot = { ...this.snapshot, lastError: redact(msg) };
          appendLog(this.config.instance, "tunnel.enable.error", { error: redact(msg) });
          return { ok: false, error: redact(msg) };
        }
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
  }

  async disable(): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      try {
        this.generation += 1;
        // Commit enabled:false BEFORE killing cloudflared. Without this
        // ordering the proxy could read stale enabled:true between cloudflared
        // termination and config commit. See PLAN.md "Operational invariants".
        patchTunnelConfig(this.config.instance, { enabled: false });
        if (this.cloudflared) {
          const prev = this.cloudflared;
          this.cloudflared = null;
          await prev.stop();
        }
        // Clear iCloud Notes copy on disable transition if Notes mirror is on.
        if (this.snapshot.appleNotes.enabled && this.notesAvailable) {
          try {
            await clearNote(NOTES_FOLDER, this.notesNoteName());
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.snapshot = {
              ...this.snapshot,
              appleNotes: { ...this.snapshot.appleNotes, lastError: redact(msg) }
            };
          }
        }
        this.snapshot = { ...this.snapshot, enabled: false, publicUrl: null, lastError: null };
        setRedactionPublicUrl(null);
        appendLog(this.config.instance, "tunnel.disabled", { generation: this.generation });
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
  }

  /** Mint a fresh secret atomically. The next request's cookie no longer
   *  matches the live secret — 404 on the next hit. */
  async rotateSecret(): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      try {
        const persisted = patchTunnelConfig(this.config.instance, {}); // ensure block exists
        const next = patchTunnelConfig(this.config.instance, { secret: cryptoSecret() });
        this.snapshot = { ...this.snapshot, secret: next.secret };
        setRedactionSecret(next.secret);
        // Refresh Notes if mirror is on and tunnel is up — the note carries
        // the URL which embeds the secret as the QR-encoded path.
        if (this.snapshot.appleNotes.enabled && this.snapshot.publicUrl && this.notesAvailable) {
          try {
            await writeNote({
              folder: NOTES_FOLDER,
              noteName: this.notesNoteName(),
              body: bootstrapUrl(this.snapshot.publicUrl, next.secret)
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.snapshot = {
              ...this.snapshot,
              appleNotes: { ...this.snapshot.appleNotes, lastError: redact(msg) }
            };
          }
        }
        appendLog(this.config.instance, "tunnel.secret-rotated", {});
        // No persisted result captured from `persisted` — avoids unused-var warning.
        void persisted;
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
  }

  async setAppleNotesEnabled(enabled: boolean): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      try {
        patchTunnelConfig(this.config.instance, { appleNotes: { enabled } });
        const notes: AppleNotesState = {
          enabled,
          notesAvailable: this.notesAvailable,
          lastError: null
        };
        this.snapshot = { ...this.snapshot, appleNotes: notes };
        if (enabled) {
          await this.refreshNotes();
        } else if (this.notesAvailable) {
          try {
            await clearNote(NOTES_FOLDER, this.notesNoteName());
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.snapshot = {
              ...this.snapshot,
              appleNotes: { ...this.snapshot.appleNotes, lastError: redact(msg) }
            };
          }
        }
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...this.snapshot, lastError: redact(msg) };
        return { ok: false, error: redact(msg) };
      }
    });
  }

  async refreshNotes(): Promise<TunnelTransitionResult> {
    return this.enqueue(async () => {
      const url = this.snapshot.publicUrl;
      const secret = this.snapshot.secret;
      if (!url || !secret) {
        return { ok: false, error: "Tunnel not enabled" };
      }
      if (!this.snapshot.appleNotes.enabled) {
        return { ok: false, error: "Apple Notes mirror disabled" };
      }
      // Re-probe availability before writing — handles TCC denial recovery.
      const probe = await probeNotesAvailable();
      this.notesAvailable = probe.available;
      if (!probe.available) {
        const msg = redact(probe.error ?? "Notes unavailable");
        this.snapshot = {
          ...this.snapshot,
          appleNotes: { ...this.snapshot.appleNotes, notesAvailable: false, lastError: msg }
        };
        return { ok: false, error: msg };
      }
      try {
        await writeNote({
          folder: NOTES_FOLDER,
          noteName: this.notesNoteName(),
          body: bootstrapUrl(url, secret)
        });
        this.snapshot = {
          ...this.snapshot,
          appleNotes: { ...this.snapshot.appleNotes, notesAvailable: true, lastError: null }
        };
        return { ok: true, snapshot: this.snapshot };
      } catch (err) {
        const msg = redact(err instanceof Error ? err.message : String(err));
        this.snapshot = {
          ...this.snapshot,
          appleNotes: { ...this.snapshot.appleNotes, lastError: msg }
        };
        return { ok: false, error: msg };
      }
    });
  }

  /** Stop cloudflared as part of gateway shutdown. Does not modify config. */
  async stopForShutdown(): Promise<void> {
    if (this.cloudflared) {
      const prev = this.cloudflared;
      this.cloudflared = null;
      await prev.stop();
    }
  }

  private notesNoteName(): string {
    return `gini-tunnel-${this.config.instance}`;
  }
}

function cryptoSecret(): string {
  // Delegate to the same generator used at boot. Imported lazily to avoid
  // import-cycle paranoia (this file is the highest layer in the tunnel
  // subtree).
  return require("./secret").generateTunnelSecret() as string;
}

/** Compose the bootstrap URL the phone scans: `<publicUrl>/<secret>/`. */
export function bootstrapUrl(publicUrl: string, secret: string): string {
  const trimmed = publicUrl.replace(/\/+$/, "");
  return `${trimmed}/${secret}/`;
}
