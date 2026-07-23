import { describe, expect, it } from "vitest";
import { normalizeAddress } from "@/server/match/normalizeAddress";
import { cloneDefaultConfig } from "@/shared/config";

const cfg = cloneDefaultConfig();

describe("normalizeAddress", () => {
  it("splits house number, street tokens, and unit", () => {
    const a = normalizeAddress("123 North Main Street Apt 4", cfg);
    expect(a).not.toBeNull();
    expect(a!.houseNumber).toBe("123");
    expect(a!.streetTokens).toContain("n");
    expect(a!.streetTokens).toContain("main");
    expect(a!.streetTokens).toContain("st");
    expect(a!.unit).toBe("4");
  });

  it("does not carry the unit marker or value into street tokens", () => {
    const a = normalizeAddress("123 North Main Street Apt 4", cfg);
    expect(a!.streetTokens).not.toContain("unit");
    expect(a!.streetTokens).not.toContain("4");
  });

  it("maps the # sign to a unit marker", () => {
    const a = normalizeAddress("500 Oak Ave #12B", cfg);
    expect(a!.houseNumber).toBe("500");
    expect(a!.unit).toBe("12b");
    expect(a!.streetTokens).toEqual(["oak", "ave"]);
  });

  it("handles a street with no house number and no unit", () => {
    const a = normalizeAddress("Main Street", cfg);
    expect(a!.houseNumber).toBeNull();
    expect(a!.unit).toBeNull();
    expect(a!.streetTokens).toEqual(["main", "st"]);
  });

  it("returns null for a blank or missing-label address", () => {
    expect(normalizeAddress("", cfg)).toBeNull();
    expect(normalizeAddress("unknown", cfg)).toBeNull();
    expect(normalizeAddress(null, cfg)).toBeNull();
  });
});
