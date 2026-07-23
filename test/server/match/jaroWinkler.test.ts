import { describe, expect, it } from "vitest";
import { jaroWinkler } from "@/server/match/jaroWinkler";

describe("jaroWinkler", () => {
  it("matches the known martha/marhta value", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 3);
  });

  it("matches the known dwayne/duane value", () => {
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
  });

  it("returns 1 for identical strings", () => {
    expect(jaroWinkler("smith", "smith")).toBe(1);
  });

  it("returns 0 for fully disjoint strings", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("stays within [0,1]", () => {
    const v = jaroWinkler("jonathan", "john");
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
