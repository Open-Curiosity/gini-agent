"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useAuthorizations, useInvalidate } from "@/lib/queries";
import type { Authorization, AuthorizationRequestedBlock } from "@runtime/types";

// Agent-actor gate: the user approves or denies; the runtime performs the
// side effect. Renders with Approve/Deny buttons. See
// docs/adr/authorization-vs-setup-request.md.
//
// skill.run gets a friendlier treatment: the authorization payload minted by
// requestSkillScriptApproval carries { skillName, scriptName, scriptArgs },
// so the card renders a "Confirm: <skill>" header, the script args as
// key–value rows (instead of the raw-JSON reason), and Confirm/Deny buttons.
// The raw payload stays reachable via "Show details". Every other action
// keeps the generic action-label + reason rendering.

type SkillRunDetails = {
  skillName: string;
  scriptName: string;
  scriptArgs: Record<string, unknown>;
};

function parseSkillRunDetails(payload: Record<string, unknown> | undefined): SkillRunDetails | null {
  if (!payload) return null;
  const { skillName, scriptName, scriptArgs } = payload;
  if (typeof skillName !== "string" || skillName.length === 0) return null;
  if (typeof scriptName !== "string" || scriptName.length === 0) return null;
  if (!scriptArgs || typeof scriptArgs !== "object" || Array.isArray(scriptArgs)) return null;
  return { skillName, scriptName, scriptArgs: scriptArgs as Record<string, unknown> };
}

const ARG_VALUE_MAX_CHARS = 160;

// Primitive arg values render inline (long strings truncated); nested
// objects/arrays collapse to "…" — the full value lives under Show details.
function formatArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > ARG_VALUE_MAX_CHARS ? `${value.slice(0, ARG_VALUE_MAX_CHARS)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "…";
}

export function BlockAuthorizationRequested({ block }: { block: AuthorizationRequestedBlock }) {
  const invalidate = useInvalidate();
  const authorizations = useAuthorizations();
  const [expanded, setExpanded] = useState(false);

  const authorization = (authorizations.data ?? []).find((a) => a.id === block.authorizationId) ?? null;
  const isPending = authorization ? authorization.status === "pending" : true;
  const skillRun = block.action === "skill.run" ? parseSkillRunDetails(authorization?.payload) : null;

  const decide = useMutation({
    mutationFn: ({ op }: { op: "approve" | "deny" }) =>
      api<Authorization>(`/authorizations/${block.authorizationId}/${op}`, { method: "POST" }),
    onSuccess: () => {
      invalidate(["authorizations", "approvals", "tasks", "task", "chat", "threads", "threads-inbox", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const cardClass = isPending
    ? "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
    : "rounded-lg border border-border bg-background/40 p-3";

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-2">
        {skillRun ? (
          <>
            <span className="text-sm font-medium text-foreground">Confirm: {skillRun.skillName}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {skillRun.scriptName}
            </span>
          </>
        ) : (
          <span className="font-mono text-xs text-foreground">{block.action}</span>
        )}
        {!isPending && authorization ? <StatusPill value={authorization.status} /> : null}
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      {skillRun ? (
        Object.keys(skillRun.scriptArgs).length > 0 ? (
          <div className="mt-2 space-y-1">
            {Object.entries(skillRun.scriptArgs).map(([key, value]) => (
              <div key={key} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 text-[11px] text-muted-foreground">{key}</span>
                <span className="min-w-0 break-words text-foreground">{formatArgValue(value)}</span>
              </div>
            ))}
          </div>
        ) : null
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{block.summary}</p>
      )}
      {expanded && authorization ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
          {JSON.stringify(authorization.payload, null, 2)}
        </pre>
      ) : null}
      <div className={isPending ? "mt-2 flex gap-2" : "hidden"}>
        <Button
          size="sm"
          disabled={decide.isPending || !isPending}
          onClick={() => decide.mutate({ op: "approve" })}
        >
          {skillRun ? "Confirm" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={decide.isPending || !isPending}
          onClick={() => decide.mutate({ op: "deny" })}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}
