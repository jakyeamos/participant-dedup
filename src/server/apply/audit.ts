import { newEventId } from "@/server/auditRepository";
import type { MergePlan } from "@/server/review/mergePlan";
import type { RecordSnapshot } from "@/server/types";

export type AuditRow = Record<string, unknown>;

export interface AuditContext {
  batchId: string;
  applyBatchId: string;
  /** Acting account, normally the reviewer's email. */
  actorId: string;
  reviewerId: string;
  sourceSheetId: number;
  sourceSheetName: string;
  eventAt: string;
}

/** The recovery record for a deleted participant row (§25.4). */
export interface DeletedRowSnapshot {
  dedupId: string;
  row: number;
  values: string[];
}

function base(ctx: AuditContext, eventType: string): AuditRow {
  return {
    eventId: newEventId(),
    eventType,
    eventAt: ctx.eventAt,
    actorId: ctx.actorId,
    actorType: "USER",
    reviewerId: ctx.reviewerId,
    batchId: ctx.batchId,
    applyBatchId: ctx.applyBatchId,
    sourceSheetId: ctx.sourceSheetId,
    sourceSheetName: ctx.sourceSheetName,
    result: "OK",
  };
}

/**
 * §25.4 Every source-changing event of one apply, as rows for a single
 * `AppendCellsRequest`. Deletion events carry the whole row so a reviewer can
 * restore a participant by hand — the apply never keeps a full-sheet backup.
 * Pure: the caller supplies the timestamp and the reviewer identity.
 */
export function composeAuditRows(
  ctx: AuditContext,
  plans: MergePlan[],
  recordsById: Map<string, RecordSnapshot>,
  rowByDedupId: Map<string, number>,
): AuditRow[] {
  const rows: AuditRow[] = [];

  for (const plan of plans) {
    for (const fill of plan.fills) {
      rows.push({
        ...base(ctx, "FIELD_FILLED"),
        clusterId: plan.clusterId,
        targetDedupId: fill.retainedId,
        relatedIds: [fill.sourceId],
        fieldName: fill.header,
        beforeValue: "",
        afterValue: fill.value,
      });
    }

    for (const deletion of plan.deletions) {
      const record = recordsById.get(deletion.deletedId);
      const snapshot: DeletedRowSnapshot = {
        dedupId: deletion.deletedId,
        row: rowByDedupId.get(deletion.deletedId) ?? 0,
        values: record ? [...record.displayValues] : [],
      };
      rows.push({
        ...base(ctx, "ROW_DELETED"),
        clusterId: plan.clusterId,
        targetDedupId: deletion.deletedId,
        relatedIds: [deletion.retainedId],
        rowSnapshot: snapshot,
      });
    }

    rows.push({
      ...base(ctx, "CLUSTER_APPLIED"),
      clusterId: plan.clusterId,
      targetDedupId: plan.retainedIds[0] ?? "",
      relatedIds: plan.deletions.map((d) => d.deletedId),
    });
  }

  rows.push({
    ...base(ctx, "APPLY_COMPLETED"),
    relatedIds: plans.map((p) => p.clusterId),
  });

  return rows;
}
