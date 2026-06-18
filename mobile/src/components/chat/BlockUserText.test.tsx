import { beforeEach, describe, expect, mock, test } from "bun:test";
// Importing the shared setup installs the (process-global) module mocks before
// the component under test is imported. bun's mock.module is process-global, so
// this file MUST reuse the same react-native/react/theme superset as the other
// chat component tests (BlockAssistantText.test, linkContextMenu.test) — a
// divergent narrow mock here clobbers theirs and breaks them when the suite
// runs in one process (bun's --parallel does not isolate files into processes).
import { Image, Pressable, Text } from "./chatMockSetup";

// Modules BlockUserText needs that the shared setup doesn't cover. None of the
// sibling chat components import these, so registering them here can't collide.
const player = {
  play: mock(() => {
    calls.push("play");
  }),
  pause: mock(() => {
    calls.push("pause");
  }),
  // seekTo is async (returns a Promise) exactly like the native module, so a
  // test can assert play() is chained AFTER the seek settles, not fired in the
  // same tick — the ordering that, when violated, starts the AVQueuePlayer at
  // the clip end and is silently stopped (StopAtEnd).
  seekTo: mock((_seconds: number) => {
    calls.push("seekTo");
    return new Promise<void>((resolve) => {
      seekResolves.push(() => {
        calls.push("seekResolved");
        resolve();
      });
    });
  })
};
const calls: string[] = [];
let seekResolves: Array<() => void> = [];
let playerStatus: {
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
};

mock.module("expo-audio", () => ({
  useAudioPlayer: () => player,
  useAudioPlayerStatus: () => playerStatus
}));

const openPreview = mock((_: { uri: string; headers: Record<string, string> }) => {});
mock.module("@/src/api", () => ({
  uploadUrl: (id: string) => `http://gw.local/api/uploads/${id}`,
  authHeader: () => ({ Authorization: "Bearer t" })
}));
mock.module("@/src/components/ImagePreview", () => ({
  useImagePreview: () => ({ open: openPreview })
}));

const { VoiceBubble, BlockUserText } = await import("@/src/components/chat/BlockUserText");

type El =
  | { type: unknown; props: { children?: unknown; [k: string]: unknown } }
  | null
  | undefined
  | string
  | number
  | boolean;

function flatten(node: El, out: Array<Exclude<El, null | undefined | string | number | boolean>> = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  const kids = (node as { props?: { children?: unknown } }).props?.children;
  const list = Array.isArray(kids) ? kids : [kids];
  for (const k of list) flatten(k as El, out);
  return out;
}

// Render the voice bubble and return the play/pause Pressable's onPress (the toggle).
function getToggle() {
  const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
    audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 4000 }
  });
  const pressable = flatten(tree).find(
    (n) => n.type === Pressable && typeof n.props.onPress === "function"
  );
  if (!pressable) throw new Error("play/pause Pressable not found");
  return pressable.props.onPress as () => void;
}

function renderBlock(block: Record<string, unknown>) {
  return (BlockUserText as unknown as (p: { block: unknown }) => El)({ block });
}

function textLabels(tree: El): unknown[] {
  return flatten(tree)
    .filter((n) => n.type === Text)
    .map((n) => n.props.children);
}

beforeEach(() => {
  calls.length = 0;
  seekResolves = [];
  player.play.mockClear();
  player.pause.mockClear();
  player.seekTo.mockClear();
  openPreview.mockClear();
  playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
});

describe("VoiceBubble playback toggle", () => {
  test("a fresh (unloaded) clip plays without a needless seek", () => {
    // duration still 0 (not decoded yet): a pre-load tap must NOT be treated as
    // 'at the end' — it should just play from the start.
    playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
    getToggle()();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(calls).toEqual(["play"]);
  });

  test("a loaded, mid-clip paused position resumes without seeking", () => {
    playerStatus = { playing: false, currentTime: 2, duration: 9, didJustFinish: false };
    getToggle()();
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["play"]);
  });

  test("tapping while playing pauses (and never starts a second stream)", () => {
    playerStatus = { playing: true, currentTime: 3, duration: 9, didJustFinish: false };
    getToggle()();
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.play).not.toHaveBeenCalled();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  test("replaying a finished clip rewinds to 0 BEFORE playing (seek then play)", async () => {
    // didJustFinish marks the clip as ended. The fix: await the seek, then play
    // — so the AVQueuePlayer restarts at 0 instead of at the end (which the
    // native player silently stops as StopAtEnd).
    playerStatus = { playing: false, currentTime: 9, duration: 9, didJustFinish: true };
    getToggle()();
    // play() must NOT have fired yet — it's chained behind the pending seek.
    expect(calls).toEqual(["seekTo"]);
    expect(player.play).not.toHaveBeenCalled();
    // Settle the seek; play runs only after the rewind resolves.
    seekResolves[0]();
    await Promise.resolve();
    expect(calls).toEqual(["seekTo", "seekResolved", "play"]);
    expect(player.seekTo).toHaveBeenCalledWith(0);
  });

  test("a clip parked at the end (currentTime >= duration) also rewinds before play", async () => {
    playerStatus = { playing: false, currentTime: 9, duration: 9, didJustFinish: false };
    getToggle()();
    expect(calls).toEqual(["seekTo"]);
    seekResolves[0]();
    await Promise.resolve();
    expect(calls).toEqual(["seekTo", "seekResolved", "play"]);
  });
});

describe("VoiceBubble rendering", () => {
  test("shows the decoded duration once known, overriding the client estimate", () => {
    playerStatus = { playing: false, currentTime: 0, duration: 9, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 1000 }
    });
    // The duration label renders 0:09 (decoded) rather than 0:01 (the estimate).
    expect(textLabels(tree)).toContain("0:09");
  });

  test("falls back to the client duration before the clip decodes", () => {
    playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 4000 }
    });
    expect(textLabels(tree)).toContain("0:04");
  });
});

describe("BlockUserText attachments", () => {
  test("renders image attachments as a tappable grid that opens the previewer", () => {
    const tree = renderBlock({
      text: "",
      images: [{ id: "img1", mimeType: "image/png", size: 2048 }]
    });
    const nodes = flatten(tree);
    const img = nodes.find((n) => n.type === Image);
    expect(img).toBeTruthy();
    expect((img!.props.source as { uri: string }).uri).toBe("http://gw.local/api/uploads/img1");
    const opener = nodes.find(
      (n) => n.type === Pressable && (n.props as { accessibilityLabel?: string }).accessibilityLabel === "Open image"
    );
    expect(opener).toBeTruthy();
    (opener!.props.onPress as () => void)();
    expect(openPreview).toHaveBeenCalledWith({
      uri: "http://gw.local/api/uploads/img1",
      headers: { Authorization: "Bearer t" }
    });
  });

  test("renders a non-image attachment as a file chip with type label and size", () => {
    const labels = textLabels(
      renderBlock({ text: "", images: [{ id: "f1", mimeType: "application/pdf", size: 2_500_000 }] })
    );
    // fileTypeLabel uppercases the mime subtype; formatBytes renders MB at this size.
    expect(labels).toContain("PDF");
    expect(labels).toContain("2.4 MB");
  });

  test("formats small and mid-size files as B and KB", () => {
    const small = textLabels(renderBlock({ text: "", images: [{ id: "s", mimeType: "text/csv", size: 512 }] }));
    expect(small).toContain("512 B");
    expect(small).toContain("CSV");

    const kb = textLabels(renderBlock({ text: "", images: [{ id: "k", mimeType: "text/plain", size: 4096 }] }));
    expect(kb).toContain("4 KB");
  });

  test("a mime with no subtype falls back to the whole type for the label", () => {
    const labels = textLabels(renderBlock({ text: "", images: [{ id: "x", mimeType: "weirdtype", size: 10 }] }));
    expect(labels).toContain("WEIRDTYPE");
  });

  test("renders the text bubble (via SelectableBlockText) when the message carries text", () => {
    const tree = renderBlock({ text: "hello there" });
    // SelectableBlockText is the REAL component (siblings rely on it too); on the
    // mocked iOS platform it renders a TextInput whose children are the text.
    const labels = flatten(tree)
      .flatMap((n) => {
        const kids = n.props?.children;
        return Array.isArray(kids) ? kids : [kids];
      })
      .filter((k) => typeof k === "string");
    expect(labels).toContain("hello there");
  });

  test("renders a VoiceBubble element when the message carries audio", () => {
    const tree = renderBlock({ text: "", audio: { id: "a1", mimeType: "audio/wav", size: 100, durationMs: 2000 } });
    // BlockUserText embeds <VoiceBubble audio=.../> as a child element; it isn't
    // invoked here, so assert the element node is present with the audio prop
    // forwarded (the toggle/render behavior is covered by the VoiceBubble suite).
    const voice = flatten(tree).find((n) => n.type === VoiceBubble);
    expect(voice).toBeTruthy();
    expect((voice!.props as { audio: { id: string } }).audio.id).toBe("a1");
  });

  test("an image-only message omits the empty text bubble", () => {
    const tree = renderBlock({ text: "", images: [{ id: "img1", mimeType: "image/png", size: 10 }] });
    const voice = flatten(tree).find((n) => n.type === VoiceBubble);
    expect(voice).toBeUndefined();
    // No text → the message carries only the image grid (no SelectableBlockText text).
    const strings = flatten(tree)
      .flatMap((n) => {
        const kids = n.props?.children;
        return Array.isArray(kids) ? kids : [kids];
      })
      .filter((k) => typeof k === "string");
    expect(strings.length).toBe(0);
  });
});
