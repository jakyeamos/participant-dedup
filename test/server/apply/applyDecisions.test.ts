import { beforeEach, describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets, nowIso } from "@/server/systemSheets";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { auditRepository } from "@/server/auditRepository";
import { advanceScan, startScan } from "@/server/scan/scanStateMachine";
import { decisionHash } from "@/server/hashing";
import { isDedupError } from "@/server/errors";
import type { SheetsBatchUpdateRequest } from "@/server/sheets/SheetsGateway";
import type { CellValue, ClusterDecision, SourceSchema } from "@/server/types";
import { cloneDefaultConfig, type DedupConfig } from "@/shared/config";
import { createApplyChallenge, type ApplyChallenge } from "@/server/apply/preflight";
import { applyDecisions } from "@/server/apply/applyDecisions";

const PEOPLE = "Participants";

const HEADER = ["First Name", "Last Name", "DOB", "ZIP", "Address", "City", "State", "Notes"];

// Three identical Anns (Notes is blank on the first and set on the second), two
// identical Bobs, and four distinct singletons.
const ROWS: string[][] = [
  ["Ann", "Lee", "1/1/1980", "01234", "10 Oak St", "Boston", "MA", ""],
  ["Ann", "Lee", "1/1/1980", "01234", "10 Oak St", "Boston", "MA", "alpha"],
  ["Ann", "Lee", "1/1/1980", "01234", "10 Oak St", "Boston", "MA", "beta"],
  ["Bob", "Kim", "5/5/1975", "02345", "22 Elm St", "Salem", "MA", "solo"],
  ["Bob", "Kim", "5/5/1975", "02345", "22 Elm St", "Salem", "MA", ""],
  ["Carol", "Adams", "3/3/1970", "03301", "1 A St", "Concord", "NH", ""],
  ["Dave", "Brown", "4/4/1971", "04401", "2 B St", "Bangor", "ME", ""],
  ["Eve", "Clark", "6/6/1972", "05401", "3 C St", "Burlington", "VT", ""],
  ["Frank", "Davis", "7/7/1973", "06010", "4 D St", "Bristol", "CT", ""],
];

const NOTES_COL = 7;

interface Harness {
  g: FakeSheetsGateway;
  cfg: DedupConfig;
  batchId: string;
  schema: SourceSchema;
  /** Participant ids keyed by their 1-based sheet row. */
  idByRow: Map<number, string>;
  annClusterId: string;
  bobClusterId: string;
}

function runToEnd(g: FakeSheetsGateway, cfg: DedupConfig): void {
  let state = advanceScan(g, cfg);
  let guard = 0;
  while (state.status !== "READY" && state.status !== "FAILED" && guard++ < 10_000) {
    state = advanceScan(g, cfg);
  }
  if (state.status !== "READY") throw new Error(`scan ended ${state.status}`);
}

function harness(): Harness {
  const cfg = cloneDefaultConfig();
  const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: "r@x.com" });
  ensureSystemSheets(g, cfg);
  g.loadSheet(PEOPLE, { values: [HEADER, ...ROWS.map((r) => [...r])] });

  const start = startScan(g, PEOPLE, cfg);
  runToEnd(g, cfg);

  const batch = batchesRepository(g).get(start.batchId)!;
  const schema = batch.schema as unknown as SourceSchema;

  const idByRow = new Map<number, string>();
  for (const rec of recordsRepository(g).readByBatch(start.batchId, schema.headers)) {
    idByRow.set(rec.sourceRowAtScan, rec.dedupId);
  }

  const clusters = clustersRepository(g).listByBatch(start.batchId);
  const find = (member: string): string => {
    const hit = clusters.find((c) => (c.memberIds as unknown as string[]).includes(member));
    if (!hit) throw new Error(`no cluster for ${member}`);
    return String(hit.clusterId);
  };

  return {
    g,
    cfg,
    batchId: start.batchId,
    schema,
    idByRow,
    annClusterId: find(idByRow.get(2)!),
    bobClusterId: find(idByRow.get(5)!),
  };
}

/** Writes a reviewed decision the way the review layer will; Phase F owns the real path. */
function saveDecision(g: FakeSheetsGateway, decision: ClusterDecision): ClusterDecision {
  clustersRepository(g).update(decision.clusterId, {
    decision,
    decisionHash: decisionHash(decision),
    status: "READY_TO_APPLY",
    reviewerId: "r@x.com",
    reviewedAt: nowIso(g),
  });
  return decision;
}

function decisionFor(
  h: Harness,
  clusterId: string,
  retainedRow: number,
  deletedRows: number[],
  patch: Partial<ClusterDecision> = {},
): ClusterDecision {
  const retained = h.idByRow.get(retainedRow)!;
  const deleteAssignments: Record<string, string> = {};
  for (const row of deletedRows) deleteAssignments[h.idByRow.get(row)!] = retained;
  return {
    batchId: h.batchId,
    clusterId,
    expectedRevision: 1,
    mode: "SELECT_RECORDS",
    retainedIds: [retained],
    deleteAssignments,
    fieldChoices: {},
    notes: "",
    ...patch,
  };
}

/** Ann keeps row 2 and takes "alpha" from row 3; Bob keeps row 5. */
function resolvedDecisions(h: Harness): ClusterDecision[] {
  const ann = decisionFor(h, h.annClusterId, 2, [3, 4], {
    fieldChoices: {
      [h.idByRow.get(2)!]: { Notes: { mode: "SOURCE", sourceId: h.idByRow.get(3)! } },
    },
  });
  const bob = decisionFor(h, h.bobClusterId, 5, [6]);
  return [saveDecision(h.g, ann), saveDecision(h.g, bob)];
}

function confirm(challenge: { token: string; summaryHash: string }): ApplyChallenge {
  return { token: challenge.token, summaryHash: challenge.summaryHash, confirmed: true };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (isDedupError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a DedupError");
}

function sourceGrid(h: Harness): CellValue[][] {
  return h.g.readRange(PEOPLE, "A1:Z");
}

function eventsOfType(h: Harness, eventType: string): Array<Record<string, unknown>> {
  return auditRepository(h.g)
    .readAll()
    .filter((e) => e.eventType === eventType);
}

/** Runs a full save → challenge → confirm → apply cycle. */
function applyAll(h: Harness, decisions: ClusterDecision[]): ReturnType<typeof applyDecisions> {
  const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);
  return applyDecisions(h.g, h.batchId, decisions, confirm(challenge), h.cfg);
}

describe("applyDecisions", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("AT-19 removes the confirmed rows and fills the chosen blank field", () => {
    const before = sourceGrid(h);
    const result = applyAll(h, resolvedDecisions(h));

    expect(result).toMatchObject({ deletedRows: 3, filledFields: 1, auditWritten: 7 });

    const after = sourceGrid(h);
    expect(after).toHaveLength(before.length - 3);

    // Ann's retained row keeps its position and gains the chosen value.
    expect(after[1]![NOTES_COL]).toBe("alpha");
    expect(after[1]![h.schema.dedupIdColumnIndex]).toBe(h.idByRow.get(2)!);

    // Both merged-away Anns and the duplicate Bob are gone.
    const ids = after.slice(1).map((r) => r[h.schema.dedupIdColumnIndex]);
    expect(ids).not.toContain(h.idByRow.get(3)!);
    expect(ids).not.toContain(h.idByRow.get(4)!);
    expect(ids).not.toContain(h.idByRow.get(6)!);
    expect(ids).toContain(h.idByRow.get(5)!);
  });

  it("AT-19 records a restorable snapshot for every deleted row", () => {
    applyAll(h, resolvedDecisions(h));

    const deleted = eventsOfType(h, "ROW_DELETED");
    expect(deleted).toHaveLength(3);

    const beta = deleted.find((e) => e.targetDedupId === h.idByRow.get(4)!)!;
    const snapshot = beta.rowSnapshot as { dedupId: string; row: number; values: string[] };
    expect(snapshot.dedupId).toBe(h.idByRow.get(4)!);
    expect(snapshot.row).toBe(4);
    expect(snapshot.values).toContain("beta");
    expect(snapshot.values).toContain(h.idByRow.get(4)!);
    expect(String(beta.applyBatchId)).not.toBe("");
    expect(String(beta.reviewerId)).toBe("r@x.com");
  });

  it("AT-29 sends every source change in a single batchUpdate", () => {
    const calls: SheetsBatchUpdateRequest[] = [];
    const original = h.g.batchUpdate.bind(h.g);
    h.g.batchUpdate = (req) => {
      calls.push(req);
      return original(req);
    };

    applyAll(h, resolvedDecisions(h));

    expect(calls).toHaveLength(1);
    const kinds = calls[0]!.requests.map((r) => Object.keys(r)[0]);
    expect(kinds).toEqual([
      "copyPaste",
      "deleteDimension",
      "deleteDimension",
      "appendCells",
      "updateCells",
      "updateCells",
    ]);
  });

  it("marks each applied cluster with the apply batch id", () => {
    const result = applyAll(h, resolvedDecisions(h));

    for (const clusterId of [h.annClusterId, h.bobClusterId]) {
      const row = clustersRepository(h.g).get(clusterId)!;
      expect(row.status).toBe("APPLIED");
      expect(row.applyBatchId).toBe(result.applyBatchId);
      expect(String(row.appliedAt)).not.toBe("");
      // The decision itself must survive re-encoding, or a replay would fail.
      expect(row.decisionHash).not.toBe("");
    }
  });

  it("AT-17 leaves the participant sheet untouched when a decision is only saved", () => {
    const before = sourceGrid(h);
    const decisions = resolvedDecisions(h);
    createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    expect(sourceGrid(h)).toEqual(before);
  });

  it("AT-26 replays an identical apply as a no-op", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    const first = applyDecisions(h.g, h.batchId, decisions, confirm(challenge), h.cfg);
    const afterFirst = sourceGrid(h);

    const second = applyDecisions(h.g, h.batchId, decisions, confirm(challenge), h.cfg);

    expect(second).toMatchObject({ deletedRows: 0, filledFields: 0, auditWritten: 0 });
    expect(second.applyBatchId).not.toBe(first.applyBatchId);
    expect(sourceGrid(h)).toEqual(afterFirst);
    expect(eventsOfType(h, "ROW_DELETED")).toHaveLength(3);
    expect(eventsOfType(h, "APPLY_ATTEMPTED")).toHaveLength(2);
  });

  it("fails closed when another execution holds the document lock", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);
    const before = sourceGrid(h);

    const other = h.g.getDocumentLock();
    other.acquire(1000);

    expect(
      codeOf(() => applyDecisions(h.g, h.batchId, decisions, confirm(challenge), h.cfg)),
    ).toBe("LOCK_TIMEOUT");
    expect(sourceGrid(h)).toEqual(before);
    expect(eventsOfType(h, "APPLY_ATTEMPTED")).toHaveLength(0);
  });

  it("releases the lock when preflight rejects the apply", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);
    const before = sourceGrid(h);

    // Row 3 is one of Ann's deletions; someone edits it after the confirmation.
    h.g.writeRange(PEOPLE, "D3", [["09999"]]);

    expect(
      codeOf(() => applyDecisions(h.g, h.batchId, decisions, confirm(challenge), h.cfg)),
    ).toBe("STALE_ROW");
    // Only the reviewer's own edit is present; the apply deleted nothing.
    const after = sourceGrid(h);
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r[0])).toEqual(before.map((r) => r[0]));
    expect(eventsOfType(h, "ROW_DELETED")).toHaveLength(0);

    // A later apply must still be able to take the lock.
    const lock = h.g.getDocumentLock();
    expect(() => lock.acquire(1000)).not.toThrow();
  });

  it("keeps unrelated rows exactly where they were", () => {
    applyAll(h, resolvedDecisions(h));

    const after = sourceGrid(h);
    const names = after.slice(1).map((r) => r[0]);
    expect(names).toEqual(["Ann", "Bob", "Carol", "Dave", "Eve", "Frank"]);
  });
});
