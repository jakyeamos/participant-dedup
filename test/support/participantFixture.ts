import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { advanceScan, startScan } from "@/server/scan/scanStateMachine";
import type { SourceSchema } from "@/server/types";
import { cloneDefaultConfig, type DedupConfig } from "@/shared/config";

/**
 * The shared synthetic participant sheet. Every name here is invented; no real
 * participant data ever enters the repository (§31).
 */
export const PEOPLE = "Participants";

export const HEADER = [
  "First Name",
  "Last Name",
  "DOB",
  "ZIP",
  "Address",
  "City",
  "State",
  "Notes",
];

/** Zero-based index of the Notes column — the only auto-fillable field here. */
export const NOTES_COL = 7;

// Three identical Anns (a three-member core cluster whose Notes column is blank
// on the first row and different on the other two — an auto-fill conflict), two
// identical Bobs, and four distinct singletons.
export const ROWS: string[][] = [
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

export interface Harness {
  g: FakeSheetsGateway;
  cfg: DedupConfig;
  batchId: string;
  schema: SourceSchema;
  /** Participant ids keyed by their 1-based sheet row. */
  idByRow: Map<number, string>;
  annClusterId: string;
  bobClusterId: string;
}

export function runToEnd(g: FakeSheetsGateway, cfg: DedupConfig): void {
  let state = advanceScan(g, cfg);
  let guard = 0;
  while (state.status !== "READY" && state.status !== "FAILED" && guard++ < 10_000) {
    state = advanceScan(g, cfg);
  }
  if (state.status !== "READY") throw new Error(`scan ended ${state.status}`);
}

/** Loads the fixture sheet and runs a full scan, leaving a READY batch. */
export function harness(email: string | null = "r@x.com"): Harness {
  const cfg = cloneDefaultConfig();
  const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: email });
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
