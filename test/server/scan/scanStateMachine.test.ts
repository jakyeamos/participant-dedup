import { describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { clustersRepository } from "@/server/clustersRepository";
import { pairsRepository } from "@/server/pairsRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { auditRepository } from "@/server/auditRepository";
import { advanceScan, startScan } from "@/server/scan/scanStateMachine";
import { cloneDefaultConfig, type DedupConfig } from "@/shared/config";
import { isDedupError } from "@/server/errors";
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

function pendingCount(g: FakeSheetsGateway, batchId: string): number {
  return pairsRepository(g)
    .readByBatch(batchId)
    .filter((p) => p.scoreStatus === "PENDING").length;
}

describe("scan state machine", () => {
  it("advances a 20-row batch through every phase to READY with the expected clusters", () => {
    const cfg = cloneDefaultConfig();
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const start = startScan(g, PEOPLE, cfg);
    expect(start.status).toBe("SNAPSHOTTING");

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
    const final = runToEnd(g, cfg);

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
    cfg.execution.pairScoreChunkSize = 1; // one pair per scoring slice
    const g = newGateway();
    ensureSystemSheets(g, cfg);
    loadGrid(g, PEOPLE, HEADER, twentyRows());

    const start = startScan(g, PEOPLE, cfg);
    let state = advanceScan(g, cfg); // SNAPSHOTTING -> GENERATING_CANDIDATES
    expect(state.status).toBe("GENERATING_CANDIDATES");
    state = advanceScan(g, cfg); // GENERATING_CANDIDATES -> SCORING
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

  it("completes a 5,000-row fixture with candidate count under the cap (AT-27)", () => {
    const cfg = cloneDefaultConfig();
    cfg.execution.pairScoreChunkSize = 1_000_000; // score in a single slice for speed
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
