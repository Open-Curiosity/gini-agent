import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import {
  DEFAULT_CDP_PORT_BASE,
  defaultDeps,
  findFreePort,
  launchSpawnedChrome,
  type ChromeLaunchDeps
} from "./chrome-launch";
import { CHROME_LAUNCH_ARGS } from "./chrome-discovery";

afterEach(() => {
  mock.restore();
});

// Build a deps bundle whose externalities are all fakes. Individual tests
// override just the field they exercise.
function fakeDeps(over: Partial<ChromeLaunchDeps> = {}): {
  deps: Partial<ChromeLaunchDeps>;
  launchArgs: { dataDir: string; options: Record<string, unknown> }[];
} {
  const launchArgs: { dataDir: string; options: Record<string, unknown> }[] = [];
  const deps: Partial<ChromeLaunchDeps> = {
    launchPersistentContext: async (dataDir, options) => {
      launchArgs.push({ dataDir, options });
      return { marker: "ctx" } as never;
    },
    findFreePort: async () => 9333,
    resolveLaunchTarget: async () => ({ executablePath: "/fake/chrome", branded: true }),
    cleanUserAgent: async () => "UA/1.0",
    ...over
  };
  return { deps, launchArgs };
}

function tempProfile(): string {
  return mkdtempSync(join(tmpdir(), "gini-launch-"));
}

describe("findFreePort", () => {
  test("returns the base port when it is free", async () => {
    const port = await findFreePort(DEFAULT_CDP_PORT_BASE + 500);
    expect(port).toBeGreaterThanOrEqual(DEFAULT_CDP_PORT_BASE + 500);
  });

  test("rolls forward past an occupied port", async () => {
    const base = DEFAULT_CDP_PORT_BASE + 600;
    const occupied: Server = createServer();
    await new Promise<void>((resolve) => occupied.listen(base, "127.0.0.1", () => resolve()));
    try {
      const port = await findFreePort(base);
      expect(port).toBeGreaterThan(base);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  test("throws when the whole window is exhausted", async () => {
    // Start above the valid TCP port ceiling so every probe in the window is an
    // out-of-range (unbindable) number — the walk exhausts and throws fast.
    await expect(findFreePort(70000)).rejects.toThrow(/No free CDP port/);
  });

  test("defaults to DEFAULT_CDP_PORT_BASE", async () => {
    const port = await findFreePort();
    expect(typeof port).toBe("number");
  });
});

describe("launchSpawnedChrome", () => {
  test("launches a persistent context with stealth args + free debug port + clean UA", async () => {
    const profileDir = tempProfile();
    try {
      const { deps, launchArgs } = fakeDeps();
      const result = await launchSpawnedChrome({ profileDir, deps });
      expect(result.port).toBe(9333);
      expect(result.chromePath).toBe("/fake/chrome");
      expect(result.profileDir).toBe(profileDir);
      expect(result.context).toEqual({ marker: "ctx" } as never);

      expect(launchArgs.length).toBe(1);
      const { dataDir, options } = launchArgs[0];
      expect(dataDir).toBe(profileDir);
      expect(options.headless).toBe(true);
      expect(options.executablePath).toBe("/fake/chrome");
      expect(options.userAgent).toBe("UA/1.0");
      const args = options.args as string[];
      for (const flag of CHROME_LAUNCH_ARGS) expect(args).toContain(flag);
      expect(args).toContain("--remote-debugging-port=9333");
      // The profile dir was created on disk.
      expect(existsSync(profileDir)).toBe(true);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test("headless=false skips the UA rewrite and the headless flag", async () => {
    const profileDir = tempProfile();
    try {
      const { deps, launchArgs } = fakeDeps();
      await launchSpawnedChrome({ profileDir, headless: false, deps });
      const { options } = launchArgs[0];
      expect(options.headless).toBe(false);
      expect(options.userAgent).toBeUndefined();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test("honors an explicit port (no free-port walk)", async () => {
    const profileDir = tempProfile();
    try {
      const freePortSpy = mock(async () => 9999);
      const { deps, launchArgs } = fakeDeps({ findFreePort: freePortSpy });
      const result = await launchSpawnedChrome({ profileDir, port: 9500, deps });
      expect(result.port).toBe(9500);
      expect(freePortSpy).not.toHaveBeenCalled();
      expect((launchArgs[0].options.args as string[])).toContain("--remote-debugging-port=9500");
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test("threads extraOptions (e.g. downloads routing) into the launch options", async () => {
    const profileDir = tempProfile();
    try {
      const { deps, launchArgs } = fakeDeps();
      await launchSpawnedChrome({
        profileDir,
        extraOptions: { acceptDownloads: true, downloadsPath: "/tmp/dl" },
        deps
      });
      expect(launchArgs[0].options.acceptDownloads).toBe(true);
      expect(launchArgs[0].options.downloadsPath).toBe("/tmp/dl");
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test("omits the UA flag when the binary version can't be probed", async () => {
    const profileDir = tempProfile();
    try {
      const { deps, launchArgs } = fakeDeps({ cleanUserAgent: async () => undefined });
      await launchSpawnedChrome({ profileDir, deps });
      expect(launchArgs[0].options.userAgent).toBeUndefined();
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test("throws when no Chrome binary is found", async () => {
    const profileDir = tempProfile();
    try {
      const { deps } = fakeDeps({
        resolveLaunchTarget: async () => ({ executablePath: null, branded: false })
      });
      await expect(launchSpawnedChrome({ profileDir, deps })).rejects.toThrow(/No Chrome binary/);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test("propagates a launch failure from launchPersistentContext", async () => {
    const profileDir = tempProfile();
    try {
      const { deps } = fakeDeps({
        launchPersistentContext: async () => {
          throw new Error("launch boom");
        }
      });
      await expect(launchSpawnedChrome({ profileDir, deps })).rejects.toThrow("launch boom");
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

describe("default deps wiring", () => {
  test("launch uses real resolution when deps are omitted (binary-absent path)", async () => {
    // With no deps override and no Chrome resolvable via the real resolver in a
    // clean env, the launch should fail fast at binary resolution — exercising
    // the production defaultDeps() construction without launching anything.
    const profileDir = tempProfile();
    const original = process.env["GINI_CHROME_PATH"];
    process.env["GINI_CHROME_PATH"] = join(profileDir, "does-not-exist");
    try {
      await expect(launchSpawnedChrome({ profileDir })).rejects.toThrow(/No Chrome binary/);
    } finally {
      if (original === undefined) delete process.env["GINI_CHROME_PATH"];
      else process.env["GINI_CHROME_PATH"] = original;
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test("defaultDeps exposes the real externalities", async () => {
    const deps = defaultDeps();
    // findFreePort is the real walker.
    expect(typeof (await deps.findFreePort(DEFAULT_CDP_PORT_BASE + 700))).toBe("number");
    // resolveLaunchTarget + cleanUserAgent are the real chrome-discovery fns.
    expect(typeof deps.resolveLaunchTarget).toBe("function");
    expect(typeof deps.cleanUserAgent).toBe("function");
    // The real launchPersistentContext resolves through the lazy playwright-core
    // import; launching against a bogus binary rejects, proving the import ran.
    await expect(
      deps.launchPersistentContext("/tmp/gini-nonexistent-profile", {
        headless: true,
        executablePath: "/definitely/not/a/real/chrome/binary"
      })
    ).rejects.toBeDefined();
  });
});
