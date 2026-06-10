"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/queries";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";

type UpdatePhase = "idle" | "updating" | "restarting" | "complete";

export interface UpdateGateValue {
  version: GiniVersionInfo | undefined;
  updateSupported: boolean;
  updateAvailable: boolean;
  phase: UpdatePhase;
  start: () => void;
}

const UpdateGateContext = createContext<UpdateGateValue | null>(null);

// Consumed by the sidebar's update control. Throws if rendered outside the
// provider so a missing mount surfaces loudly instead of silently no-op'ing.
export function useUpdateGate(): UpdateGateValue {
  const value = useContext(UpdateGateContext);
  if (!value) throw new Error("useUpdateGate must be used within <UpdateGateProvider>");
  return value;
}

// Applying an update restarts the gateway AND the web server, which can force a
// full page reload mid-update (Next dev fast-refresh on a server restart, or the
// user reloading). Persist the in-flight phase so a reload re-blurs the app and
// resumes watching for the new revision instead of briefly handing control back
// to the user. sessionStorage (not local) scopes the gate to this tab so it
// can't wedge "updating" across an unrelated future session.
const STORAGE_KEY = "gini.update.gate";

interface PersistedGate {
  phase: "updating" | "restarting" | "complete";
  // The revision the runtime should report once the update lands. Set after the
  // POST returns; absent if a reload interrupts the POST.
  targetSha?: string;
  // The revision when the update started. Lets a resumed gate detect completion
  // by "HEAD moved" even without a targetSha.
  beforeSha?: string;
  // The gateway pid when the update started. The restarting phase completes
  // only once a status poll reports a different pid — proof the response came
  // from the restarted gateway, not the old process winding down.
  beforePid?: number;
  // Whether the POST scheduled a runtime restart. When false the servers stay
  // up, so the gate may reload as soon as the new revision is reported.
  restartExpected?: boolean;
}

function readPersistedGate(): PersistedGate | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedGate;
    if (parsed.phase === "updating" || parsed.phase === "restarting" || parsed.phase === "complete") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writePersistedGate(value: PersistedGate | null): void {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-mode / quota failures leave the gate working in memory for this
    // page's lifetime; it just won't survive a mid-update reload.
  }
}

// Hold the "complete" confirmation on screen this long before reloading onto the
// freshly built assets.
const COMPLETE_RELOAD_DELAY_MS = 1_500;
// Generous ceiling for each waiting phase (git + bun install in both roots,
// then the restart). If a phase never reports back within this, the gate
// releases rather than trapping the user behind a permanent blur. The
// completion detectors normally tear the gate down long before this fires.
const STALL_TIMEOUT_MS = 120_000;

export function UpdateGateProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [targetSha, setTargetSha] = useState<string | null>(null);
  const [beforeSha, setBeforeSha] = useState<string | null>(null);
  const [beforePid, setBeforePid] = useState<number | null>(null);
  const [restartExpected, setRestartExpected] = useState(true);
  // When the gate entered "restarting" — see the pid-less fallback below.
  const [restartingSince, setRestartingSince] = useState<number | null>(null);

  // Poll status fast while updating/restarting so the new revision — and then
  // the restarted gateway — are picked up promptly.
  const waiting = phase === "updating" || phase === "restarting";
  const status = useStatus({ refetchInterval: waiting ? 1_500 : 60_000 });
  const statusVersion = status.data?.version;
  const statusSha = statusVersion?.git.sha ?? null;
  const statusPid = status.data?.pid ?? null;
  const updateSupported = statusVersion?.update.supported === true;

  const versionCheck = useQuery({
    queryKey: ["version", "check"],
    queryFn: () => api<GiniVersionInfo>("/update/check", { method: "POST" }),
    enabled: updateSupported && phase === "idle",
    refetchInterval: 5 * 60_000
  });
  const version = versionCheck.data ?? statusVersion;
  const updateAvailable = version?.git.updateAvailable === true;

  const reset = useCallback(() => {
    setPhase("idle");
    setTargetSha(null);
    setBeforeSha(null);
    setBeforePid(null);
    setRestartExpected(true);
    setRestartingSince(null);
    writePersistedGate(null);
  }, []);

  const update = useMutation({
    mutationFn: () => api<GiniUpdateResult>("/update", { method: "POST" }),
    onSuccess: (result) => {
      if (result.upToDate) {
        reset();
        toast.success("Gini is already current");
        qc.invalidateQueries({ queryKey: ["status"] });
        qc.invalidateQueries({ queryKey: ["version", "check"] });
        return;
      }
      // Keep the gate up; now wait for status to report this sha. Default to
      // expecting a restart when the result omits the field (an older gateway
      // build serving the POST) — every shipped non-upToDate path schedules one.
      const expectRestart = result.restart?.requested ?? true;
      setTargetSha(result.afterSha);
      setRestartExpected(expectRestart);
      writePersistedGate({
        phase: "updating",
        targetSha: result.afterSha,
        beforeSha: beforeSha ?? undefined,
        beforePid: beforePid ?? undefined,
        restartExpected: expectRestart
      });
    },
    onError: (error: Error) => {
      // Release the blur only on a structured gateway error — one that carries
      // an HTTP status, meaning the gateway responded non-2xx (a genuine
      // pre-flight failure). Any other rejection (fetch failing, or the body
      // parse throwing on a truncated response) means the gateway most likely
      // applied the update and restarted before the response flushed: keep the
      // blur and let the new-revision detector / stall timer resolve it rather
      // than handing the app back mid-update.
      const status = (error as Error & { status?: number }).status;
      if (typeof status === "number") {
        reset();
        toast.error(error.message);
      }
    }
  });
  const { mutate, isPending } = update;

  const start = useCallback(() => {
    if (phase !== "idle") return;
    // Blur immediately on click — the POST itself (git + bun install) is the
    // slow part, so the gate must go up before awaiting it.
    setBeforeSha(statusSha);
    setBeforePid(statusPid);
    setPhase("updating");
    writePersistedGate({
      phase: "updating",
      beforeSha: statusSha ?? undefined,
      beforePid: statusPid ?? undefined
    });
    mutate();
  }, [phase, statusSha, statusPid, mutate]);

  // Resume an in-flight gate after a restart-triggered reload.
  useEffect(() => {
    const persisted = readPersistedGate();
    if (!persisted) return;
    if (persisted.phase === "complete") {
      setPhase("complete");
      return;
    }
    setTargetSha(persisted.targetSha ?? null);
    setBeforeSha(persisted.beforeSha ?? null);
    setBeforePid(persisted.beforePid ?? null);
    setRestartExpected(persisted.restartExpected ?? true);
    setPhase(persisted.phase);
  }, []);

  // Status reports the new revision → the update landed on disk. Match the
  // explicit target when we have it; otherwise (a reload interrupted the POST)
  // fall back to "HEAD moved off the starting revision". The fallback is gated
  // on the POST having settled so a status poll during the slow POST — when
  // HEAD has been reset on disk but the runtime is still installing — can't
  // advance the gate early. The new sha alone does NOT mean the new stack is
  // up: version info is read from git per request, so the still-running OLD
  // gateway reports it immediately while the restart is about to tear both
  // servers down. When a restart is coming, hold in "restarting" until the
  // restarted gateway answers; only a restart-free update may complete here.
  useEffect(() => {
    if (phase !== "updating" || !statusSha) return;
    const matchedTarget = targetSha != null && statusSha === targetSha;
    const movedOffStart = !isPending && beforeSha != null && statusSha !== beforeSha;
    if (!matchedTarget && !movedOffStart) return;
    if (restartExpected) {
      setPhase("restarting");
      writePersistedGate({ phase: "restarting", beforePid: beforePid ?? undefined });
    } else {
      setPhase("complete");
      writePersistedGate({ phase: "complete" });
    }
  }, [phase, targetSha, beforeSha, statusSha, isPending, restartExpected, beforePid]);

  // Wall-clock the moment the gate began waiting on the restart; consumed only
  // by the pid-less fallback in the completion detector below.
  useEffect(() => {
    if (phase === "restarting") setRestartingSince(Date.now());
  }, [phase]);

  // The restarting phase completes only once a status response provably came
  // from the restarted stack. Primary signal: the gateway pid changed — cached
  // query data still carries the old pid, so a differing pid is intrinsically
  // a fresh post-restart response served through a live web server. Fallback
  // when the starting pid is unknown (a gate persisted by an older page, or
  // status omitting pid): the first poll that succeeds after entering this
  // phase — that proves web + gateway are reachable, with a small residual
  // race against the dying old stack that's acceptable for the degraded path.
  // While the servers are down the polls just reject; react-query keeps
  // refetching on the interval and retains the last (old-pid) data.
  const statusUpdatedAt = status.dataUpdatedAt;
  useEffect(() => {
    if (phase !== "restarting") return;
    const restarted =
      beforePid != null
        ? statusPid != null && statusPid !== beforePid
        : restartingSince != null && statusUpdatedAt > restartingSince;
    if (restarted) {
      setPhase("complete");
      writePersistedGate({ phase: "complete" });
    }
  }, [phase, beforePid, statusPid, restartingSince, statusUpdatedAt]);

  // Once complete, reload onto the fresh assets. Clear the persisted gate first
  // so the reloaded page comes up clean.
  useEffect(() => {
    if (phase !== "complete") return;
    const timer = setTimeout(() => {
      writePersistedGate(null);
      window.location.reload();
    }, COMPLETE_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Safety net spanning the waiting phases: release if the update never
  // reports back (a hung POST, a failed restart, or a reload that lost the
  // target revision). Status polling doesn't reset this — its deps are stable
  // within a phase — but the updating → restarting transition re-arms it, so
  // the worst case is ~2× STALL_TIMEOUT_MS before the gate releases.
  useEffect(() => {
    if (phase !== "updating" && phase !== "restarting") return;
    const timer = setTimeout(() => {
      reset();
      toast.error("Update is taking longer than expected. Reload to check on it.");
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["version", "check"] });
    }, STALL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, reset, qc]);

  const value = useMemo<UpdateGateValue>(
    () => ({ version, updateSupported, updateAvailable, phase, start }),
    [version, updateSupported, updateAvailable, phase, start]
  );

  return (
    <UpdateGateContext.Provider value={value}>
      {/* `inert` while a gate is up makes the whole app unreachable — not just
          unclickable behind the overlay, but un-tabbable for keyboard users.
          display:contents keeps the wrapper out of layout. */}
      <div className="contents" inert={phase !== "idle"}>
        {children}
      </div>
      {phase !== "idle" ? <UpdateOverlay phase={phase} /> : null}
    </UpdateGateContext.Provider>
  );
}

const OVERLAY_COPY: Record<Exclude<UpdatePhase, "idle">, { title: string; detail: string }> = {
  updating: {
    title: "Updating Gini",
    detail: "Gini is updating. The app will be unavailable until it finishes."
  },
  restarting: {
    title: "Restarting Gini",
    detail: "Gini is restarting onto the new version…"
  },
  complete: {
    title: "Update complete",
    detail: "Reloading the app…"
  }
};

// Full-viewport blur that blocks all interaction while an update is applied
// and the stack restarts, then confirms completion before the reload. Rendered
// at the provider root so it covers the sidebar and main pane alike.
function UpdateOverlay({ phase }: { phase: Exclude<UpdatePhase, "idle"> }) {
  const complete = phase === "complete";
  const copy = OVERLAY_COPY[phase];
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-busy={!complete}
      aria-label={copy.title}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-md"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-popover/95 px-8 py-7 text-center shadow-2xl">
        {complete ? (
          <CheckCircle2 className="size-7 text-emerald-500" />
        ) : (
          <Loader2 className="size-7 animate-spin text-muted-foreground" />
        )}
        <div className="text-sm font-semibold text-popover-foreground">{copy.title}</div>
        <div className="max-w-[240px] text-xs text-muted-foreground">{copy.detail}</div>
      </div>
    </div>
  );
}
