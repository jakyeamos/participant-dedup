import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { ClusterDecision, RecordSnapshot, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import { DedupError } from "@/server/errors";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { buildMergePlan } from "@/server/review/mergePlan";
import { clusterFromRow } from "@/server/review/clusterRow";

/** §23.1 What the reviewer sees before deciding whether to apply. */
export interface BatchSummary {
  batchId: string;
  sourceSheetName: string;
  totalClusters: number;
  readyToApplyClusters: number;
  keepAllClusters: number;
  unresolvedClusters: number;
  staleClusters: number;
  appliedClusters: number;
  /** Rows that survive in each ready cluster. */
  rowsToRetain: number;
  /** Rows a confirmed apply would permanently delete. */
  rowsToDelete: number;
  blankFieldsToFill: number;
  /** Fills the reviewer chose by hand rather than the single obvious value. */
  manualConflictChoices: number;
  candidateTruncation: boolean;
  candidateTruncationCount: number;
  reviewerIds: string[];
}

function decisionOf(value: unknown): ClusterDecision | null {
  return value && typeof value === "object" ? (value as ClusterDecision) : null;
}

/** Fills the reviewer resolved explicitly, rather than accepting the lone value. */
function manualChoicesIn(decision: ClusterDecision): number {
  let count = 0;
  for (const byHeader of Object.values(decision.fieldChoices)) {
    for (const choice of Object.values(byHeader)) {
      if (choice.mode !== "AUTO") count += 1;
    }
  }
  return count;
}

/**
 * §23.1 Summarizes a batch from its stored decisions. Plans are recomputed from
 * the scan snapshots so the counts describe the same work the apply would do;
 * nothing here is taken from the client, and nothing is written.
 */
export function getBatchSummary(
  gateway: SheetsGateway,
  batchId: string,
  cfg: DedupConfig,
): BatchSummary {
  const batch = batchesRepository(gateway).get(batchId);
  if (!batch) throw new DedupError("BATCH_NOT_FOUND");

  const schema = batch.schema as unknown as SourceSchema;
  const records: RecordSnapshot[] = recordsRepository(gateway).readByBatch(
    batchId,
    schema.headers,
  );

  const summary: BatchSummary = {
    batchId,
    sourceSheetName: String(batch.sourceSheetName ?? ""),
    totalClusters: 0,
    readyToApplyClusters: 0,
    keepAllClusters: 0,
    unresolvedClusters: 0,
    staleClusters: 0,
    appliedClusters: 0,
    rowsToRetain: 0,
    rowsToDelete: 0,
    blankFieldsToFill: 0,
    manualConflictChoices: 0,
    candidateTruncation: Number(batch.candidateTruncationCount ?? 0) > 0,
    candidateTruncationCount: Number(batch.candidateTruncationCount ?? 0),
    reviewerIds: [],
  };

  const reviewers = new Set<string>();
  for (const row of clustersRepository(gateway).listByBatch(batchId)) {
    summary.totalClusters += 1;
    const reviewer = String(row.reviewerId ?? "");
    if (reviewer !== "") reviewers.add(reviewer);

    switch (String(row.status)) {
      case "KEEP_ALL":
        summary.keepAllClusters += 1;
        continue;
      case "UNRESOLVED":
        summary.unresolvedClusters += 1;
        continue;
      case "STALE":
        summary.staleClusters += 1;
        continue;
      case "APPLIED":
        summary.appliedClusters += 1;
        continue;
      case "READY_TO_APPLY":
        break;
      default:
        continue;
    }

    const decision = decisionOf(row.decision);
    if (!decision) continue;

    const plan = buildMergePlan(clusterFromRow(row), decision, records, schema, cfg);
    // A ready row whose plan no longer holds is counted as unresolved rather
    // than quietly inflating the deletion count the reviewer is about to confirm.
    if (!plan.ok) {
      summary.unresolvedClusters += 1;
      continue;
    }

    summary.readyToApplyClusters += 1;
    summary.rowsToRetain += plan.retainedIds.length;
    summary.rowsToDelete += plan.deletions.length;
    summary.blankFieldsToFill += plan.fills.length;
    summary.manualConflictChoices += manualChoicesIn(decision);
  }

  summary.reviewerIds = [...reviewers].sort();
  return summary;
}
