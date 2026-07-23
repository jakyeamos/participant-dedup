import { describe, expect, it } from "vitest";
import { generateCandidates } from "@/server/match/candidateGenerator";
import { normalizeName } from "@/server/match/normalizeName";
import { normalizeDob } from "@/server/match/normalizeDob";
import { normalizeZip } from "@/server/match/normalizeZip";
import { normalizeAddress } from "@/server/match/normalizeAddress";
import {
  normalizeCity,
  normalizeCounty,
  normalizeState,
} from "@/server/match/normalizeLocation";
import { cloneDefaultConfig } from "@/shared/config";
import type { RecordSnapshot } from "@/server/types";

const cfg = cloneDefaultConfig();
const tz = "America/New_York";

interface Fields {
  first?: string;
  middle?: string;
  last?: string;
  dob?: string;
  address?: string;
  zip?: string;
}

function rec(id: string, f: Fields): RecordSnapshot {
  return {
    batchId: "b",
    dedupId: id,
    sourceRowAtScan: 0,
    rowFingerprint: "",
    relevantHash: "",
    rawValues: [],
    displayValues: [],
    formulas: [],
    valuesByHeader: {},
    displayByHeader: {},
    normalized: {
      name: normalizeName(f.first ?? "", f.middle ?? "", f.last ?? "", cfg),
      dob: normalizeDob(f.dob ?? null, tz, cfg),
      zip: normalizeZip(f.zip ?? ""),
      address: normalizeAddress(f.address ?? null, cfg),
      city: normalizeCity(null, cfg),
      state: normalizeState(null, cfg),
      county: normalizeCounty(null, cfg),
      extras: {},
    },
  };
}

function hasPair(
  result: { pairs: Array<{ leftId: string; rightId: string }> },
  x: string,
  y: string,
): boolean {
  return result.pairs.some(
    (p) =>
      (p.leftId === x && p.rightId === y) || (p.leftId === y && p.rightId === x),
  );
}

describe("generateCandidates", () => {
  it("emits a candidate pair for two exact-name records", () => {
    const records = [
      rec("1", { first: "John", last: "Public" }),
      rec("2", { first: "John", last: "Public" }),
    ];
    const result = generateCandidates(records, cfg);
    expect(hasPair(result, "1", "2")).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("does not emit household-only pairs (shared ZIP/address, disjoint names)", () => {
    const records = [
      rec("1", { first: "Aaron", last: "Smith", zip: "02118", address: "1 Main St" }),
      rec("2", { first: "Belle", last: "Jones", zip: "02118", address: "1 Main St" }),
    ];
    const result = generateCandidates(records, cfg);
    expect(hasPair(result, "1", "2")).toBe(false);
  });

  it("links jon/john via the trigram block when no exact block applies", () => {
    const records = [
      rec("1", { first: "Jon", last: "Aaaa" }),
      rec("2", { first: "John", last: "Bbbb" }),
    ];
    const result = generateCandidates(records, cfg);
    expect(hasPair(result, "1", "2")).toBe(true);
  });

  it("sets truncated when the global candidate cap is exceeded", () => {
    const tiny = cloneDefaultConfig();
    tiny.blocking.maxTotalCandidates = 2;
    const records = [
      rec("1", { first: "John", last: "Public" }),
      rec("2", { first: "John", last: "Public" }),
      rec("3", { first: "John", last: "Public" }),
    ];
    const result = generateCandidates(records, tiny);
    expect(result.truncated).toBe(true);
    expect(result.pairs.length).toBeLessThanOrEqual(2);
  });

  it("deduplicates and orders pair keys deterministically", () => {
    const records = [
      rec("2", { first: "John", last: "Public", dob: "1/1/1990" }),
      rec("1", { first: "John", last: "Public", dob: "1/1/1990" }),
    ];
    const result = generateCandidates(records, cfg);
    expect(result.pairs).toHaveLength(1);
    const keys = result.pairs.map((p) => `${p.leftId}|${p.rightId}`);
    expect(keys).toEqual([...new Set(keys)]);
  });
});
