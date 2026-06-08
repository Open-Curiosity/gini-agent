"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { authPayloadFields } from "./providerAuth";
import { displayProviderName, type ProviderCatalogItem } from "./ProviderCard";

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

export function EditProviderDialog({
  row,
  authLabel,
  icon: Icon,
  currentModel,
  currentAuthMode,
  currentAwsRegion,
  open,
  onOpenChange
}: {
  row: ProviderCatalogItem;
  authLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  currentModel?: string;
  // The active provider's persisted auth mode/region (anthropic only). The
  // dialog opens reflecting these so a SigV4 provider doesn't masquerade as a
  // key-auth one — and so the user can switch either direction.
  currentAuthMode?: string;
  currentAwsRegion?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isAnthropic = row.name === "anthropic";
  const initialMode: "bearer" | "aws-sigv4" =
    isAnthropic && currentAuthMode === "aws-sigv4" ? "aws-sigv4" : "bearer";
  const initialRegion = currentAwsRegion ?? "";
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState<string>(currentModel ?? row.models[0] ?? "");
  // Optional endpoint override, surfaced only for anthropic. Empty keeps the
  // current endpoint (setSetupProvider preserves an omitted baseUrl on the
  // active provider); a value re-points the transport (e.g. to Bedrock).
  const [baseUrl, setBaseUrl] = useState("");
  // anthropic auth mode. "aws-sigv4" signs each request with AWS IAM credentials
  // (no API key); awsRegion is optional (inferred from the Bedrock Base URL when
  // blank). Seeded from the provider's current mode and always sent on save.
  const [authMode, setAuthMode] = useState<"bearer" | "aws-sigv4">(initialMode);
  const [awsRegion, setAwsRegion] = useState(initialRegion);
  const sigv4 = isAnthropic && authMode === "aws-sigv4";

  // Reset transient inputs whenever the dialog opens for a new row.
  // currentModel/authMode/region can shift if the active provider changes
  // elsewhere; we want the dialog to reflect the most recent values on each open.
  useEffect(() => {
    if (!open) return;
    setApiKey("");
    setShowKey(false);
    setModel(currentModel ?? row.models[0] ?? "");
    setBaseUrl("");
    setAuthMode(initialMode);
    setAwsRegion(initialRegion);
  }, [open, row.id, currentModel, row.models, initialMode, initialRegion]);

  const save = useMutation({
    mutationFn: async (): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider", {
        method: "POST",
        body: JSON.stringify({
          provider: row.name,
          // The backend treats apiKey as optional when the env var is
          // already set, so model-only edits work without a re-type.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(model ? { model } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...authPayloadFields(isAnthropic, authMode, awsRegion)
        })
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error ?? `Failed to update ${displayProviderName(row)}.`);
        return;
      }
      toast.success(`${displayProviderName(row)} updated.`);
      queryClient.invalidateQueries({ queryKey: ["status"] });
      await queryClient.refetchQueries({ queryKey: ["providers"] });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // Save is allowed when the user changed something. apiKey is optional
  // for an env-already-set edit; model is required and defaults to the
  // current selection, so toggling it back to the same value still lets
  // the user dismiss via Cancel without nagging. authMode/awsRegion compare
  // against the seeded values so merely opening a SigV4 provider isn't "dirty".
  const dirty =
    apiKey.trim().length > 0 ||
    baseUrl.trim().length > 0 ||
    authMode !== initialMode ||
    (sigv4 && awsRegion.trim() !== initialRegion.trim()) ||
    (model !== "" && model !== (currentModel ?? row.models[0] ?? ""));
  const canSubmit = dirty && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 border-[#1F1F24] bg-[#141418] p-7 sm:max-w-md">
        <div className="flex items-start gap-3">
          <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-[#1D2333]">
            <Icon className="size-5 text-[#C2C2C8]" />
          </span>
          <div className="flex-1 space-y-0.5">
            <DialogTitle className="text-base font-bold text-foreground">Edit provider</DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              {displayProviderName(row)} · {authLabel}
            </DialogDescription>
          </div>
        </div>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) save.mutate();
          }}
        >
          {isAnthropic ? (
            <div className="space-y-2">
              <Label htmlFor="edit-auth-mode" className="text-[13px] font-semibold text-[#C2C2C8]">Authentication</Label>
              <Select value={authMode} onValueChange={(v) => setAuthMode(v as "bearer" | "aws-sigv4")} disabled={save.isPending}>
                <SelectTrigger id="edit-auth-mode" className="h-11 border-[#2A2A2E] bg-[#0E0E11] text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bearer" className="text-[13px]">API key (x-api-key)</SelectItem>
                  <SelectItem value="aws-sigv4" className="text-[13px]">AWS SigV4 (IAM credentials)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {!sigv4 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-api-key" className="text-[13px] font-semibold text-[#C2C2C8]">API key</Label>
                <span className="text-xs text-[#6A6A70]">Stored encrypted</span>
              </div>
              <div className="relative">
                <Input
                  id="edit-api-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  placeholder="Leave blank to keep the saved key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={save.isPending}
                  className="h-11 border-[#2A2A2E] bg-[#0E0E11] pr-11 font-mono text-[13px]"
                />
                <button
                  type="button"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#7A7A80] hover:text-foreground"
                >
                  {showKey ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
                </button>
              </div>
            </div>
          ) : null}

          {sigv4 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-aws-region" className="text-[13px] font-semibold text-[#C2C2C8]">AWS region</Label>
                <span className="text-xs text-[#6A6A70]">optional</span>
              </div>
              <Input
                id="edit-aws-region"
                type="text"
                autoComplete="off"
                placeholder="e.g. us-east-1 — blank infers from the Base URL"
                value={awsRegion}
                onChange={(e) => setAwsRegion(e.target.value)}
                disabled={save.isPending}
                className="h-11 border-[#2A2A2E] bg-[#0E0E11] font-mono text-[13px]"
              />
              <p className="text-xs text-[#6A6A70]">Signs requests with your AWS credentials (AWS_ACCESS_KEY_ID/SECRET or ~/.aws). No API key needed.</p>
            </div>
          ) : null}

          {isAnthropic ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-base-url" className="text-[13px] font-semibold text-[#C2C2C8]">Base URL</Label>
                <span className="text-xs text-[#6A6A70]">optional</span>
              </div>
              <Input
                id="edit-base-url"
                type="text"
                autoComplete="off"
                placeholder="Leave blank to keep the current endpoint"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={save.isPending}
                className="h-11 border-[#2A2A2E] bg-[#0E0E11] font-mono text-[13px]"
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-model" className="text-[13px] font-semibold text-[#C2C2C8]">Default model</Label>
              <span className="text-xs text-[#6A6A70]">
                {row.models.length} available
              </span>
            </div>
            <Select value={model} onValueChange={setModel} disabled={save.isPending}>
              <SelectTrigger
                id="edit-model"
                className="h-11 border-[#2A2A2E] bg-[#0E0E11] font-mono text-[13px]"
              >
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {row.models.map((m) => (
                  <SelectItem key={m} value={m} className="font-mono text-[13px]">{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-end gap-2.5 border-t border-[#1F1F26] pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
