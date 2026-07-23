import { describe, expect, it } from "vitest";
import { addressSimilarity } from "@/server/match/addressSimilarity";
import { normalizeAddress } from "@/server/match/normalizeAddress";
import { contextSimilarity } from "@/server/match/contextSimilarity";
import { cloneDefaultConfig } from "@/shared/config";
import type { NormalizedParticipant } from "@/server/types";

const cfg = cloneDefaultConfig();
const addr = (s: string) => normalizeAddress(s, cfg);

describe("addressSimilarity", () => {
  it("scores an exact normalized address as 1", () => {
    const r = addressSimilarity(addr("123 Main Street"), addr("123 Main St"), cfg);
    expect(r.similarity).toBe(1);
    expect(r.houseNumberConflict).toBe(false);
  });

  it("scores same house number + similar street highly", () => {
    const r = addressSimilarity(addr("123 Main St"), addr("123 Maine St"), cfg);
    expect(r.similarity).toBeGreaterThan(0.9);
    expect(r.houseNumberConflict).toBe(false);
  });

  it("caps different house number + similar street and flags a conflict", () => {
    const r = addressSimilarity(addr("123 Main St"), addr("456 Main St"), cfg);
    expect(r.similarity).toBeLessThanOrEqual(0.4);
    expect(r.houseNumberConflict).toBe(true);
  });

  it("returns a neutral zero when either address is missing", () => {
    expect(addressSimilarity(null, addr("123 Main St"), cfg)).toEqual({
      similarity: 0,
      houseNumberConflict: false,
    });
  });
});

function participant(over: Partial<NormalizedParticipant>): NormalizedParticipant {
  return {
    name: {
      firstTokens: [],
      middleTokens: [],
      lastTokens: [],
      aliasTokens: [],
      coreTokens: [],
      orderedNoMiddle: "",
      reversedNoMiddle: "",
      sortedTokenSignature: "",
      initials: [],
      missingCoreComponent: true,
    },
    dob: { value: null, state: "MISSING" },
    zip: null,
    address: null,
    city: null,
    state: null,
    county: null,
    extras: {},
    ...over,
  };
}

describe("contextSimilarity", () => {
  it("gives weak support for agreeing city/state/county", () => {
    const a = participant({ city: "boston", state: "ma", county: "suffolk" });
    const b = participant({ city: "boston", state: "ma", county: "suffolk" });
    expect(contextSimilarity(a, b)).toBeGreaterThan(0);
  });

  it("caps total context contribution at 2", () => {
    const shared = {
      city: "boston",
      state: "ma",
      county: "suffolk",
      extras: { A: "x", B: "y", C: "z", D: "w" },
    };
    const a = participant(shared);
    const b = participant(shared);
    expect(contextSimilarity(a, b)).toBeLessThanOrEqual(2);
  });

  it("gives no support when nothing agrees", () => {
    const a = participant({ city: "boston" });
    const b = participant({ city: "denver" });
    expect(contextSimilarity(a, b)).toBe(0);
  });
});
