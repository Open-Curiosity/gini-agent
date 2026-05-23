import { describe, expect, test } from "bun:test";
import {
  buildUpdateScript,
  isICloudAccountAvailable,
  plainTextToNotesHtml,
  quoteAppleScript,
  updateAppleNote,
  type RunOsascript
} from "./apple-notes";

describe("apple-notes scripting helpers", () => {
  test("quoteAppleScript wraps the value with escaped quotes and backslashes", () => {
    expect(quoteAppleScript("simple")).toBe('"simple"');
    expect(quoteAppleScript('with "quotes"')).toBe('"with \\"quotes\\""');
    expect(quoteAppleScript("path\\with\\back")).toBe('"path\\\\with\\\\back"');
  });

  test("plainTextToNotesHtml escapes HTML and replaces newlines with <br>", () => {
    const html = plainTextToNotesHtml("hello\nworld <script>", "title-here");
    expect(html).toContain("<h1>title-here</h1>");
    expect(html).toContain("hello<br>world &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("buildUpdateScript names the configured folder, note, and account", () => {
    const script = buildUpdateScript({
      account: "iCloud",
      folder: "gini",
      noteName: "tunnel-url",
      body: "hello"
    });
    expect(script).toContain('tell account "iCloud"');
    expect(script).toContain('exists folder "gini"');
    expect(script).toContain('make new folder with properties {name:"gini"}');
    expect(script).toContain('notes whose name is "tunnel-url"');
    expect(script).toContain('make new note with properties {name:"tunnel-url"');
    expect(script).toContain('set body of item 1 of existingNotes');
  });

  test("buildUpdateScript escapes quotes inside the body without breaking the literal", () => {
    const script = buildUpdateScript({
      folder: "g",
      noteName: "n",
      body: 'has "quote"'
    });
    expect(script).toContain('has &quot;quote&quot;');
    expect(script).not.toContain('has "quote"');
  });
});

describe("apple-notes runtime gating", () => {
  test("isICloudAccountAvailable returns unavailable on non-macOS without invoking osascript", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      let invoked = false;
      const stub: RunOsascript = async () => {
        invoked = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const result = await isICloudAccountAvailable({ run: stub });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("macOS");
      expect(invoked).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("isICloudAccountAvailable surfaces the osascript yes/no answer with reason on macOS", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const yes: RunOsascript = async () => ({ stdout: "yes\n", stderr: "", exitCode: 0 });
      const no: RunOsascript = async () => ({ stdout: "no\n", stderr: "", exitCode: 0 });
      const broken: RunOsascript = async () => ({ stdout: "", stderr: "TCC denied: not authorized", exitCode: 1 });
      const yesResult = await isICloudAccountAvailable({ run: yes });
      expect(yesResult.available).toBe(true);
      expect(yesResult.reason).toBeNull();
      const noResult = await isICloudAccountAvailable({ run: no });
      expect(noResult.available).toBe(false);
      expect(noResult.reason).toContain("not visible");
      const brokenResult = await isICloudAccountAvailable({ run: broken });
      expect(brokenResult.available).toBe(false);
      // The actual osascript stderr text reaches the caller — operators
      // staring at a stuck mirror need the real reason, not a generic
      // "iCloud not found" fallback.
      expect(brokenResult.reason).toBe("TCC denied: not authorized");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("updateAppleNote refuses to run on non-macOS", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await expect(
        updateAppleNote({ folder: "g", noteName: "n", body: "x" })
      ).rejects.toThrow(/only runs on macOS/);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("updateAppleNote forwards stderr from osascript on failure", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const failure: RunOsascript = async () => ({
        stdout: "",
        stderr: "execution error: not allowed",
        exitCode: 2
      });
      await expect(
        updateAppleNote({ folder: "g", noteName: "n", body: "x" }, failure)
      ).rejects.toThrow(/execution error: not allowed/);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("updateAppleNote resolves silently when osascript exits 0", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const ok: RunOsascript = async () => ({ stdout: "", stderr: "", exitCode: 0 });
      await expect(
        updateAppleNote({ folder: "g", noteName: "n", body: "x" }, ok)
      ).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
