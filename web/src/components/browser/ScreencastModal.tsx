"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, streamUrl } from "@/lib/api";

// Live sign-in screencast. Mounted by the browser.connect approval card once
// the user has approved ("Connect to agent's browser") and the server has
// stamped the setup request as a screencast (signInStarted + screencast). It
// streams JPEG frames of the agent's headless browser over an SSE channel
// (proxied by the BFF, which injects the gateway bearer server-side — the
// browser never holds the token) and relays the user's clicks/keys back via a
// POST endpoint. The user signs in on the live page, then clicks "I've signed
// in" to complete the setup request and resume the agent's task.
//
// There is intentionally NO URL bar: the modal drives the page the agent
// already reached. Free navigation would bypass the agent's SSRF / domain
// policy gate (which lives on browser_navigate), so sign-in links are followed
// by clicking them on the page, which Chrome routes normally.

// CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.
function cdpModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

interface ScreencastFrameMsg {
  data: string;
  meta: { deviceWidth?: number; deviceHeight?: number };
}

export function ScreencastModal({
  setupRequestId,
  handoff = false,
  onComplete,
  onCancel,
  completing,
  cancelling
}: {
  setupRequestId: string;
  // True for a handoff-mode browser.connect (the user finishes a sensitive
  // step themselves) — drives the title/button copy. False = sign-in.
  handoff?: boolean;
  onComplete: () => void;
  onCancel: () => void;
  completing: boolean;
  cancelling: boolean;
}) {
  // Mode-keyed copy mirrors browserConnectButtonLabel (sign-in vs handoff).
  const title = handoff ? "Finish in the browser" : "Sign in to continue";
  const description = handoff
    ? "Complete the step on the live page below — the agent is watching this same browser and will continue once you're done."
    : "Sign in on the live page below — the agent is watching this same browser and will continue once you're done.";
  const completeLabel = handoff ? "I'm done" : "I've signed in";
  const imgRef = useRef<HTMLImageElement>(null);
  const captureRef = useRef<HTMLTextAreaElement>(null);
  // Natural size of the captured page (device pixels from CDP frame metadata),
  // used to rescale pointer coordinates from the displayed <img> to the page.
  const pageSize = useRef({ w: 1280, h: 800 });
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const dragStart = useRef<{ x: number; y: number; clientX: number; clientY: number; mods: number } | null>(null);
  // Move-coalescing: pointer move fires far faster than a round-trip, so cap it
  // to one in-flight POST and remember only the latest position, flushed when
  // the in-flight one returns. Keeps hover responsive without flooding the one
  // shared CDP socket with stale intermediate coordinates.
  const moveInFlight = useRef(false);
  const pendingMove = useRef<Record<string, unknown> | null>(null);

  // Open the frames SSE. EventSource hits /api/runtime/... so the BFF injects
  // the bearer; the browser never sees it. Reconnect is EventSource-native.
  useEffect(() => {
    const source = new EventSource(streamUrl(`/browser/screencast/${setupRequestId}/frames`));
    source.addEventListener("frame", (ev) => {
      try {
        const frame = JSON.parse((ev as MessageEvent).data) as ScreencastFrameMsg;
        if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${frame.data}`;
        if (frame.meta?.deviceWidth) pageSize.current.w = frame.meta.deviceWidth;
        if (frame.meta?.deviceHeight) pageSize.current.h = frame.meta.deviceHeight;
        setStatus("live");
      } catch {
        // drop a malformed frame
      }
    });
    source.onopen = () => setStatus((s) => (s === "error" ? "connecting" : s));
    source.onerror = () => setStatus((s) => (s === "live" ? s : "error"));
    return () => source.close();
  }, [setupRequestId]);

  // Fire-and-forget one input event to the gateway. We don't await/toast on
  // failure: input is high-frequency and a dropped move/click is recoverable.
  const sendInput = useCallback(
    (payload: Record<string, unknown>) => {
      void api(`/browser/screencast/${setupRequestId}/input`, {
        method: "POST",
        body: JSON.stringify(payload)
      }).catch(() => undefined);
    },
    [setupRequestId]
  );

  // Coalesced move sender: at most one move POST outstanding; the latest move
  // that arrives while one is in flight is stashed and sent when it settles.
  const sendMove = useCallback(
    (payload: Record<string, unknown>) => {
      if (moveInFlight.current) {
        pendingMove.current = payload;
        return;
      }
      moveInFlight.current = true;
      void api(`/browser/screencast/${setupRequestId}/input`, {
        method: "POST",
        body: JSON.stringify(payload)
      })
        .catch(() => undefined)
        .finally(() => {
          moveInFlight.current = false;
          const next = pendingMove.current;
          if (next) {
            pendingMove.current = null;
            sendMove(next);
          }
        });
    },
    [setupRequestId]
  );

  // Map a pointer event on the <img> to page coordinates (the rendered image
  // is scaled to fit, so rescale by the natural/displayed ratio).
  const toPage = useCallback((e: { clientX: number; clientY: number }) => {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const sx = pageSize.current.w / r.width;
    const sy = pageSize.current.h / r.height;
    return { x: Math.round((e.clientX - r.left) * sx), y: Math.round((e.clientY - r.top) * sy) };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    captureRef.current?.focus();
    const p = toPage(e);
    dragStart.current = { x: p.x, y: p.y, clientX: e.clientX, clientY: e.clientY, mods: cdpModifiers(e) };
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start) return;
    const end = toPage(e);
    const moved = Math.abs(e.clientX - start.clientX) > 4 || Math.abs(e.clientY - start.clientY) > 4;
    if (moved) {
      sendInput({ kind: "dragselect", x0: start.x, y0: start.y, x1: end.x, y1: end.y, modifiers: start.mods });
    } else {
      sendInput({ kind: "click", x: start.x, y: start.y, clickCount: e.detail || 1, modifiers: start.mods });
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toPage(e);
    sendInput({ kind: "scroll", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY, modifiers: cdpModifiers(e) });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    const mods = cdpModifiers(e);
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    sendInput({
      kind: "key",
      text: printable ? e.key : "",
      key: e.key,
      code: e.code,
      vk: e.keyCode,
      modifiers: mods
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !completing) onCancel(); }}>
      <DialogContent className="max-w-[860px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description}
            {status === "connecting" ? " Connecting…" : status === "error" ? " Reconnecting…" : null}
          </DialogDescription>
        </DialogHeader>
        <div className="relative flex justify-center">
          {/* Hidden field that holds keyboard focus so key events land here. */}
          <textarea
            ref={captureRef}
            aria-hidden
            tabIndex={-1}
            className="absolute -left-[9999px] h-px w-px opacity-0"
            onKeyDown={onKeyDown}
            onInput={(e) => { (e.target as HTMLTextAreaElement).value = ""; }}
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- live screencast frames, not a static asset */}
          <img
            ref={imgRef}
            alt="agent browser screen"
            className="max-h-[60vh] w-auto cursor-crosshair rounded border border-border bg-black"
            draggable={false}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onMouseMove={(e) => { if (dragStart.current) return; const p = toPage(e); sendMove({ kind: "move", x: p.x, y: p.y, modifiers: cdpModifiers(e) }); }}
            onWheel={onWheel}
            onDoubleClick={(e) => e.preventDefault()}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={completing} onClick={onComplete}>
            {completing ? "Finishing…" : completeLabel}
          </Button>
          <Button size="sm" variant="outline" disabled={cancelling} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
