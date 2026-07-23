import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { ClusterDecision, RecordSnapshot } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import { DedupError } from "@/server/errors";
import { resolveReviewer } from "@/server/identity";
import { SYSTEM_SHEETS } from "@/shared/constants";
import { CLUSTER_FIELDS, encodeRow, nowIso, tableFor } from "@/server/systemSheets";
import { composeAuditRows } from "@/server/apply/audit";
import { buildAtomicRequest, type SystemRowUpdate } from "@/server/apply/atomicRequest";
import { preflight, type ApplyChallenge } from "@/server/apply/preflight";

const APPLY_LOCK_TIMEOUT_MS = 30_000;

export interface ApplyResult {
  /** Ties every audit row and cluster row of this run together (§26.2). */
  applyBatchId: string;
  deletedRows: number;
  filledFields: number;
  auditWritten: number;
}

function sheetIdOf(gateway: SheetsGateway, sheetName: string): number {
  const info = gateway.getSheetByName(sheetName);
  if (!info) throw new DedupError("INTERNAL");
  return info.sheetId;
}

function columnIndexByHeader(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((header, index) => {
    if (header !== "" && !(header in map)) map[header] = index;
  });
  return map;
}

/**
 * §26.2 Stamps each applied cluster with the run that applied it. The row is
 * rewritten whole rather than patched: the write rides in the atomic request, so
 * it cannot go through the repository's own writer.
 *
 * `revision` is deliberately left alone. Preflight matches a decision against the
 * revision it was saved at, so bumping it here would turn AT-26's harmless replay
 * into a REVISION_CONFLICT.
 */
function clusterStatusUpdates(
  gateway: SheetsGateway,
  clusterIds: string[],
  applyBatchId: string,
  appliedAt: string,
): SystemRowUpdate[] {
  if (clusterIds.length === 0) return [];
  const sheetId = sheetIdOf(gateway, SYSTEM_SHEETS.clusters);
  const wanted = new Set(clusterIds);

  return tableFor(gateway, SYSTEM_SHEETS.clusters)
    .rowsWithIndex()
    .filter((r) => wanted.has(String(r.rec.clusterId)))
    .map((r) => ({
      sheetId,
      rowIndex: r.index,
      cells: encodeRow(CLUSTER_FIELDS, {
        ...r.rec,
        status: "APPLIED",
        applyBatchId,
        appliedAt,
      }),
    }));
}

/**
 * §24–§26 Performs a confirmed apply. One document lock spans preflight and the
 * write, so nothing can change between the last check and the deletion, and the
 * whole apply reaches the sheet as a single `batchUpdate` — see
 * `buildAtomicRequest`. Any failure throws before the sheet is touched.
 */
export function applyDecisions(
  gateway: SheetsGateway,
  batchId: string,
  decisions: ClusterDecision[],
  challenge: ApplyChallenge,
  cfg: DedupConfig,
): ApplyResult {
  const reviewer = resolveReviewer(gateway, decisions[0]?.fallbackReviewerName);
  const applyBatchId = `apply_${gateway.newUuid()}`;

  const lock = gateway.getDocumentLock();
  lock.acquire(APPLY_LOCK_TIMEOUT_MS);
  try {
    const result = preflight(gateway, batchId, decisions, challenge, cfg);

    // AT-26: an interrupted run's clusters are already applied, so there is
    // nothing left to write. Returning here keeps a replay a true no-op.
    if (result.plans.length === 0) {
      return { applyBatchId, deletedRows: 0, filledFields: 0, auditWritten: 0 };
    }

    const eventAt = nowIso(gateway);
    const recordsById = new Map<string, RecordSnapshot>(
      result.records.map((r) => [r.dedupId, r]),
    );
    const rowByDedupId = new Map(Object.entries(result.rowByDedupId));

    const auditRows = composeAuditRows(
      {
        batchId,
        applyBatchId,
        actorId: reviewer.email ?? reviewer.display,
        reviewerId: reviewer.email ?? reviewer.display,
        sourceSheetId: result.schema.sheetId,
        sourceSheetName: result.schema.sheetName,
        eventAt,
      },
      result.plans,
      recordsById,
      rowByDedupId,
    );

    const request = buildAtomicRequest(
      {
        sourceSheetId: result.schema.sheetId,
        columnIndexByHeader: columnIndexByHeader(result.schema.headers),
        rowByDedupId: result.rowByDedupId,
        plans: result.plans,
        auditSheetId: sheetIdOf(gateway, SYSTEM_SHEETS.audit),
        auditRows,
        statusUpdates: clusterStatusUpdates(
          gateway,
          result.plans.map((p) => p.clusterId),
          applyBatchId,
          eventAt,
        ),
      },
      cfg,
    );

    gateway.batchUpdate(request);

    return {
      applyBatchId,
      deletedRows: result.deletionRowCount,
      filledFields: result.plans.reduce((n, p) => n + p.fills.length, 0),
      auditWritten: auditRows.length,
    };
  } finally {
    lock.release();
  }
}
