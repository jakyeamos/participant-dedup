import { describe, expect, it } from "vitest";
import { buildAtomicRequest, type AtomicRequestInput } from "@/server/apply/atomicRequest";
import { composeAuditRows, type AuditContext } from "@/server/apply/audit";
import { DedupError } from "@/server/errors";
import type { MergePlan } from "@/server/review/mergePlan";
import type { RecordSnapshot } from "@/server/types";
import { AUDIT_FIELDS } from "@/server/systemSheets";
import { cloneDefaultConfig } from "@/shared/config";
import type {
  AppendCellsRequest,
  CopyPasteRequest,
  DeleteDimensionRequest,
  SheetsRequest,
  UpdateCellsRequest,
} from "@/server/sheets/SheetsGateway";

const SOURCE_SHEET_ID = 11;
const AUDIT_SHEET_ID = 77;
const CLUSTER_SHEET_ID = 78;

const HEADERS = ["_Dedup_ID", "First", "Last", "Phone", "Notes"];
const columnIndexByHeader: Record<string, number> = {};
HEADERS.forEach((h, i) => {
  columnIndexByHeader[h] = i;
});

function rec(id: string, row: number, values: Record<string, string> = {}): RecordSnapshot {
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

function plan(patch: Partial<MergePlan> & { clusterId: string }): MergePlan {
  return {
    retainedIds: [],
    fills: [],
    deletions: [],
    conflicts: [],
    warnings: [],
    issues: [],
    ok: true,
    ...patch,
  };
}

const ctx: AuditContext = {
  batchId: "b1",
  applyBatchId: "ab1",
  reviewerId: "r@x.com",
  actorId: "r@x.com",
  actorType: "EMAIL",
  sourceSheetId: SOURCE_SHEET_ID,
  sourceSheetName: "Participants",
  eventAt: "2026-07-23T00:00:00.000Z",
};

function input(patch: Partial<AtomicRequestInput> = {}): AtomicRequestInput {
  return {
    sourceSheetId: SOURCE_SHEET_ID,
    columnIndexByHeader,
    rowByDedupId: {},
    plans: [],
    auditSheetId: AUDIT_SHEET_ID,
    auditRows: [],
    statusUpdates: [],
    ...patch,
  };
}

function kindsOf(requests: SheetsRequest[]): string[] {
  return requests.map((r) => Object.keys(r)[0] ?? "");
}

function deletionsOf(requests: SheetsRequest[]): DeleteDimensionRequest["range"][] {
  return requests
    .filter((r): r is { deleteDimension: DeleteDimensionRequest } => "deleteDimension" in r)
    .map((r) => r.deleteDimension.range);
}

function copiesOf(requests: SheetsRequest[]): CopyPasteRequest[] {
  return requests
    .filter((r): r is { copyPaste: CopyPasteRequest } => "copyPaste" in r)
    .map((r) => r.copyPaste);
}

function appendsOf(requests: SheetsRequest[]): AppendCellsRequest[] {
  return requests
    .filter((r): r is { appendCells: AppendCellsRequest } => "appendCells" in r)
    .map((r) => r.appendCells);
}

function updatesOf(requests: SheetsRequest[]): UpdateCellsRequest[] {
  return requests
    .filter((r): r is { updateCells: UpdateCellsRequest } => "updateCells" in r)
    .map((r) => r.updateCells);
}

describe("composeAuditRows (§25.4)", () => {
  const records = new Map([
    ["p1", rec("p1", 2, { First: "Ann", Last: "Lee" })],
    ["p2", rec("p2", 3, { First: "Ann", Last: "Lee", Phone: "555-0100" })],
  ]);
  const rows = new Map([
    ["p1", 2],
    ["p2", 3],
  ]);

  const plans = [
    plan({
      clusterId: "C1",
      retainedIds: ["p1"],
      fills: [{ retainedId: "p1", header: "Phone", value: "555-0100", sourceId: "p2" }],
      deletions: [{ deletedId: "p2", retainedId: "p1" }],
    }),
  ];

  it("emits one FIELD_FILLED per fill, ROW_DELETED per deletion, CLUSTER_APPLIED per cluster and one APPLY_COMPLETED", () => {
    const out = composeAuditRows(ctx, plans, records, rows);
    expect(out.map((r) => r.eventType)).toEqual([
      "FIELD_FILLED",
      "ROW_DELETED",
      "CLUSTER_APPLIED",
      "APPLY_COMPLETED",
    ]);
  });

  it("records the filled field's before and after values", () => {
    const filled = composeAuditRows(ctx, plans, records, rows)[0]!;
    expect(filled.fieldName).toBe("Phone");
    expect(filled.targetDedupId).toBe("p1");
    expect(filled.beforeValue).toBe("");
    expect(filled.afterValue).toBe("555-0100");
    expect(filled.relatedIds).toEqual(["p2"]);
  });

  it("carries a full row snapshot for every deleted record", () => {
    const deleted = composeAuditRows(ctx, plans, records, rows)[1]!;
    expect(deleted.targetDedupId).toBe("p2");
    expect(deleted.rowSnapshot).toEqual({
      dedupId: "p2",
      row: 3,
      values: ["p2", "Ann", "Lee", "555-0100", ""],
    });
  });

  it("attributes every event to the acting reviewer", () => {
    for (const row of composeAuditRows(ctx, plans, records, rows)) {
      expect(row.actorId).toBe("r@x.com");
      expect(row.reviewerId).toBe("r@x.com");
      expect(row.actorType).toBe("EMAIL");
      expect(row.batchId).toBe("b1");
      expect(row.applyBatchId).toBe("ab1");
      expect(row.eventAt).toBe("2026-07-23T00:00:00.000Z");
      expect(String(row.eventId)).not.toBe("");
    }
  });

  it("gives every event a distinct id", () => {
    const ids = composeAuditRows(ctx, plans, records, rows).map((r) => r.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildAtomicRequest (§25)", () => {
  const cfg = cloneDefaultConfig();

  it("converts one-based source rows to descending zero-based delete intervals", () => {
    const req = buildAtomicRequest(
      input({
        rowByDedupId: { a: 5, b: 3, c: 8, keep: 2 },
        plans: [
          plan({
            clusterId: "C1",
            retainedIds: ["keep"],
            deletions: [
              { deletedId: "a", retainedId: "keep" },
              { deletedId: "b", retainedId: "keep" },
              { deletedId: "c", retainedId: "keep" },
            ],
          }),
        ],
      }),
      cfg,
    );

    expect(deletionsOf(req.requests)).toEqual([
      { sheetId: SOURCE_SHEET_ID, dimension: "ROWS", startIndex: 7, endIndex: 8 },
      { sheetId: SOURCE_SHEET_ID, dimension: "ROWS", startIndex: 4, endIndex: 5 },
      { sheetId: SOURCE_SHEET_ID, dimension: "ROWS", startIndex: 2, endIndex: 3 },
    ]);
  });

  it("merges consecutive rows into a single interval (§25.3)", () => {
    const req = buildAtomicRequest(
      input({
        rowByDedupId: { a: 3, b: 4, c: 5, d: 9, keep: 2 },
        plans: [
          plan({
            clusterId: "C1",
            retainedIds: ["keep"],
            deletions: ["a", "b", "c", "d"].map((deletedId) => ({ deletedId, retainedId: "keep" })),
          }),
        ],
      }),
      cfg,
    );

    expect(deletionsOf(req.requests)).toEqual([
      { sheetId: SOURCE_SHEET_ID, dimension: "ROWS", startIndex: 8, endIndex: 9 },
      { sheetId: SOURCE_SHEET_ID, dimension: "ROWS", startIndex: 2, endIndex: 5 },
    ]);
  });

  it("copies blank-field fills by value from the source cell to the retained cell (§25.2)", () => {
    const req = buildAtomicRequest(
      input({
        rowByDedupId: { keep: 2, gone: 6 },
        plans: [
          plan({
            clusterId: "C1",
            retainedIds: ["keep"],
            fills: [{ retainedId: "keep", header: "Phone", value: "555-0100", sourceId: "gone" }],
          }),
        ],
      }),
      cfg,
    );

    expect(copiesOf(req.requests)).toEqual([
      {
        source: {
          sheetId: SOURCE_SHEET_ID,
          startRowIndex: 5,
          endRowIndex: 6,
          startColumnIndex: 3,
          endColumnIndex: 4,
        },
        destination: {
          sheetId: SOURCE_SHEET_ID,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 3,
          endColumnIndex: 4,
        },
        pasteType: "PASTE_VALUES",
      },
    ]);
  });

  it("orders subrequests fills → deletions → audit append → status updates (§25.1)", () => {
    const req = buildAtomicRequest(
      input({
        rowByDedupId: { keep: 2, gone: 6 },
        plans: [
          plan({
            clusterId: "C1",
            retainedIds: ["keep"],
            fills: [{ retainedId: "keep", header: "Phone", value: "555-0100", sourceId: "gone" }],
            deletions: [{ deletedId: "gone", retainedId: "keep" }],
          }),
        ],
        auditRows: [{ eventType: "APPLY_COMPLETED", batchId: "b1" }],
        statusUpdates: [{ sheetId: CLUSTER_SHEET_ID, rowIndex: 4, cells: ["b1", "C1"] }],
      }),
      cfg,
    );

    expect(kindsOf(req.requests)).toEqual([
      "copyPaste",
      "deleteDimension",
      "appendCells",
      "updateCells",
    ]);
  });

  it("puts audit rows in the same request object as the source changes (atomicity, AT-29)", () => {
    const req = buildAtomicRequest(
      input({
        rowByDedupId: { keep: 2, gone: 6 },
        plans: [
          plan({
            clusterId: "C1",
            retainedIds: ["keep"],
            deletions: [{ deletedId: "gone", retainedId: "keep" }],
          }),
        ],
        auditRows: [
          {
            eventType: "ROW_DELETED",
            batchId: "b1",
            reviewerId: "r@x.com",
            rowSnapshot: { dedupId: "gone", row: 6, values: ["gone"] },
          },
        ],
      }),
      cfg,
    );

    // One batchUpdate, never two: the whole apply succeeds or fails as a unit.
    expect(Object.keys(req)).toEqual(["requests"]);
    const appends = appendsOf(req.requests);
    expect(appends).toHaveLength(1);
    expect(appends[0]!.sheetId).toBe(AUDIT_SHEET_ID);

    const typeCol = AUDIT_FIELDS.findIndex((f) => f.key === "eventType");
    const snapshotCol = AUDIT_FIELDS.findIndex((f) => f.key === "rowSnapshot");
    const cells = appends[0]!.rows[0]!.values;
    expect(cells[typeCol]).toEqual({ userEnteredValue: { stringValue: "ROW_DELETED" } });
    expect(cells[snapshotCol]).toEqual({
      userEnteredValue: {
        stringValue: JSON.stringify({ dedupId: "gone", row: 6, values: ["gone"] }),
      },
    });
    expect(cells).toHaveLength(AUDIT_FIELDS.length);
  });

  it("writes queue and batch status rows in the same request (§25.5)", () => {
    const req = buildAtomicRequest(
      input({
        statusUpdates: [
          { sheetId: CLUSTER_SHEET_ID, rowIndex: 4, cells: ["b1", "C1", 7, true, null] },
        ],
      }),
      cfg,
    );

    expect(updatesOf(req.requests)).toEqual([
      {
        rows: [
          {
            values: [
              { userEnteredValue: { stringValue: "b1" } },
              { userEnteredValue: { stringValue: "C1" } },
              { userEnteredValue: { numberValue: 7 } },
              { userEnteredValue: { boolValue: true } },
              { userEnteredValue: { stringValue: "" } },
            ],
          },
        ],
        fields: "userEnteredValue",
        range: {
          sheetId: CLUSTER_SHEET_ID,
          startRowIndex: 4,
          endRowIndex: 5,
          startColumnIndex: 0,
          endColumnIndex: 5,
        },
      },
    ]);
  });

  it("refuses to build a request larger than the atomic cap (§25.6)", () => {
    const small = cloneDefaultConfig();
    small.execution.maxAtomicApplyRequests = 3;

    const rowByDedupId: Record<string, number> = { keep: 2 };
    const deletions: MergePlan["deletions"] = [];
    // Non-consecutive rows so each deletion needs its own subrequest.
    for (let i = 0; i < 8; i++) {
      const id = `d${i}`;
      rowByDedupId[id] = 4 + i * 2;
      deletions.push({ deletedId: id, retainedId: "keep" });
    }

    const build = (): unknown =>
      buildAtomicRequest(
        input({ rowByDedupId, plans: [plan({ clusterId: "C1", retainedIds: ["keep"], deletions })] }),
        small,
      );

    expect(build).toThrow(DedupError);
    let code = "";
    try {
      build();
    } catch (err) {
      code = (err as DedupError).code;
    }
    expect(code).toBe("ATOMIC_REQUEST_TOO_LARGE");
  });

  it("builds nothing for a Keep All plan", () => {
    const req = buildAtomicRequest(
      input({ plans: [plan({ clusterId: "C1", retainedIds: ["a", "b"] })] }),
      cfg,
    );
    expect(req.requests).toEqual([]);
  });
});
