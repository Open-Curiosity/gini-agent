// APNs dispatcher. Subscribes to the chat-blocks instance-wide emitter
// and translates `approval_requested` blocks into APNs pushes for every
// iOS install registered to this runtime.
//
// Privacy: the payload carries ids + a generic title only. Never the
// message text, the approval summary, or any user-authored content. The
// notification body always says "Tap to review" — the iOS app fetches
// the full approval detail on tap via the existing
// /api/approvals/:id endpoint.
//
// Token cleanup: a 410 Unregistered from APNs means the device
// uninstalled the app or revoked notifications. We delete the row so
// subsequent fan-outs don't re-attempt the dead token. Other non-2xx
// statuses (BadCertificate, ExpiredToken, etc.) are logged but the
// token stays — they may recover or require human intervention.

import {
  listAllDevices,
  removeDevice,
  subscribeAllChatBlocks
} from "../../state";
import type { ChatBlock, Instance } from "../../types";
import { defaultClient, type APNsClient, type APNsPayload } from "./client";

export interface DispatcherDeps {
  // Override the APNs client — tests inject a stub here so they don't
  // need a real .p8 + http2 session.
  client?: APNsClient;
  // Override the device listing — tests pre-seed devices without
  // touching the SQLite layer.
  listDevices?: (instance: Instance) => ReturnType<typeof listAllDevices>;
  // Override the cleanup hook — tests assert that 410 triggers a delete
  // without actually mutating the DB.
  onTokenInvalidated?: (instance: Instance, token: string) => void;
  // Override the subscribe seam — tests drive blocks directly via the
  // returned `dispatch` function without registering against the live
  // EventEmitter.
  subscribe?: (instance: Instance, handler: (block: ChatBlock) => void) => () => void;
  // One-shot logger for unexpected failures. Defaults to console.warn.
  warn?: (message: string, detail?: unknown) => void;
}

export interface ApnsDispatcher {
  // Tear down the chat-blocks subscription. Called from the SIGTERM
  // handler so the runtime stops emitting pushes during drain.
  stop(): void;
  // Test-only entry — drives the dispatcher synchronously without
  // routing through the EventEmitter. The fire-and-forget shape mirrors
  // the production subscription handler.
  dispatch(block: ChatBlock): Promise<void>;
}

// Builds the per-call APNs payload + headers for an approval_requested
// block. Exported for tests that want to assert payload shape without
// mocking the entire dispatcher.
export function buildApprovalPayload(block: ChatBlock & { kind: "approval_requested" }): APNsPayload {
  return {
    aps: {
      alert: {
        title: "Gini needs your approval",
        body: "Tap to review"
      },
      sound: "default",
      // `thread-id` groups multiple notifications under a single
      // stack in iOS's notification center. Using sessionId means a
      // chat with several approvals collapses to one stack instead
      // of flooding the lock screen.
      "thread-id": block.sessionId,
      // `mutable-content: 1` lets the Notification Service Extension
      // (Step 4) modify the payload before display — required for
      // the inline Approve/Deny actions to be wired up later.
      "mutable-content": 1,
      // `category` ties the notification to the iOS-side
      // UNNotificationCategory that defines the Approve/Deny
      // actions. The mobile app registers the category on launch.
      category: "APPROVAL_REQUEST"
    },
    sessionId: block.sessionId,
    blockId: block.id,
    approvalId: block.approvalId,
    event: "approval_requested"
  };
}

export function createApnsDispatcher(instance: Instance, deps?: DispatcherDeps): ApnsDispatcher {
  const client = deps?.client ?? defaultClient();
  const listDevices = deps?.listDevices ?? listAllDevices;
  const onTokenInvalidated = deps?.onTokenInvalidated ?? ((inst, token) => { removeDevice(inst, token); });
  const subscribe = deps?.subscribe ?? subscribeAllChatBlocks;
  const warn = deps?.warn ?? ((message: string, detail?: unknown) => {
    if (detail !== undefined) console.warn(`[apns-dispatcher] ${message}`, detail);
    else console.warn(`[apns-dispatcher] ${message}`);
  });

  async function dispatch(block: ChatBlock): Promise<void> {
    if (block.kind !== "approval_requested") return;
    let devices;
    try {
      devices = listDevices(instance);
    } catch (error) {
      warn("listDevices failed", error instanceof Error ? error.message : String(error));
      return;
    }
    if (devices.length === 0) return;

    const payload = buildApprovalPayload(block);
    // Fan out in parallel — APNs HTTP/2 supports many concurrent
    // streams over one session, and the client itself reuses the
    // session, so this is effectively just a Promise.all over a few
    // HTTP/2 streams.
    await Promise.all(devices.map(async (device) => {
      try {
        const result = await client.sendPush(device.token, payload, {
          pushType: "alert",
          priority: 10,
          // Per-device bundleId — TestFlight (.dev) and prod (.mobile)
          // installs can coexist behind the same APNs creds, but each
          // device's stored bundle id is the authoritative topic.
          topic: device.bundleId,
          // Coalesce duplicate approval pushes for the same approval id.
          collapseId: block.approvalId.slice(0, 64)
        });
        if (!result.ok) {
          if (result.status === 410 && result.reason === "Unregistered") {
            try {
              onTokenInvalidated(instance, device.token);
            } catch (error) {
              warn("token cleanup failed", error instanceof Error ? error.message : String(error));
            }
            return;
          }
          // Other failures (apns_not_configured, BadDeviceToken,
          // ExpiredProviderToken, etc.) — log and move on. The token
          // stays so a follow-up push has a chance to succeed after
          // the operator fixes the underlying issue.
          warn(`sendPush failed status=${result.status} reason=${result.reason} token=${device.token.slice(0, 8)}…`);
        }
      } catch (error) {
        warn("sendPush threw", error instanceof Error ? error.message : String(error));
      }
    }));
  }

  const unsubscribe = subscribe(instance, (block) => {
    // The subscribe path is a fire-and-forget event handler — we
    // can't await dispatch here, but we want to surface unhandled
    // rejections rather than swallow them silently.
    dispatch(block).catch((error) => {
      warn("dispatch rejected", error instanceof Error ? error.message : String(error));
    });
  });

  return {
    stop(): void {
      unsubscribe();
    },
    dispatch
  };
}
