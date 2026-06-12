"use client";

import { useLayoutEffect, useRef } from "react";

// Sentinel for "no snap has happened for this mounted view yet". A plain
// boolean can't distinguish "first content" from "switched to a different
// conversation in a reused instance", so the latch stores the last-snapped
// `key` instead and compares identity.
const NOT_SNAPPED = Symbol("not-snapped");

/**
 * Keeps a scroll container pinned to its newest content via an end-sentinel
 * `<div ref>` placed after the last item.
 *
 * The point of the hook is the *first* scroll: when a transcript opens (agent
 * switch, channel open, thread open) its viewport mounts at scrollTop 0, so a
 * `behavior: "smooth"` scroll there makes the user watch the list animate
 * up-from-top down to the bottom. Instead, the first snap for a given view runs
 * with `behavior: "auto"` inside a layout effect — it lands at the bottom
 * before the browser paints, so the transcript simply opens already scrolled
 * down.
 *
 * `itemCount` is the trigger: the effect re-evaluates only when it changes, so
 * pass the rendered item/block count. A later count change within the same view
 * follows the bottom with `behavior: "smooth"`. This fires per new block (a new
 * message, or a phase/tool block appearing mid-turn), not per streamed token —
 * assistant text accretes in place under a stable block id without changing the
 * count, so intra-message streaming does not re-scroll.
 *
 * "First for a given view" is tracked by `key`: pass a stable conversation id
 * so a reused instance (the cross-agent thread inbox opens different threads in
 * one panel) re-arms the instant snap when the id changes. Pass `enabled:
 * false` while the view is hidden or empty (e.g. a non-active chat tab) so
 * background growth doesn't consume the instant-snap latch — it re-arms on the
 * next enable so returning to the view snaps instantly too.
 */
export function useStickToBottom(
  itemCount: number,
  opts: { key?: unknown; enabled?: boolean } = {}
) {
  const { key, enabled = true } = opts;
  const endRef = useRef<HTMLDivElement | null>(null);
  const snappedKeyRef = useRef<unknown>(NOT_SNAPPED);

  useLayoutEffect(() => {
    if (!enabled) {
      // Re-arm: the next time this view is shown, snap instantly rather than
      // animating from the top.
      snappedKeyRef.current = NOT_SNAPPED;
      return;
    }
    const firstForKey = snappedKeyRef.current !== key;
    endRef.current?.scrollIntoView({
      behavior: firstForKey ? "auto" : "smooth",
      block: "end"
    });
    snappedKeyRef.current = key;
  }, [itemCount, key, enabled]);

  return endRef;
}
