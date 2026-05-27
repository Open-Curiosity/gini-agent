"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { EyeOff, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

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

async function fetchTunnel(): Promise<TunnelSnapshot> {
  const res = await fetch("/api/runtime/tunnel", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Tunnel snapshot fetch failed (${res.status})`);
  return (await res.json()) as TunnelSnapshot;
}

export function TunnelQrLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // QR + URL default to HIDDEN inside the modal; the operator clicks the eye
  // overlay to reveal once they're actually about to scan. Re-hidden every
  // time the modal closes so the next open starts safe again.
  const [qrRevealed, setQrRevealed] = useState(false);
  useEffect(() => {
    if (!open) setQrRevealed(false);
  }, [open]);
  const isSetup = pathname.startsWith("/setup");

  const { data } = useQuery({
    queryKey: ["tunnel-launcher"],
    queryFn: fetchTunnel,
    refetchInterval: 5_000,
    // Failures don't matter for the launcher; just hide it.
    retry: 1,
    enabled: !isSetup
  });

  // Hide on /setup/* per PLAN.md "Goals", and when the tunnel is off (no
  // bootstrap URL to encode). The tunneled view now receives the same
  // privileged snapshot as loopback, so we render the icon there too —
  // the click-to-reveal blur + bold "live credential" warning gates the
  // QR pixels the same way it does on loopback.
  if (isSetup) return null;
  if (!data?.enabled || !data.publicUrl) return null;

  return (
    <>
      <Button
        size="icon"
        variant="outline"
        aria-label="Open mobile QR"
        className="fixed right-4 top-4 z-50 h-10 w-10 rounded-full shadow-md"
        onClick={() => setOpen(true)}
        data-testid="tunnel-qr-launcher"
      >
        <QrCode className="h-5 w-5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Scan with your phone</DialogTitle>
            <DialogDescription>
              Open the camera on your phone and point it at the QR code. The link contains a{" "}
              <strong className="font-semibold text-foreground">one-time secret</strong> — anyone who
              scans it (or photographs your screen) gets the same access you have. <strong className="font-semibold text-foreground">Keep it
              private</strong>; rotate from Settings if you suspect a leak.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => setQrRevealed((r) => !r)}
              aria-label={qrRevealed ? "Hide tunnel QR" : "Reveal tunnel QR"}
              className="group relative h-64 w-64 overflow-hidden rounded border bg-white p-2"
              data-testid="tunnel-qr-reveal-toggle"
            >
              <img
                src={`/api/runtime/tunnel/qr.svg?v=${encodeURIComponent(data.secretRevision ?? "")}`}
                alt="Tunnel QR"
                className={`h-full w-full transition duration-200 ${qrRevealed ? "blur-0" : "blur-md"}`}
                data-testid="tunnel-qr-image"
              />
              {!qrRevealed ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/60 text-foreground backdrop-blur-sm transition group-hover:bg-background/70">
                  <EyeOff className="h-8 w-8" />
                  <span className="text-sm font-semibold">Click to reveal</span>
                  <span className="px-3 text-center text-[10px] uppercase tracking-wider text-muted-foreground">
                    Contains a live secret
                  </span>
                </div>
              ) : null}
            </button>
            {/* The text mirror of the bootstrap URL — also hidden until the
                operator reveals. The launcher is loopback-only (hidden in
                tunneled contexts) so surfacing the secret here is the same
                trust boundary as the QR image itself; the gate is about
                shoulder-surfing, not about cross-process authorization. */}
            <p className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              {qrRevealed && data.publicUrl && data.secret
                ? `${data.publicUrl.replace(/\/+$/, "")}/${data.secret}`
                : "•••••••••••••••••••••••••••••••••••"}
            </p>
          </div>
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </>
  );
}
