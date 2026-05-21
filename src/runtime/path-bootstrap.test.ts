import { describe, expect, it } from "bun:test";
import {
  __testing,
  mergeShellPath,
  readLoginShellPath
} from "./path-bootstrap";

describe("mergeShellPath", () => {
  it("prepends new entries from the shell PATH", () => {
    const report = mergeShellPath(
      "/usr/bin:/bin",
      "/Users/u/.nvm/versions/node/v20.0.0/bin:/usr/bin:/bin"
    );
    expect(report.added).toEqual(["/Users/u/.nvm/versions/node/v20.0.0/bin"]);
    expect(report.merged).toBe("/Users/u/.nvm/versions/node/v20.0.0/bin:/usr/bin:/bin");
  });

  it("is a no-op when the shell PATH adds nothing new", () => {
    const report = mergeShellPath("/usr/bin:/bin", "/usr/bin:/bin");
    expect(report.added).toEqual([]);
    expect(report.merged).toBe("/usr/bin:/bin");
  });

  it("preserves base PATH order and prepends new entries", () => {
    const report = mergeShellPath(
      "/bun/bin:/usr/local/bin:/usr/bin",
      "/Users/u/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin:/usr/local/bin"
    );
    expect(report.added).toEqual([
      "/Users/u/.nvm/versions/node/v20.0.0/bin",
      "/opt/homebrew/bin"
    ]);
    expect(report.merged).toBe(
      "/Users/u/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin:/bun/bin:/usr/local/bin:/usr/bin"
    );
  });

  it("ignores blank segments", () => {
    const report = mergeShellPath(
      "/usr/bin",
      "/Users/u/.nvm/bin::/opt/homebrew/bin:"
    );
    expect(report.added).toEqual(["/Users/u/.nvm/bin", "/opt/homebrew/bin"]);
  });

  it("dedupes shell segments against the base path", () => {
    const report = mergeShellPath(
      "/opt/homebrew/bin:/usr/bin",
      "/Users/u/.nvm/bin:/opt/homebrew/bin:/usr/bin"
    );
    expect(report.added).toEqual(["/Users/u/.nvm/bin"]);
    expect(report.merged).toBe("/Users/u/.nvm/bin:/opt/homebrew/bin:/usr/bin");
  });

  it("dedupes within the shell input itself", () => {
    const report = mergeShellPath(
      "/usr/bin",
      "/opt/homebrew/bin:/opt/homebrew/bin:/Users/u/.nvm/bin"
    );
    expect(report.added).toEqual(["/opt/homebrew/bin", "/Users/u/.nvm/bin"]);
  });

  it("drops non-absolute shell segments (no relative paths in launchd PATH)", () => {
    // A long-lived launchd-supervised gateway resolves relative segments
    // against its working directory; we never want a tool lookup to pick
    // up a binary from the repo's `node_modules/.bin` ahead of system
    // dirs. Filter them out at merge time.
    const report = mergeShellPath(
      "/usr/bin",
      "node_modules/.bin:.:/Users/u/.nvm/bin:relative/seg:/opt/homebrew/bin"
    );
    expect(report.added).toEqual(["/Users/u/.nvm/bin", "/opt/homebrew/bin"]);
    expect(report.merged).not.toContain("node_modules");
    expect(report.merged).not.toContain("relative");
  });
});

describe("extractBetweenSentinels", () => {
  const { extractBetweenSentinels, PATH_BEGIN, PATH_END } = __testing;

  it("returns the value between sentinels", () => {
    expect(
      extractBetweenSentinels(`${PATH_BEGIN}/usr/bin:/bin${PATH_END}`)
    ).toBe("/usr/bin:/bin");
  });

  it("ignores noise before and after the sentinels (rc-file banners)", () => {
    const noisy = `Welcome to zsh!\nnvm: loaded\n${PATH_BEGIN}/Users/u/.nvm/bin:/usr/bin${PATH_END}\nbye\n`;
    expect(extractBetweenSentinels(noisy)).toBe("/Users/u/.nvm/bin:/usr/bin");
  });

  it("returns null when no markers appear", () => {
    expect(extractBetweenSentinels("/Users/u/.nvm/bin:/usr/bin")).toBeNull();
  });

  it("returns null when only the start sentinel appears", () => {
    expect(extractBetweenSentinels(`${PATH_BEGIN}/usr/bin:/bin`)).toBeNull();
  });

  it("returns null when the value is empty after trimming", () => {
    expect(extractBetweenSentinels(`${PATH_BEGIN}   ${PATH_END}`)).toBeNull();
  });
});

describe("readLoginShellPath", () => {
  it("returns a non-empty string or null without throwing", () => {
    const result = readLoginShellPath("/bin/sh");
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("returns null when the shell binary does not exist", () => {
    const result = readLoginShellPath("/nonexistent/shell-binary-xyz");
    expect(result).toBeNull();
  });

  it("does not inherit the caller's PATH (the shell starts from CLEAN_SHELL_PATH)", () => {
    // Save current PATH, set a sentinel value the shell should NOT see.
    const prev = process.env.PATH;
    const sentinelDir = "/tmp/gini-test-should-not-leak-into-plist";
    process.env.PATH = `${sentinelDir}:${prev ?? ""}`;
    try {
      const result = readLoginShellPath("/bin/sh");
      // /bin/sh on macOS doesn't run user rc files, but it does respect
      // the env we pass. If we accidentally inherited the parent PATH,
      // the sentinel dir would appear in the output. With the clean-env
      // spawn, it must not.
      if (result !== null) {
        expect(result).not.toContain(sentinelDir);
      }
    } finally {
      if (prev === undefined) delete process.env.PATH;
      else process.env.PATH = prev;
    }
  });
});
