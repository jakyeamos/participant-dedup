import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, HEADER_ALIASES, cloneDefaultConfig } from "@/shared/config";

describe("DEFAULT_CONFIG", () => {
  it("carries the locked threshold/weight/penalty values", () => {
    expect(DEFAULT_CONFIG.thresholds.high).toBe(80);
    expect(DEFAULT_CONFIG.weights.name).toBe(60);
    expect(DEFAULT_CONFIG.penalties.dobConflict).toBe(35);
    expect(DEFAULT_CONFIG.blocking.maxTotalCandidates).toBe(200000);
    expect(DEFAULT_CONFIG.execution.maxAtomicApplyRequests).toBe(900);
  });

  it("exposes header aliases including surname", () => {
    expect(HEADER_ALIASES.last).toContain("surname");
    expect(HEADER_ALIASES.zip).toContain("postal code");
  });

  it("cloneDefaultConfig returns an independent mutable copy", () => {
    const cfg = cloneDefaultConfig();
    cfg.thresholds.high = 99;
    expect(cfg.thresholds.high).toBe(99);
    expect(DEFAULT_CONFIG.thresholds.high).toBe(80);
  });
});
