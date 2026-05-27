"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { EyeOff, Loader2, RefreshCw, RotateCw, ShieldAlert } from "lucide-react";

interface TunnelSnapshot {
  enabled: boolean;
  secret: string | null;
  publicUrl: string | null;
  secretRevision: string | null;
  lastError: string | null;
  appleNotes: {
    enabled: boolean;
    notesAvailable: boolean | null;
    lastError: string | null;
  };
}

type ConfirmKind = "disable" | "rotate" | null;

export function TunnelCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["tunnel"],
    queryFn: () => api<TunnelSnapshot>("/tunnel"),
    refetchInterval: 5_000
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tunnel"] });
    qc.invalidateQueries({ queryKey: ["tunnel-launcher"] });
  };

  const enable = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ enabled: true }) }),
    onSuccess: () => { toast.success("Tunnel enabled"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const disable = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    onSuccess: () => { toast.success("Tunnel disabled"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const rotate = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ rotateSecret: true }) }),
    onSuccess: () => { toast.success("Secret rotated"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const toggleNotes = useMutation({
    mutationFn: (enabled: boolean) =>
      api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ appleNotes: { enabled } }) }),
    onSuccess: (_, enabled) => { toast.success(`Apple Notes mirror ${enabled ? "enabled" : "disabled"}`); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const refreshNotes = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel/refresh-notes", { method: "POST" }),
    onSuccess: () => { toast.success("Notes refreshed"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const [showSecret, setShowSecret] = useState(false);
  const [qrRevealed, setQrRevealed] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);

  const busy = enable.isPending || disable.isPending || rotate.isPending || toggleNotes.isPending || refreshNotes.isPending;
  // Privileged shape: this client is on loopback and the snapshot includes
  // secret + publicUrl. Redacted shape (publicUrl=null) means the BFF
  // rewrote our snapshot request to /api/tunnel/redacted — we're a
  // tunnel-vetted browser caller, not the operator on loopback.
  const isTunneledView = Boolean(data?.enabled && !data?.publicUrl);
  const tunnelLive = Boolean(data?.enabled && data?.publicUrl);

  const runConfirmed = (kind: Exclude<ConfirmKind, null>) => {
    setConfirm(null);
    if (kind === "disable") disable.mutate();
    if (kind === "rotate") rotate.mutate();
  };

  return (
    <Card data-testid="tunnel-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              Mobile tunnel
              {isLoading ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : data?.enabled ? (
                <Badge variant="secondary" data-testid="tunnel-status-pill">live</Badge>
              ) : (
                <Badge variant="outline" data-testid="tunnel-status-pill">off</Badge>
              )}
              {isTunneledView ? <Badge variant="outline">via tunnel</Badge> : null}
            </CardTitle>
            <CardDescription>
              Cloudflare quick tunnel gated by a per-instance 192-bit secret. Scan from your phone to reach this
              gateway anywhere.
            </CardDescription>
          </div>
          {/* On a tunneled view the deny list blocks PATCH /api/runtime/tunnel
              entirely — clicking Disable / Rotate here would just 404. Hide
              the controls and show a localhost hint instead so the operator
              isn't confused by buttons that don't work. The Enable / Disable /
              Rotate buttons render only when this client is on loopback. */}
          {isTunneledView ? null : (
            <div className="flex gap-2">
              {data?.enabled ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("disable")}>
                  Disable
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => enable.mutate()}>
                  Enable
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                disabled={busy || !data?.enabled}
                onClick={() => setConfirm("rotate")}
                aria-label="Rotate secret"
              >
                <RotateCw className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {tunnelLive ? (
          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <button
              type="button"
              onClick={() => setQrRevealed((r) => !r)}
              aria-label={qrRevealed ? "Hide tunnel QR" : "Reveal tunnel QR"}
              className="group relative h-48 w-48 overflow-hidden rounded border bg-white p-2"
              data-testid="tunnel-qr-reveal-toggle"
            >
              <img
                src={`/api/runtime/tunnel/qr.svg?v=${encodeURIComponent(data?.secretRevision ?? "")}`}
                alt="Tunnel QR"
                className={`h-full w-full transition duration-200 ${qrRevealed ? "blur-0" : "blur-md"}`}
                data-testid="tunnel-settings-qr"
              />
              {!qrRevealed ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/60 text-foreground backdrop-blur-sm transition group-hover:bg-background/70">
                  <EyeOff className="h-6 w-6" />
                  <span className="text-xs font-medium">Click to reveal</span>
                </div>
              ) : null}
            </button>
            <div className="space-y-2 text-sm">
              <div>
                <div className="text-muted-foreground">Public URL</div>
                <code className="break-all text-xs">{data?.publicUrl}</code>
              </div>
              <div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  Secret
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setShowSecret((s) => !s)}>
                    {showSecret ? "Hide" : "Show"}
                  </Button>
                </div>
                <code className="text-xs">
                  {showSecret ? data?.secret : "•".repeat(data?.secret?.length ?? 32)}
                </code>
              </div>
            </div>
          </div>
        ) : isTunneledView ? (
          // Tunneled view: we can't surface the QR / secret / publicUrl here
          // (the QR endpoints are denied through the tunnel and the BFF
          // rewrites the snapshot to the redacted shape). Show enough
          // context so the operator knows the tunnel is live and where
          // mutations actually have to be issued.
          <div className="space-y-2 rounded border bg-muted/30 px-3 py-3 text-sm">
            <p className="font-medium">You&apos;re connected via the Cloudflare tunnel.</p>
            <p className="text-muted-foreground">
              The QR code, public URL, and secret are only visible from the operator&apos;s localhost browser
              — the deny list keeps tunnel-control surfaces (rotate, disable, QR endpoints, pairing) off of
              the public path so a leaked URL can&apos;t mint a fresh claim.
            </p>
            <p className="text-xs text-muted-foreground">
              Host: <code className="break-all">{typeof window !== "undefined" ? window.location.host : ""}</code>
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Enable the tunnel to publish a Cloudflare URL. The QR contains a one-time secret and a session
            cookie scopes future requests to this exact tunnel hostname.
          </p>
        )}

        {data?.lastError ? (
          <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <span className="font-medium">Last error:</span> {data.lastError}
          </p>
        ) : null}

        {/* Apple Notes mirror is a tunnel-mutation surface (PATCH
            /api/runtime/tunnel with appleNotes payload). Tunneled clients
            can't enable / disable / refresh it, so hide the controls on
            the tunneled view. */}
        {isTunneledView ? null : (
          <div className="space-y-2 rounded border bg-muted/30 px-3 py-3 text-sm">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Apple Notes mirror</div>
                <div className="text-xs text-muted-foreground">
                  Opt-in. The live URL is written into iCloud Notes so your phone sees the new URL after a restart.
                </div>
              </div>
              <Button
                size="sm"
                variant={data?.appleNotes.enabled ? "outline" : "default"}
                disabled={busy}
                onClick={() => toggleNotes.mutate(!data?.appleNotes.enabled)}
              >
                {data?.appleNotes.enabled ? "Disable" : "Enable"}
              </Button>
            </div>
            {data?.appleNotes.enabled ? (
              <div className="flex items-center gap-2 text-xs">
                {data?.appleNotes.notesAvailable === false ? (
                  <Badge variant="destructive">Unavailable</Badge>
                ) : data?.appleNotes.notesAvailable === true ? (
                  <Badge variant="secondary">Available</Badge>
                ) : (
                  <Badge variant="outline">Probing…</Badge>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => refreshNotes.mutate()}>
                  <RefreshCw className="mr-1 h-3 w-3" /> Refresh
                </Button>
                {data?.appleNotes.lastError ? (
                  <span className="text-destructive">{data.appleNotes.lastError}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>

      {/* Confirmation dialog for destructive transitions. Disable kills any
          active tunneled session immediately (the proxy reads
          tunnel.enabled per request); rotate-secret invalidates every
          outstanding cookie on the very next hit. The operator is doing
          this on purpose, but a one-click button is easy to misfire. */}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              {confirm === "disable" ? "Disable the tunnel?" : "Rotate the tunnel secret?"}
            </DialogTitle>
            <DialogDescription>
              {confirm === "disable" ? (
                <>
                  This stops <code className="font-mono">cloudflared</code> and revokes every outstanding
                  session cookie immediately. Any phone or browser currently connected via the tunnel
                  will start getting 404s on the next request and has to re-scan a fresh QR after you
                  re-enable. Your loopback browser is unaffected.
                </>
              ) : (
                <>
                  This mints a fresh 192-bit secret and writes it to <code className="font-mono">config.json</code>.
                  Every outstanding session cookie (including any phone you&apos;ve already paired) mismatches
                  on the very next request and gets a 404. The Cloudflare hostname stays the same; only the
                  secret prefix changes. Re-scan the new QR to reconnect.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              variant={confirm === "disable" ? "destructive" : "default"}
              onClick={() => confirm && runConfirmed(confirm)}
            >
              {confirm === "disable" ? "Disable" : "Rotate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
