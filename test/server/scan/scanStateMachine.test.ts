import { describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { clustersRepository } from "@/server/clustersRepository";
import { pairsRepository } from "@/server/pairsRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { auditRepository } from "@/server/auditRepository";
import { advanceScan, cancelScan, startScan } from "@/server/scan/scanStateMachine";
import { batchesRepository } from "@/server/batchesRepository";
import { cloneDefaultConfig, type DedupConfig } from "@/shared/config";
import { decisionHash } from "@/server/hashing";
import { isDedupError } from "@/server/errors";
import type { ClusterDecision, SourceSchema } from "@/server/types";
import { HEADERS, generateFixture } from "../../../tools/generateFixture";

const PEOPLE = "Participants";

// Header WITHOUT a _Dedup_ID column: the scan must create and assign it.
const HEADER = ["First Name", "Last Name", "DOB", "ZIP", "Address", "City", "State"];

// Sixteen mutually distinct singletons plus two exact-duplicate pairs = 20 rows,
// so a full scan must yield exactly two two-member core clusters.
const DUP_A = ["Ann", "Lee", "1/1/1980", "01234", "10 Oak St", "Boston", "MA"];
const DUP_B = ["Bob", "Kim", "5/5/1975", "02345", "22 Elm St", "Salem", "MA"];

const SINGLETONS: string[][] = [
  ["Carol", "Adams", "3/3/1970", "03301", "1 A St", "Concord", "NH"],
  ["Dave", "Brown", "4/4/1971", "04401", "2 B St", "Bangor", "ME"],
  ["Eve", "Clark", "6/6/1972", "05401", "3 C St", "Burlington", "VT"],
  ["Frank", "Davis", "7/7/1973", "06010", "4 D St", "Bristol", "CT"],
  ["Grace", "Evans", "8/8/1974", "02840", "5 E St", "Newport", "RI"],
  ["Hank", "Ford", "9/9/1976", "10001", "6 F St", "New York", "NY"],
  ["Ivy", "Green", "10/10/1977", "19104", "7 G St", "Philadelphia", "PA"],
  ["Jack", "Hill", "11/11/1978", "07030", "8 H St", "Hoboken", "NJ"],
  ["Kate", "Irwin", "12/12/1979", "20001", "9 I St", "Washington", "DC"],
  ["Leo", "Jones", "1/2/1981", "21201", "11 J St", "Baltimore", "MD"],
  ["Mia", "King", "2/3/1982", "23219", "12 K St", "Richmond", "VA"],
  ["Ned", "Lopez", "3/4/1983", "27601", "13 L St", "Raleigh", "NC"],
  ["Olga", "Moore", "4/5/1984", "29201", "14 M St", "Columbia", "SC"],
  ["Paul", "Nash", "5/6/1985", "30303", "15 N St", "Atlanta", "GA"],
  ["Quinn", "Owens", "6/7/1986", "32801", "16 O St", "Orlando", "FL"],
  ["Rita", "Perez", "7/8/1987", "43215", "17 P St", "Columbus", "OH"],
];

function twentyRows(): string[][] {
  return [DUP_A, [...DUP_A], DUP_B, [...DUP_B], ...SINGLETONS];
}

function newGateway(): FakeSheetsGateway {
  const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: "r@x.com" });
  return g;
}

function loadGrid(g: FakeSheetsGateway, name: string, header: string[], rows: string[][]): void {
  g.loadSheet(name, { values: [header, ...rows] });
}

function runToEnd(g: FakeSheetsGateway, cfg: DedupConfig): ReturnType<typeof advanceScan> {
  let state = advanceScan(g, cfg);
  let guard = 0;
  while (state.status !== "READY" && state.status !== "FAILED" && guard++ < 100000) {
    state = advanceScan(g, cfg);
  }
  return state;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return isDedupError(err) ? err.code : `unexpected: ${String(err)}`;
  }
  return "no-throw";
}

function pendingCount(g: FakeSheetsGateway, batchId: string): number {
  return pairsRepository(g)
    .readByBatch(batchId)
    .filter((p) => p.scoreStatus === "PENDING").length;
}

function schemaFor(g: FakeSheetsGateway, batchId: string): SourceSchema {
  return batchesRepository(g).get(batchId)?.schema as unknown as SourceSchema;
}

function idBySourceRow(g: FakeSheetsGateway, batchId: string): Map<number, string> {
  const schema = schemaFor(g, batchId);
  return new Map(
    recordsRepository(g)
      .readByBatch(batchId, schema.headers)
      .map((r) => [r.sourceRowAtScan, r.dedupId]),
  );
}

function clusterForRows(g: FakeSheetsGateway, batchId: string, rows: number[]): string {
  const ids = rows.map((row) => idBySourceRow(g, batchId).get(row));
  const found = clustersRepository(g)
    .listByBatch(batchId)
    .find((cluster) => ids.every((id) => (cluster.memberIds as unknown as string[]).includes(id!)));
  if (!found) throw new Error(`No cluster for rows ${rows.join(",")}`);
  return String(found.clusterId);
}

function markKeepAll(g: FakeSheetsGateway, clusterId: string): void {
  clustersRepository(g).update(clusterId, { status: "KEEP_ALL", revision: 2 });
}

function markUnresolved(g: FakeSheetsGateway, clusterId: string): void {
  clustersRepository(g).update(clusterId, { status: "UNRESOLVED", revision: 2 });
}

function markReadyToApply(g: FakeSheetsGateway, batchId: string, clusterId: string): ClusterDecision {
  const row = clustersRepository(g).get(clusterId)!;
  const ids = row.memberIds as unknown as string[];
  const revision = 2;
  const decision: ClusterDecision = {
    batchId,
    clusterId,
    expectedRevision: revision,
    mode: "SELECT_RECORDS",
    retainedIds: [ids[0]!],
    deleteAssignments: { [ids[1]!]: ids[0]! },
    fieldChoices: {},
    notes: "carry me",
  };
  clustersRepository(g).update(clusterId, {
    status: "READY_TO_APPLY",
    revision,
    decision,
    decisionHash: decisionHash(decision),
    notes: decision.notes,
  });
  return decision;
}

describe("scan state machine", () => {
  it("advances a 20-row batch through every phase to READY with the expected clusters", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const start = startScan(g, PEOPLE, cfg);
    expect(start.status).toBe("READY");

    const final = runToEnd(g, cfg);
    expect(final.status).toBe("READY");
    expect(final.metrics.records).toBe(20);
    expect(final.metrics.clusters).toBe(2);

    const clusters = clustersRepository(g).listByBatch(start.batchId);
    expect(clusters).toHaveLength(2);
    for (const c of clusters) {
      expect(c.memberIds as unknown as string[]).toHaveLength(2);
    }

    // A SCAN_COMPLETED audit event is written.
    const done = auditRepository(g)
      .readAll()
      .filter((e) => e.eventType === "SCAN_COMPLETED");
    expect(done).toHaveLength(1);
  });

  it("stops at DUPLICATE_DEDUP_ID and produces no clusters when IDs collide (AT-30)", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    // Pre-existing _Dedup_ID column with a duplicated id.
    g.loadSheet(PEOPLE, {
      values: [
        ["_Dedup_ID", "First Name", "Last Name", "DOB", "ZIP"],
        ["dup", "Ann", "Lee", "1/1/1980", "01234"],
        ["dup", "Bob", "Kim", "2/2/1980", "02345"],
        ["keep", "Cara", "Ng", "3/3/1980", "03456"],
      ],
    });

    const start = startScan(g, PEOPLE, cfg);
    const final = start.status === "FAILED" ? start : runToEnd(g, cfg);

    expect(final.status).toBe("FAILED");
    expect(final.errorCode).toBe("DUPLICATE_DEDUP_ID");
    expect(clustersRepository(g).listByBatch(start.batchId)).toHaveLength(0);

    const failed = auditRepository(g)
      .readAll()
      .filter((e) => e.eventType === "SCAN_FAILED");
    expect(failed).toHaveLength(1);
  });

  it("resumes scoring across slices without rescoring completed pairs", () => {
    const cfg = cloneDefaultConfig();
    cfg.execution.inMemoryPairScoreMax = 0; // force durable pairs-sheet scoring path
    cfg.execution.pairScoreChunkSize = 1; // one pair per scoring unit
    cfg.execution.sheetWriteChunkSize = 1_000; // spill all pairs in one unit
    cfg.execution.sliceBudgetMs = 0; // one unit per advance — proves resume works
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const start = startScan(g, PEOPLE, cfg);
    expect(start.status).toBe("GENERATING_CANDIDATES");
    let state = advanceScan(g, cfg); // GENERATING_CANDIDATES -> SCORING
    expect(state.status).toBe("SCORING");

    const totalPairs = pairsRepository(g).readByBatch(start.batchId).length;
    expect(totalPairs).toBeGreaterThan(0);

    let slices = 0;
    while (state.status === "SCORING" && slices++ < totalPairs + 5) {
      const before = pendingCount(g, start.batchId);
      state = advanceScan(g, cfg);
      const after = pendingCount(g, start.batchId);
      // Each slice scores exactly one pending pair — never re-scores a completed one.
      expect(after).toBe(Math.max(0, before - 1));
    }

    // Chunked scoring reaches the same clustering outcome as a single-shot scan.
    if (state.status === "CLUSTERING") state = advanceScan(g, cfg);
    expect(state.status).toBe("READY");
    expect(state.metrics.clusters).toBe(2);
  });

  it("writes snapshot rows across resumable chunks", () => {
    const cfg = cloneDefaultConfig();
    cfg.execution.sheetWriteChunkSize = 5;
    cfg.execution.sliceBudgetMs = 0;
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    let state = startScan(g, PEOPLE, cfg);
    expect(state.status).toBe("SNAPSHOTTING");
    expect(state.metrics.records).toBe(5);

    let guard = 0;
    while (state.status === "SNAPSHOTTING" && guard++ < 20) {
      state = advanceScan(g, cfg);
    }
    expect(state.status).toBe("GENERATING_CANDIDATES");
    expect(state.metrics.records).toBe(20);
    expect(recordsRepository(g).readByBatch(state.batchId, HEADER).length).toBe(20);
  });

  it("spills candidate pairs across resumable chunks when over the in-memory cap", () => {
    const cfg = cloneDefaultConfig();
    cfg.execution.inMemoryPairScoreMax = 0;
    cfg.execution.sheetWriteChunkSize = 1;
    cfg.execution.sliceBudgetMs = 0;
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    let state = startScan(g, PEOPLE, cfg);
    while (state.status === "SNAPSHOTTING") state = advanceScan(g, cfg);
    expect(state.status).toBe("GENERATING_CANDIDATES");

    state = advanceScan(g, cfg);
    expect(state.status).toBe("GENERATING_CANDIDATES");
    expect(pairsRepository(g).readByBatch(state.batchId).length).toBe(1);

    let guard = 0;
    while (state.status === "GENERATING_CANDIDATES" && guard++ < 500) {
      state = advanceScan(g, cfg);
    }
    expect(state.status).toBe("SCORING");
    expect(pairsRepository(g).readByBatch(state.batchId).length).toBe(state.metrics.candidates);
  });

  it("fails clearly when the sheet exceeds maxParticipantRows", () => {
    const cfg = cloneDefaultConfig();
    cfg.execution.maxParticipantRows = 10;
    cfg.execution.sliceBudgetMs = 0;
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const state = startScan(g, PEOPLE, cfg);
    expect(state.status).toBe("FAILED");
    expect(state.errorCode).toBe("SHEET_TOO_LARGE");
  });

  it("finishes a small sheet inside startScan when slice budget remains", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const final = startScan(g, PEOPLE, cfg);
    expect(final.status).toBe("READY");
    expect(final.metrics.records).toBe(20);
    expect(final.metrics.clusters).toBe(2);
  });

  it("completes a 5,000-row fixture with candidate count under the cap (AT-27)", () => {
    const cfg = cloneDefaultConfig();
    cfg.execution.inMemoryPairScoreMax = 1_000_000; // score in a single slice for speed
    cfg.execution.sheetWriteChunkSize = 1_000; // fewer drain units in the fake gateway
    const g = newGateway();
    ensureSystemSheets(g, cfg);

    const fixture = generateFixture(1, 5000);
    const rows = fixture.rows.map((r) =>
      HEADERS.map((h) => (h === "_Dedup_ID" ? "" : r[h] ?? "")),
    );
    g.loadSheet(PEOPLE, { values: [[...HEADERS], ...rows] });

    const start = startScan(g, PEOPLE, cfg);
    const final = runToEnd(g, cfg);

    expect(final.status).toBe("READY");
    expect(final.metrics.records).toBe(5000);
    expect(final.metrics.candidates).toBeLessThan(cfg.blocking.maxTotalCandidates);
    expect(recordsRepository(g).readByBatch(start.batchId, [...HEADERS])).toHaveLength(5000);
  }, 120_000);

  it("starts a new scan from READY by superseding the previous batch", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const first = startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);

    const second = startScan(g, PEOPLE, cfg);
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.status).toBe("READY");
    expect(batchesRepository(g).get(first.batchId)?.status).toBe("SUPERSEDED");

    const final = runToEnd(g, cfg);
    expect(final.status).toBe("READY");
  });

  it("does no candidate work when an unchanged rescan has only finished keep-all clusters", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const first = startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);
    for (const row of clustersRepository(g).listByBatch(first.batchId)) {
      markKeepAll(g, String(row.clusterId));
    }

    const second = startScan(g, PEOPLE, cfg);
    const final = runToEnd(g, cfg);

    expect(final.batchId).toBe(second.batchId);
    expect(final.metrics.candidates).toBe(0);
    expect(final.metrics.clusters).toBe(0);
    expect(clustersRepository(g).listByBatch(second.batchId)).toHaveLength(0);
  });

  it("rescans a changed row while leaving unrelated keep-all clusters out", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const first = startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);
    markKeepAll(g, clusterForRows(g, first.batchId, [2, 3]));
    markReadyToApply(g, first.batchId, clusterForRows(g, first.batchId, [4, 5]));

    g.writeRange(PEOPLE, "E4", [["22 Edited Elm St"]]);

    const second = startScan(g, PEOPLE, cfg);
    const final = runToEnd(g, cfg);
    const clusters = clustersRepository(g).listByBatch(second.batchId);

    expect(final.metrics.candidates).toBeGreaterThan(0);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.status).toBe("UNREVIEWED");
    expect(clusters[0]?.memberIds as unknown as string[]).toEqual(
      expect.arrayContaining([
        idBySourceRow(g, second.batchId).get(4),
        idBySourceRow(g, second.batchId).get(5),
      ]),
    );
  });

  it("keeps unresolved cluster members dirty even when their rows are unchanged", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const first = startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);
    markKeepAll(g, clusterForRows(g, first.batchId, [2, 3]));
    markUnresolved(g, clusterForRows(g, first.batchId, [4, 5]));

    const second = startScan(g, PEOPLE, cfg);
    const final = runToEnd(g, cfg);
    const clusters = clustersRepository(g).listByBatch(second.batchId);

    expect(final.metrics.candidates).toBeGreaterThan(0);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.status).toBe("UNREVIEWED");
    expect(clusters[0]?.memberIds as unknown as string[]).toEqual(
      expect.arrayContaining([
        idBySourceRow(g, second.batchId).get(4),
        idBySourceRow(g, second.batchId).get(5),
      ]),
    );
  });

  it("carries unchanged ready-to-apply decisions into the new batch", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const first = startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);
    markKeepAll(g, clusterForRows(g, first.batchId, [2, 3]));
    const priorDecision = markReadyToApply(
      g,
      first.batchId,
      clusterForRows(g, first.batchId, [4, 5]),
    );

    const second = startScan(g, PEOPLE, cfg);
    const final = runToEnd(g, cfg);
    const [carried] = clustersRepository(g).listByBatch(second.batchId);
    const carriedDecision = carried?.decision as unknown as ClusterDecision;

    expect(final.metrics.candidates).toBe(0);
    expect(final.metrics.clusters).toBe(1);
    expect(carried?.status).toBe("READY_TO_APPLY");
    expect(carried?.clusterId).not.toBe(priorDecision.clusterId);
    expect(carriedDecision.batchId).toBe(second.batchId);
    expect(carriedDecision.clusterId).toBe(carried?.clusterId);
    expect(carriedDecision.expectedRevision).toBe(carried?.revision);
    expect(carriedDecision.notes).toBe("carry me");
    expect(String(carried?.decisionHash)).toBe(decisionHash(carriedDecision));
  });

  it("never writes participant values — only the _Dedup_ID column changes", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    const rows = twentyRows();
    loadGrid(g, PEOPLE, HEADER, rows);

    startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);

    // Columns A..G (participant values) are byte-for-byte unchanged.
    const width = HEADER.length; // 7
    const lastCol = String.fromCharCode(65 + width - 1); // "G"
    const after = g.readRange(PEOPLE, `A1:${lastCol}${rows.length + 1}`);
    expect(after[0]).toEqual(HEADER);
    for (let i = 0; i < rows.length; i++) {
      expect(after[i + 1]).toEqual(rows[i]);
    }

    // The scan created and populated the _Dedup_ID column (H) for every row.
    const ids = g.readRange(PEOPLE, `H2:H${rows.length + 1}`).map((r) => r[0]);
    expect(ids.every((v) => typeof v === "string" && v !== "")).toBe(true);
  });

  it("attributes its audit events to the acting identity (§8.7, §21.3)", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);

    // Every row a scan files, id assignments included — not just the SCAN_* ones.
    const events = auditRepository(g).readAll();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(String(event.actorId)).toBe("r@x.com");
      expect(String(event.actorType)).toBe("EMAIL");
      expect(String(event.sourceSheetName)).toBe(PEOPLE);
    }
  });

  it("refuses to scan for a caller it cannot name", () => {
    const cfg = cloneDefaultConfig();
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: null });
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    let thrown: unknown;
    try {
      startScan(g, PEOPLE, cfg);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code: string }).code).toBe("MISSING_REVIEWER_IDENTITY");
    // The refusal came before the lock, so nothing was written.
    expect(auditRepository(g).readAll()).toHaveLength(0);
    expect(g.readRange(PEOPLE, "A1:G1")[0]).toEqual(HEADER);

    const named = startScan(g, PEOPLE, cfg, "Dana");
    expect(named.batchId).not.toBe("");
    const started = auditRepository(g).readAll()[0]!;
    expect(String(started.actorId)).toBe("Dana");
    expect(String(started.actorType)).toBe("FALLBACK_NAME");
  });

  it("cancels a finished scan, discarding working rows but keeping the audit (§20.6)", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    const rows = twentyRows();
    loadGrid(g, PEOPLE, HEADER, rows);

    const start = startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);
    const auditBefore = auditRepository(g).readAll().length;

    const cancelled = cancelScan(g, cfg);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.metrics.clusters).toBe(0);

    // Working state is gone; the batch row itself survives as the record of it.
    expect(recordsRepository(g).readByBatch(start.batchId, HEADER)).toHaveLength(0);
    expect(pairsRepository(g).readByBatch(start.batchId)).toHaveLength(0);
    expect(clustersRepository(g).listByBatch(start.batchId)).toHaveLength(0);
    expect(batchesRepository(g).get(start.batchId)?.status).toBe("CANCELLED");

    // Audit is retained and gains one attributed cancel event.
    const events = auditRepository(g).readAll();
    expect(events).toHaveLength(auditBefore + 1);
    const cancelEvent = events[events.length - 1]!;
    expect(String(cancelEvent.eventType)).toBe("SCAN_CANCELLED");
    expect(String(cancelEvent.actorId)).toBe("r@x.com");
    expect(String(cancelEvent.batchId)).toBe(start.batchId);

    // Participant values and their assigned ids are untouched by a cancel.
    const after = g.readRange(PEOPLE, `A1:G${rows.length + 1}`);
    expect(after[0]).toEqual(HEADER);
    for (let i = 0; i < rows.length; i++) expect(after[i + 1]).toEqual(rows[i]);
    const ids = g.readRange(PEOPLE, `H2:H${rows.length + 1}`).map((r) => r[0]);
    expect(ids.every((v) => typeof v === "string" && v !== "")).toBe(true);
  });

  it("releases the workbook so a fresh scan can start after a cancel", () => {
    const cfg = cloneDefaultConfig();
    cfg.execution.sliceBudgetMs = 0; // leave the first scan mid-flight
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const first = startScan(g, PEOPLE, cfg);
    expect(first.status).not.toBe("READY");
    cancelScan(g, cfg);

    cfg.execution.sliceBudgetMs = 25_000;
    const second = startScan(g, PEOPLE, cfg);
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.status).toBe("READY");
    // The cancelled batch's rows did not leak into the new one.
    expect(clustersRepository(g).listByBatch(first.batchId)).toHaveLength(0);
    expect(clustersRepository(g).listByBatch(second.batchId)).toHaveLength(2);
  });

  it("refuses to cancel with no active batch, or once an apply is under way", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    expect(codeOf(() => cancelScan(g, cfg))).toBe("BATCH_STATE_CONFLICT");

    const start = startScan(g, PEOPLE, cfg);
    runToEnd(g, cfg);
    batchesRepository(g).update(start.batchId, { status: "APPLYING" });

    expect(codeOf(() => cancelScan(g, cfg))).toBe("BATCH_STATE_CONFLICT");
    // The refusal came before any deletion: the apply still has its snapshots.
    expect(recordsRepository(g).readByBatch(start.batchId, HEADER)).toHaveLength(20);
    expect(clustersRepository(g).listByBatch(start.batchId)).toHaveLength(2);
  });

  it("requires an identity before it will cancel", () => {
    const cfg = cloneDefaultConfig();
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: null });
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());
    const start = startScan(g, PEOPLE, cfg, "Dana");

    expect(codeOf(() => cancelScan(g, cfg))).toBe("MISSING_REVIEWER_IDENTITY");
    expect(batchesRepository(g).get(start.batchId)?.status).not.toBe("CANCELLED");

    expect(cancelScan(g, cfg, "Dana").status).toBe("CANCELLED");
    const events = auditRepository(g).readAll();
    expect(String(events[events.length - 1]!.actorType)).toBe("FALLBACK_NAME");
  });

  it("throws BATCH_STATE_CONFLICT when advancing with no active batch", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    let thrown: unknown;
    try {
      advanceScan(g, cfg);
    } catch (e) {
      thrown = e;
    }
    expect(isDedupError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("BATCH_STATE_CONFLICT");
  });
});
