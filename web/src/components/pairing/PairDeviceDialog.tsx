"use client";

import { Smartphone } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TunnelQR } from "@/components/tunnel/TunnelQR";
import { useTunnel } from "@/components/tunnel/useTunnel";
import { PairRequestsPanel } from "./PairRequestsPanel";

/**
 * Operator-facing entry point for adding a device. The dialog shows a QR for the
 * live tunnel URL (the device scans it to land on the /pair page) alongside the
 * live approval panel, so the operator can scan and approve from one surface.
 *
 * The QR encodes `state.url` from the connected tunnel; without a connected
 * tunnel there is no public URL to hand a device, so we prompt to connect the
 * relay first instead of rendering an unscannable code.
 */
export function PairDeviceDialog({ className }: { className?: string }) {
  const { state } = useTunnel();
  const url = state.url ?? "";

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="default" className={className}>
          <Smartphone className="h-4 w-4" />
          Pair a device
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>Scan to add a phone or another browser</DialogDescription>
        </DialogHeader>

        {url ? (
          <div className="grid place-items-center py-2">
            <TunnelQR value={url} className="h-44 w-44" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Connect the relay tunnel first, then scan to pair a device.
          </p>
        )}

        <Separator />

        <PairRequestsPanel />
      </DialogContent>
    </Dialog>
  );
}
