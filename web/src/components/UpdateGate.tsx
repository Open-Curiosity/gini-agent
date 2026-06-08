"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/queries";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";

type UpdatePhase = "idle" | "updating" | "complete";

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
  phase: "updating" | "complete";
  targetSha?: string;
}

function readPersistedGate(): PersistedGate | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedGate;
    if (parsed.phase === "updating" || parsed.phase === "complete") return parsed;
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
// If the restarted runtime never reports the new revision, release the gate
// after this rather than trap the user behind a permanent blur.
const STALL_TIMEOUT_MS = 30_000;

export function UpdateGateProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [targetSha, setTargetSha] = useState<string | null>(null);
  // Armed once we're genuinely waiting for the restarted runtime to report back
  // (the POST returned, or we resumed mid-update after a reload). Gates the
  // stall timer so a slow `bun install` during the POST itself can't trip it.
  const [stallArmed, setStallArmed] = useState(false);

  // Poll status fast while updating so the new revision is picked up promptly.
  const status = useStatus({ refetchInterval: phase === "updating" ? 1_500 : 60_000 });
  const statusVersion = status.data?.version;
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
    setStallArmed(false);
    writePersistedGate(null);
  }, []);

  // Resume an in-flight gate after a restart-triggered reload.
  useEffect(() => {
    const persisted = readPersistedGate();
    if (!persisted) return;
    if (persisted.phase === "complete") {
      setPhase("complete");
      return;
    }
    setTargetSha(persisted.targetSha ?? null);
    setStallArmed(true);
    setPhase("updating");
  }, []);

  // The restarted runtime reports the target revision → the update landed.
  useEffect(() => {
    if (phase !== "updating") return;
    if (targetSha && statusVersion?.git.sha === targetSha) {
      setPhase("complete");
      writePersistedGate({ phase: "complete" });
    }
  }, [phase, targetSha, statusVersion?.git.sha]);

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

  // Safety net for an update that applied but never reported back.
  useEffect(() => {
    if (phase !== "updating" || !stallArmed) return;
    const timer = setTimeout(() => {
      reset();
      toast.error("Update applied, but the runtime hasn't reported back. Reload to check.");
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["version", "check"] });
    }, STALL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, stallArmed, reset, qc]);

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
      // Keep the gate up; now wait for the restarted runtime to report this sha.
      setTargetSha(result.afterSha);
      setStallArmed(true);
      writePersistedGate({ phase: "updating", targetSha: result.afterSha });
    },
    onError: (error: Error) => {
      reset();
      toast.error(error.message);
    }
  });

  const start = useCallback(() => {
    if (phase !== "idle") return;
    // Blur immediately on click — the POST itself (git + bun install) is the
    // slow part, so the gate must go up before awaiting it.
    setPhase("updating");
    writePersistedGate({ phase: "updating" });
    update.mutate();
  }, [phase, update]);

  return (
    <UpdateGateContext.Provider value={{ version, updateSupported, updateAvailable, phase, start }}>
      {children}
      {phase !== "idle" ? <UpdateOverlay complete={phase === "complete"} /> : null}
    </UpdateGateContext.Provider>
  );
}

// Full-viewport blur that blocks all interaction while an update is applied,
// then confirms completion before the reload. Rendered at the provider root so
// it covers the sidebar and main pane alike.
function UpdateOverlay({ complete }: { complete: boolean }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-busy={!complete}
      aria-label={complete ? "Update complete" : "Updating Gini"}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-md"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#2E2E34] bg-[#101014]/90 px-8 py-7 text-center shadow-2xl">
        {complete ? (
          <CheckCircle2 className="size-7 text-emerald-400" />
        ) : (
          <Loader2 className="size-7 animate-spin text-[#C2C2C8]" />
        )}
        <div className="text-sm font-semibold text-white">
          {complete ? "Update complete" : "Updating Gini"}
        </div>
        <div className="max-w-[240px] text-xs text-[#9A9AA0]">
          {complete
            ? "Reloading the app…"
            : "Gini is updating. The app will be unavailable until it finishes."}
        </div>
      </div>
    </div>
  );
}
