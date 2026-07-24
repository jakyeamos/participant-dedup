/**
 * End-to-end dogfood against a synthetic CSV loaded into FakeSheetsGateway.
 *
 * This is the live-sheet rehearsal: same scan → queue → (optional) apply path
 * the sidebar drives, without needing Google auth. Use it to judge usefulness
 * before clasp push.
 *
 *   pnpm exec tsx tools/sheetDogfood.ts [csvPath] [groundTruthJson?]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { cloneDefaultConfig } from "@/shared/config";
import { advanceScan, startScan } from "@/server/scan/scanStateMachine";
import { getQueuePage } from "@/server/review/queue";
import { getClusterDetail } from "@/server/review/clusterDetail";
import { saveClusterDecision } from "@/server/review/decisions";
import { getBatchSummary } from "@/server/review/summary";
import { createApplyChallenge } from "@/server/apply/preflight";
import { applyDecisions } from "@/server/apply/applyDecisions";
import { clustersRepository } from "@/server/clustersRepository";
import type { ClusterDecision } from "@/server/types";
import type { GroundTruthGroup } from "./generateFixture";

const SHEET = "Participants";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function runToReady(g: FakeSheetsGateway, cfg: ReturnType<typeof cloneDefaultConfig>): void {
  let state = advanceScan(g, cfg);
  let guard = 0;
  while (state.status !== "READY" && state.status !== "FAILED" && guard++ < 200_000) {
    state = advanceScan(g, cfg);
  }
  if (state.status !== "READY") {
    throw new Error(`scan ended ${state.status}${state.errorCode ? ` (${state.errorCode})` : ""}`);
  }
}

function main(): void {
  const csvPath = resolve(process.argv[2] ?? "tools/out/uat-participants-80.csv");
  const truthPath = process.argv[3] ? resolve(process.argv[3]) : null;
  const grid = parseCsv(readFileSync(csvPath, "utf8"));
  if (grid.length < 2) throw new Error(`empty fixture: ${csvPath}`);

  const cfg = cloneDefaultConfig();
  const g = new FakeSheetsGateway({
    spreadsheetId: "dogfood-sheet",
    activeUserEmail: "reviewer@example.com",
  });
  ensureSystemSheets(g, cfg);
  g.loadSheet(SHEET, { values: grid });
  g.setActiveSheet(SHEET);

  const started = startScan(g, SHEET, cfg);
  const t0 = Date.now();
  runToReady(g, cfg);
  const elapsedMs = Date.now() - t0;

  const queue = getQueuePage(
    g,
    {
      batchId: started.batchId,
      confidence: ["HIGH", "MEDIUM"],
      statuses: ["UNREVIEWED", "IN_PROGRESS"],
      pageSize: 50,
    },
    cfg,
  );

  const lines: string[] = [
    `Sheet dogfood — ${csvPath}`,
    `  rows:           ${grid.length - 1}`,
    `  batchId:        ${started.batchId}`,
    `  scanMs:         ${elapsedMs}`,
    `  clusters total: ${queue.counts.total}`,
    `  readyToApply:   ${queue.counts.readyToApply}`,
    `  queue (H+M):    ${queue.filteredCount} shown of ${queue.counts.total}`,
    `  byConfidence:   ${JSON.stringify(queue.counts.byConfidence)}`,
  ];

  for (const item of queue.items.slice(0, 8)) {
    lines.push(
      `  - ${item.confidence} ${item.score.toFixed(2)} ${item.label} ` +
        `(${item.memberCount} records, row ${item.firstSourceRow})`,
    );
  }
  if (queue.items.length > 8) lines.push(`  … ${queue.items.length - 8} more on first page`);

  if (truthPath) {
    const truth = JSON.parse(readFileSync(truthPath, "utf8")) as GroundTruthGroup[];
    const positive = truth.filter((g) =>
      ["EXACT", "SWAPPED", "TYPO", "PLACEHOLDER_DOB", "CHANGED_ZIP", "TRANSITIVE"].includes(g.kind),
    );
    lines.push(`  groundTruth+:   ${positive.length} positive groups in fixture`);
  }

  // Exercise one HIGH (or first) cluster through save → apply so the destructive
  // path is rehearsed on synthetic data before a live workbook ever sees it.
  const target = queue.items.find((i) => i.confidence === "HIGH") ?? queue.items[0];
  if (target) {
    const detail = getClusterDetail(g, started.batchId, target.clusterId, cfg);
    const retained = detail.records[0]!.dedupId;
    const deleted = detail.records.slice(1).map((r) => r.dedupId);
    const decision: ClusterDecision = {
      batchId: started.batchId,
      clusterId: target.clusterId,
      expectedRevision: detail.revision,
      mode: "SELECT_RECORDS",
      retainedIds: [retained],
      deleteAssignments: Object.fromEntries(deleted.map((id) => [id, retained])),
      fieldChoices: {},
      notes: "sheet-dogfood rehearsal",
    };
    const saved = saveClusterDecision(g, decision, cfg);
    lines.push(
      `  rehearsal save: ${saved.status} revision=${saved.revision} ` +
        `(kept ${retained}, delete ${deleted.length})`,
    );

    const summary = getBatchSummary(g, started.batchId, cfg);
    const decisions = clustersRepository(g)
      .listByBatch(started.batchId)
      .filter((row) => String(row.status) === "READY_TO_APPLY")
      .map((row) => row.decision as unknown as ClusterDecision)
      .filter(Boolean);

    if (decisions.length > 0 && summary.rowsToDelete > 0) {
      const challenge = createApplyChallenge(g, started.batchId, decisions, cfg);
      const result = applyDecisions(
        g,
        started.batchId,
        decisions,
        { token: challenge.token, summaryHash: challenge.summaryHash, confirmed: true },
        cfg,
      );
      lines.push(
        `  rehearsal apply: deleted=${result.deletedRows} filled=${result.filledFields} ` +
          `audit=${result.auditWritten}`,
      );
    } else {
      lines.push("  rehearsal apply: skipped (no READY_TO_APPLY deletions)");
    }
  } else {
    lines.push("  rehearsal: no queue items — engine found no reviewable clusters");
  }

  process.stdout.write(lines.join("\n") + "\n");
}

main();
