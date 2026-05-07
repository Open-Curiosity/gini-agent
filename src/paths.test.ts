import { describe, expect, test } from "bun:test";
import { defaultRuntimePort, defaultWebPort } from "./paths";

describe("default port helpers", () => {
  test("dev lane stays pinned to 7337/3000 (no muscle-memory regression)", () => {
    expect(defaultRuntimePort("dev")).toBe(7337);
    expect(defaultWebPort("dev")).toBe(3000);
  });

  test("same lane name always picks the same default port (deterministic hash)", () => {
    expect(defaultRuntimePort("feature-x")).toBe(defaultRuntimePort("feature-x"));
    expect(defaultWebPort("feature-x")).toBe(defaultWebPort("feature-x"));
  });

  test("different lanes pick different defaults across a representative sample", () => {
    // 50 random-ish lanes; runtime ports should land in [7337, 7437) and web
    // ports in [3000, 3100). We expect a healthy spread (>=20 distinct values
    // in a 100-port window from 50 samples). If FNV ever degenerates this
    // catches it.
    const lanes = Array.from({ length: 50 }, (_, index) => `lane-${index}`);
    const runtimePorts = new Set(lanes.map((lane) => defaultRuntimePort(lane)));
    const webPorts = new Set(lanes.map((lane) => defaultWebPort(lane)));
    expect(runtimePorts.size).toBeGreaterThanOrEqual(20);
    expect(webPorts.size).toBeGreaterThanOrEqual(20);
    for (const lane of lanes) {
      const rp = defaultRuntimePort(lane);
      const wp = defaultWebPort(lane);
      expect(rp).toBeGreaterThanOrEqual(7337);
      expect(rp).toBeLessThan(7337 + 100);
      expect(wp).toBeGreaterThanOrEqual(3000);
      expect(wp).toBeLessThan(3000 + 100);
    }
  });

  test("runtime and web ports are independent (different hash namespaces)", () => {
    // Same offset for runtime and web would mean they collide as a pair —
    // not technically wrong, but two namespaces means lane A and lane B
    // can't ever both share the same runtime AND the same web.
    const lanes = ["alpha", "beta", "gamma", "delta", "epsilon"];
    let differOnAtLeastOne = 0;
    for (const lane of lanes) {
      const rp = defaultRuntimePort(lane) - 7337;
      const wp = defaultWebPort(lane) - 3000;
      if (rp !== wp) differOnAtLeastOne += 1;
    }
    expect(differOnAtLeastOne).toBeGreaterThan(0);
  });
});
