import { describe, expect, it } from "vitest";
import { softToken } from "@/server/match/softToken";

describe("softToken", () => {
  it("scores identical token sets as a perfect F1", () => {
    const r = softToken(["john", "smith"], ["john", "smith"]);
    expect(r.f1).toBe(1);
  });

  it("accepts a fuzzy match at or above 0.88", () => {
    const r = softToken(["jon"], ["john"]);
    expect(r.f1).toBeGreaterThan(0.88);
    expect(r.matches).toContainEqual(["jon", "john"]);
  });

  it("rejects a fuzzy match below 0.88", () => {
    const r = softToken(["cat"], ["dog"]);
    expect(r.matches).toHaveLength(0);
    expect(r.f1).toBe(0);
  });

  it("never matches short (<=2 char) tokens fuzzily", () => {
    const r = softToken(["jo"], ["ja"]);
    expect(r.matches).toHaveLength(0);
  });

  it("uses each token at most once, greedily preferring the best match", () => {
    const r = softToken(["john", "jon"], ["john"]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toEqual(["john", "john"]);
  });

  it("computes asymmetric precision and recall", () => {
    const r = softToken(["john", "jon"], ["john"]);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(0.5);
  });
});
