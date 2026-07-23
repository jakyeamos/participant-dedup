import { describe, expect, it } from "vitest";
import { generateFixture, POSITIVE_KINDS } from "../../tools/generateFixture";

// Real-looking names that must never appear — proves the data is invented.
const DENYLIST = [
  "john",
  "mary",
  "michael",
  "jennifer",
  "smith",
  "johnson",
  "williams",
  "jones",
  "brown",
  "garcia",
];

describe("generateFixture", () => {
  it("produces exactly the requested row count", () => {
    const { rows } = generateFixture(1, 200);
    expect(rows).toHaveLength(200);
  });

  it("is deterministic for a given seed", () => {
    const a = generateFixture(7, 200);
    const b = generateFixture(7, 200);
    expect(a).toEqual(b);
  });

  it("changes output when the seed changes", () => {
    const a = generateFixture(1, 200);
    const b = generateFixture(2, 200);
    expect(a.rows).not.toEqual(b.rows);
  });

  it("emits non-empty ground truth with at least one positive duplicate group", () => {
    const { groundTruth } = generateFixture(1, 200);
    expect(groundTruth.length).toBeGreaterThan(0);
    expect(groundTruth.some((g) => POSITIVE_KINDS.has(g.kind))).toBe(true);
    for (const g of groundTruth) expect(g.ids.length).toBeGreaterThanOrEqual(2);
  });

  it("assigns a unique _Dedup_ID to every row", () => {
    const { rows } = generateFixture(1, 200);
    const ids = rows.map((r) => r["_Dedup_ID"]);
    expect(new Set(ids).size).toBe(rows.length);
    expect(ids.every((id) => typeof id === "string" && id!.length > 0)).toBe(true);
  });

  it("uses only invented names (no real seed names)", () => {
    const { rows } = generateFixture(3, 500);
    for (const r of rows) {
      const first = (r["First Name"] ?? "").toLowerCase();
      const last = (r["Last Name"] ?? "").toLowerCase();
      expect(DENYLIST).not.toContain(first);
      expect(DENYLIST).not.toContain(last);
    }
  });
});
