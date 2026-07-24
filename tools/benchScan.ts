/**
 * Speed dogfood for the Railway-style in-memory scan path (FakeSheetsGateway).
 *
 *   pnpm exec tsx tools/benchScan.ts
 */
import { performance } from "node:perf_hooks";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { cloneDefaultConfig } from "@/shared/config";
import { remoteConfig, runScanOnGateway } from "../services/api/src/scanJobs";
import { HEADERS, generateFixture } from "./generateFixture";
import { SYSTEM_SHEET_PREFIX } from "@/shared/constants";

const SHEET = "Participants";

function bench(rows: number): {
  rows: number;
  ms: number;
  records: number;
  candidates: number;
  clusters: number;
  warnings: string;
  status: string;
  sheetsTouched: number;
} {
  const cfg = remoteConfig(cloneDefaultConfig());
  const fixture = generateFixture(42, rows);
  const g = new FakeSheetsGateway({
    spreadsheetId: `bench-${rows}`,
    activeUserEmail: "bench@test",
    activeSheetName: SHEET,
  });
  // Simulate a multi-tab workbook: only source + system sheets should matter.
  ensureSystemSheets(g, cfg);
  g.loadSheet("Unrelated Tab", {
    values: [["A"], ...Array.from({ length: 500 }, () => ["noise"])],
  });
  g.loadSheet(SHEET, {
    values: [
      [...HEADERS],
      ...fixture.rows.map((r) => HEADERS.map((h) => (h === "_Dedup_ID" ? "" : r[h] ?? ""))),
    ],
  });

  const t0 = performance.now();
  const state = runScanOnGateway(g, SHEET, cfg);
  const ms = performance.now() - t0;
  const sheetsTouched = g
    .dumpSheets()
    .filter((s) => s.info.title === SHEET || s.info.title.startsWith(SYSTEM_SHEET_PREFIX)).length;

  return {
    rows,
    ms: Math.round(ms),
    records: state.metrics.records,
    candidates: state.metrics.candidates,
    clusters: state.metrics.clusters,
    warnings: state.warnings.join(",") || "-",
    status: state.status,
    sheetsTouched,
  };
}

const sizes = [200, 500, 1000, 3000, 5000];
console.log("Remote-tuned in-memory scan bench (no Google I/O)\n");
console.log(
  ["rows", "ms", "records", "cands", "clusters", "warn", "sheets", "status"]
    .map((h) => h.padStart(10))
    .join(" "),
);
for (const n of sizes) {
  const r = bench(n);
  console.log(
    [r.rows, r.ms, r.records, r.candidates, r.clusters, r.warnings, r.sheetsTouched, r.status]
      .map((v) => String(v).padStart(10))
      .join(" "),
  );
}
