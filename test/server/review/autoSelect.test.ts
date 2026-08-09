import { describe, expect, it } from "vitest";
import {
  buildRichestMergeDecision,
  fieldChoicesPreferMoreInfo,
  informationScore,
  pickRichestId,
} from "@/server/review/autoSelect";
import { cloneDefaultConfig } from "@/shared/config";
import type { Cluster, RecordSnapshot, SourceSchema } from "@/server/types";

const cfg = cloneDefaultConfig();

const HEADERS = ["_Dedup_ID", "First", "Last", "Date of Birth", "Zip", "Phone", "Notes"];

const schema: SourceSchema = {
  spreadsheetId: "SS1",
  sheetId: 0,
  sheetName: "Participants",
  headerRow: 1,
  headers: HEADERS,
  normalizedHeaders: HEADERS.map((h) => h.toLowerCase()),
  columnByCanonicalField: { first: 1, last: 2, dob: 3, zip: 4 },
  extraColumns: [
    { header: "Phone", columnIndex: 5 },
    { header: "Notes", columnIndex: 6 },
  ],
  dedupIdColumnIndex: 0,
  schemaHash: "sh",
};

function rec(id: string, row: number, values: Record<string, string>): RecordSnapshot {
  const displayValues = HEADERS.map((h) => (h === "_Dedup_ID" ? id : (values[h] ?? "")));
  const valuesByHeader: Record<string, string> = {};
  const displayByHeader: Record<string, string> = {};
  HEADERS.forEach((h, i) => {
    valuesByHeader[h] = displayValues[i] ?? "";
    displayByHeader[h] = displayValues[i] ?? "";
  });
  return {
    batchId: "b1",
    dedupId: id,
    sourceRowAtScan: row,
    rowFingerprint: `fp-${id}`,
    relevantHash: `rh-${id}`,
    rawValues: displayValues,
    displayValues,
    formulas: HEADERS.map(() => ""),
    valuesByHeader,
    displayByHeader,
    normalized: {
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
        missingCoreComponent: false,
      },
      dob: { value: null, state: "MISSING" },
      zip: null,
      address: null,
      city: null,
      state: null,
      county: null,
      extras: {},
    },
  };
}

function clusterOf(ids: string[]): Cluster {
  return {
    clusterId: "c1",
    clusterType: "CORE",
    memberIds: ids,
    suggestedMemberIds: [],
    edges: [],
    topConfidence: "HIGH",
    topScore: 90,
    hasLowOnlyEdges: false,
    chainWarning: false,
    oversized: false,
  };
}

describe("autoSelect", () => {
  it("scores richer rows higher", () => {
    const thin = rec("a", 2, { First: "Ann", Last: "Lee" });
    const rich = rec("b", 3, {
      First: "Ann",
      Last: "Lee",
      Zip: "44102",
      Phone: "555-0100",
      Notes: "case notes",
    });
    expect(informationScore(rich, schema)).toBeGreaterThan(informationScore(thin, schema));
  });

  it("prefers more complete values when fill counts match", () => {
    const shortAddr = rec("a", 2, { First: "Ann", Last: "Lee", Notes: "x" });
    const longAddr = rec("b", 3, {
      First: "Ann",
      Last: "Lee",
      Notes: "full case history with details",
    });
    expect(pickRichestId(["a", "b"], [shortAddr, longAddr], schema)).toBe("b");
  });

  it("keeps the richer core and merges blanks from the thinner duplicate", () => {
    const records = [
      rec("thin", 2, { First: "John", Last: "Public" }),
      rec("rich", 3, {
        First: "Jon",
        Last: "Public",
        Zip: "44102",
        Phone: "555-0100",
        Notes: "guardian",
      }),
    ];
    const result = buildRichestMergeDecision({
      batchId: "b1",
      cluster: clusterOf(["thin", "rich"]),
      expectedRevision: 0,
      coreIds: ["thin", "rich"],
      records,
      schema,
      cfg,
      notes: "test",
    });

    expect(result).not.toBeNull();
    expect(result!.retainedId).toBe("rich");
    expect(result!.deletedIds).toEqual(["thin"]);
    expect(result!.decision.mode).toBe("SELECT_RECORDS");
    expect(result!.decision.deleteAssignments).toEqual({ thin: "rich" });
  });

  it("resolves blank-field conflicts by preferring the longer value", () => {
    const choices = fieldChoicesPreferMoreInfo(
      [{ retainedId: "r1", header: "Notes", options: ["ok", "detailed case note"] }],
      [
        rec("r1", 2, { First: "A" }),
        rec("d1", 3, { Notes: "ok" }),
        rec("d2", 4, { Notes: "detailed case note" }),
      ],
      ["d1", "d2"],
    );
    expect(choices).toEqual({
      r1: { Notes: { mode: "SOURCE", sourceId: "d2" } },
    });
  });

  it("fills missing name/DOB from the deleted row onto the richer keeper", () => {
    const records = [
      rec("keeper", 2, {
        Last: "Public",
        Zip: "44102",
        Phone: "555-0100",
        Notes: "intake complete",
      }),
      rec("dup", 3, {
        First: "John",
        Last: "Public",
        "Date of Birth": "1990-05-01",
      }),
    ];
    const result = buildRichestMergeDecision({
      batchId: "b1",
      cluster: clusterOf(["keeper", "dup"]),
      expectedRevision: 1,
      coreIds: ["keeper", "dup"],
      records,
      schema,
      cfg,
      notes: "test",
    });

    expect(result).not.toBeNull();
    expect(result!.retainedId).toBe("keeper");
    expect(result!.fillCount).toBeGreaterThanOrEqual(2);
  });
});
