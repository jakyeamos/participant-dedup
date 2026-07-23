import { describe, expect, it } from "vitest";
import { buildMergePlan } from "@/server/review/mergePlan";
import { cloneDefaultConfig } from "@/shared/config";
import type { Cluster, ClusterDecision, RecordSnapshot, SourceSchema } from "@/server/types";

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

function rec(
  id: string,
  row: number,
  values: Record<string, string>,
  formulas: Record<string, string> = {},
): RecordSnapshot {
  const displayValues = HEADERS.map((h) => (h === "_Dedup_ID" ? id : (values[h] ?? "")));
  const formulaValues = HEADERS.map((h) => formulas[h] ?? "");
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
    formulas: formulaValues,
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

function cluster(memberIds: string[], oversized = false): Cluster {
  return {
    clusterId: "C1",
    clusterType: "CORE",
    memberIds,
    suggestedMemberIds: [],
    edges: [],
    topConfidence: "HIGH",
    topScore: 95,
    hasLowOnlyEdges: false,
    chainWarning: false,
    oversized,
  };
}

function decision(patch: Partial<ClusterDecision>): ClusterDecision {
  return {
    batchId: "b1",
    clusterId: "C1",
    expectedRevision: 1,
    mode: "SELECT_RECORDS",
    retainedIds: [],
    deleteAssignments: {},
    fieldChoices: {},
    notes: "",
    ...patch,
  };
}

describe("buildMergePlan", () => {
  it("AT-14: a single unambiguous blank field is auto-filled from the deleted row", () => {
    const records = [
      rec("r1", 2, { First: "John", Last: "Public" }),
      rec("d1", 3, { First: "John", Last: "Public", Phone: "555-0100" }),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(true);
    expect(plan.deletions).toEqual([{ deletedId: "d1", retainedId: "r1" }]);
    expect(plan.fills).toEqual([
      { retainedId: "r1", header: "Phone", value: "555-0100", sourceId: "d1" },
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it("AT-15: blank protected fields are never auto-filled", () => {
    const records = [
      rec("r1", 2, { Last: "Public", Phone: "555-0100" }),
      rec("d1", 3, { First: "John", Last: "Public", "Date of Birth": "1990-01-01" }),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(true);
    expect(plan.fills.map((f) => f.header)).not.toContain("First");
    expect(plan.fills.map((f) => f.header)).not.toContain("Date of Birth");
    expect(plan.fills).toEqual([]);
  });

  it("never fills the _Dedup_ID column", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, { Phone: "555-0100" })];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );
    expect(plan.fills.map((f) => f.header)).not.toContain("_Dedup_ID");
  });

  it("AT-16: two conflicting proposals become a conflict and block the plan", () => {
    const records = [
      rec("r1", 2, { First: "John", Last: "Public" }),
      rec("d1", 3, { Zip: "02118" }),
      rec("d2", 4, { Zip: "02119" }),
    ];
    const dec = decision({
      retainedIds: ["r1"],
      deleteAssignments: { d1: "r1", d2: "r1" },
    });
    const plan = buildMergePlan(cluster(["r1", "d1", "d2"]), dec, records, schema, cfg);

    expect(plan.ok).toBe(false);
    expect(plan.conflicts).toEqual([
      { retainedId: "r1", header: "Zip", options: ["02118", "02119"] },
    ]);
    expect(plan.fills.map((f) => f.header)).not.toContain("Zip");
    expect(plan.issues).toContain("UNRESOLVED_CONFLICT");
  });

  it("AT-16: an explicit SOURCE choice resolves the conflict", () => {
    const records = [
      rec("r1", 2, { First: "John", Last: "Public" }),
      rec("d1", 3, { Zip: "02118" }),
      rec("d2", 4, { Zip: "02119" }),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "d1", "d2"]),
      decision({
        retainedIds: ["r1"],
        deleteAssignments: { d1: "r1", d2: "r1" },
        fieldChoices: { r1: { Zip: { mode: "SOURCE", sourceId: "d2" } } },
      }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.fills).toContainEqual({
      retainedId: "r1",
      header: "Zip",
      value: "02119",
      sourceId: "d2",
    });
  });

  it("AT-16: LEAVE_BLANK resolves the conflict without filling", () => {
    const records = [
      rec("r1", 2, { First: "John", Last: "Public" }),
      rec("d1", 3, { Zip: "02118" }),
      rec("d2", 4, { Zip: "02119" }),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "d1", "d2"]),
      decision({
        retainedIds: ["r1"],
        deleteAssignments: { d1: "r1", d2: "r1" },
        fieldChoices: { r1: { Zip: { mode: "LEAVE_BLANK" } } },
      }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.fills.map((f) => f.header)).not.toContain("Zip");
  });

  it("values that differ only by case and spacing are one group, filled from the lowest source row", () => {
    const records = [
      rec("r1", 2, {}),
      rec("d1", 9, { Phone: "  main  ST " }),
      rec("d2", 5, { Phone: "Main St" }),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "d1", "d2"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1", d2: "r1" } }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(true);
    expect(plan.fills).toContainEqual({
      retainedId: "r1",
      header: "Phone",
      value: "Main St",
      sourceId: "d2",
    });
  });

  it("AT-13: every deleted row must have a retained target", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, {}), rec("d2", 4, {})];
    const plan = buildMergePlan(
      cluster(["r1", "d1", "d2"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(false);
    expect(plan.issues).toContain("UNASSIGNED_MEMBER");
  });

  it("AT-13: with multiple retained records each deletion keeps its own target", () => {
    const records = [
      rec("r1", 2, {}),
      rec("r2", 3, { Phone: "555-0199" }),
      rec("d1", 4, { Phone: "555-0100" }),
      rec("d2", 5, { Notes: "from d2" }),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "r2", "d1", "d2"]),
      decision({
        retainedIds: ["r1", "r2"],
        deleteAssignments: { d1: "r1", d2: "r2" },
      }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(true);
    expect(plan.deletions).toEqual([
      { deletedId: "d1", retainedId: "r1" },
      { deletedId: "d2", retainedId: "r2" },
    ]);
    expect(plan.fills).toEqual([
      { retainedId: "r1", header: "Phone", value: "555-0100", sourceId: "d1" },
      { retainedId: "r2", header: "Notes", value: "from d2", sourceId: "d2" },
    ]);
  });

  it("never pulls a value from another retained record", () => {
    const records = [
      rec("r1", 2, {}),
      rec("r2", 3, { Phone: "555-0199" }),
      rec("d1", 4, {}),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "r2", "d1"]),
      decision({ retainedIds: ["r1", "r2"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(true);
    expect(plan.fills).toEqual([]);
  });

  it("a formula in the target cell is never treated as blank", () => {
    const records = [
      rec("r1", 2, { Notes: "computed" }, { Notes: "=A2" }),
      rec("d1", 3, { Notes: "literal" }),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );

    expect(plan.fills.map((f) => f.header)).not.toContain("Notes");
    expect(plan.warnings).toContain("FORMULA_FIELD_SKIPPED");
  });

  it("a formula source cell is never used for automatic fill", () => {
    const records = [
      rec("r1", 2, {}),
      rec("d1", 3, { Notes: "computed" }, { Notes: "=A3" }),
    ];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );

    expect(plan.fills).toEqual([]);
    expect(plan.warnings).toContain("FORMULA_FIELD_SKIPPED");
  });

  it("KEEP_ALL retains every member and plans nothing", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, { Phone: "555-0100" })];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ mode: "KEEP_ALL" }),
      records,
      schema,
      cfg,
    );

    expect(plan.ok).toBe(true);
    expect(plan.retainedIds).toEqual(["r1", "d1"]);
    expect(plan.deletions).toEqual([]);
    expect(plan.fills).toEqual([]);
  });

  it("rejects a decision with no retained record", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, {})];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ retainedIds: [], deleteAssignments: { r1: "d1", d1: "r1" } }),
      records,
      schema,
      cfg,
    );
    expect(plan.ok).toBe(false);
    expect(plan.issues).toContain("NO_RETAINED");
  });

  it("rejects a record that targets itself", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, {})];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "d1" } }),
      records,
      schema,
      cfg,
    );
    expect(plan.ok).toBe(false);
    expect(plan.issues).toContain("SELF_TARGET");
  });

  it("rejects ids that do not belong to the cluster", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, {})];
    const plan = buildMergePlan(
      cluster(["r1", "d1"]),
      decision({ retainedIds: ["r1", "ghost"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );
    expect(plan.ok).toBe(false);
    expect(plan.issues).toContain("UNKNOWN_ID");
  });

  it("rejects a deletion target that is not retained", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, {}), rec("d2", 4, {})];
    const plan = buildMergePlan(
      cluster(["r1", "d1", "d2"]),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "d2", d2: "r1" } }),
      records,
      schema,
      cfg,
    );
    expect(plan.ok).toBe(false);
    expect(plan.issues).toContain("TARGET_NOT_RETAINED");
  });

  it("§18.3 blocks deletion from an oversized cluster", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, {})];
    const plan = buildMergePlan(
      cluster(["r1", "d1"], true),
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );
    expect(plan.ok).toBe(false);
    expect(plan.issues).toContain("OVERSIZED_CLUSTER");
    expect(plan.deletions).toEqual([]);
  });

  it("treats a suggested member as a normal member only once the decision includes it", () => {
    const records = [rec("r1", 2, {}), rec("d1", 3, {}), rec("s1", 4, { Phone: "555-0100" })];
    const base = cluster(["r1", "d1"]);
    const withSuggestion: Cluster = { ...base, suggestedMemberIds: ["s1"] };

    const excluded = buildMergePlan(
      withSuggestion,
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1" } }),
      records,
      schema,
      cfg,
    );
    expect(excluded.ok).toBe(true);
    expect(excluded.deletions.map((d) => d.deletedId)).toEqual(["d1"]);

    const included = buildMergePlan(
      withSuggestion,
      decision({ retainedIds: ["r1"], deleteAssignments: { d1: "r1", s1: "r1" } }),
      records,
      schema,
      cfg,
    );
    expect(included.ok).toBe(true);
    expect(included.fills).toContainEqual({
      retainedId: "r1",
      header: "Phone",
      value: "555-0100",
      sourceId: "s1",
    });
  });
});
