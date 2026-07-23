import { describe, expect, it } from "vitest";
import { nameSimilarity } from "@/server/match/nameSimilarity";
import { normalizeName } from "@/server/match/normalizeName";
import { cloneDefaultConfig } from "@/shared/config";

const cfg = cloneDefaultConfig();
const name = (f: string, m: string, l: string) => normalizeName(f, m, l, cfg);

describe("nameSimilarity", () => {
  it("scores identical names as 1 via the DIRECT method", () => {
    const r = nameSimilarity(name("John", "Q", "Public"), name("John", "Q", "Public"), cfg);
    expect(r.similarity).toBe(1);
    expect(r.method).toBe("DIRECT");
    expect(r.exactDirect).toBe(true);
  });

  it("flags an exact first/last reversal", () => {
    const r = nameSimilarity(name("John", "", "Public"), name("Public", "", "John"), cfg);
    expect(r.exactReversal).toBe(true);
    expect(r.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it("scores a one-character typo high but below 1", () => {
    const r = nameSimilarity(name("Jon", "", "Smith"), name("John", "", "Smith"), cfg);
    expect(r.similarity).toBeGreaterThan(0.9);
    expect(r.similarity).toBeLessThan(1);
  });

  it("caps similarity at 0.88 when a core component is missing", () => {
    const r = nameSimilarity(name("John", "", ""), name("John", "", "Smith"), cfg);
    expect(r.similarity).toBeLessThanOrEqual(0.88);
  });

  it("does not penalize a missing middle name", () => {
    const withMiddle = nameSimilarity(name("Amy", "James", "Lee"), name("Amy", "", "Lee"), cfg);
    expect(withMiddle.similarity).toBeGreaterThanOrEqual(0.99);
    expect(withMiddle.middleConflict).toBe(false);
  });

  it("flags conflicting middle names without rejecting the pair", () => {
    const r = nameSimilarity(name("Amy", "James", "Lee"), name("Amy", "Robert", "Lee"), cfg);
    expect(r.middleConflict).toBe(true);
    expect(r.similarity).toBeGreaterThan(0.8);
  });

  it("treats a middle initial as compatible with the full middle name", () => {
    const r = nameSimilarity(name("Amy", "J", "Lee"), name("Amy", "James", "Lee"), cfg);
    expect(r.middleConflict).toBe(false);
  });
});
