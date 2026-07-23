import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { ClusterRecord } from "@/server/clustersRepository";
import type { RecordSnapshot, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import type { ClusterStatus, ClusterType, Confidence, Warning } from "@/shared/constants";
import { CLUSTER_STATUSES, CONFIDENCE_LEVELS } from "@/shared/constants";
import { DedupError } from "@/server/errors";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";

/** One row of the queue list. Carries no field values beyond the display name. */
export interface QueueItem {
  clusterId: string;
  clusterType: ClusterType;
  confidence: Confidence;
  score: number;
  status: ClusterStatus;
  /** Displayed members: core plus suggested. */
  memberCount: number;
  suggestedCount: number;
  warnings: Warning[];
  /** Sheet row of the earliest member at scan time — the queue's tiebreak. */
  firstSourceRow: number;
  label: string;
  reviewerId: string;
  reviewedAt: string;
}

export interface QueueCounts {
  total: number;
  byConfidence: Record<Confidence, number>;
  byStatus: Record<ClusterStatus, number>;
  /** Clusters a confirmed apply would act on. */
  readyToApply: number;
}

export interface QueuePageRequest {
  batchId: string;
  confidence?: Confidence[];
  statuses?: ClusterStatus[];
  /** The clusterId the previous page ended on. */
  cursor?: string | null;
  pageSize?: number;
}

export interface QueuePage {
  items: QueueItem[];
  nextCursor: string | null;
  /** Whole-batch counts, unaffected by the active filter. */
  counts: QueueCounts;
  /** How many clusters the active filter matches. */
  filteredCount: number;
}

/** §18.4 High before Medium before Low. */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  EXCLUDED: 3,
};

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function emptyCounts(): QueueCounts {
  const byConfidence = {} as Record<Confidence, number>;
  for (const c of CONFIDENCE_LEVELS) byConfidence[c] = 0;
  const byStatus = {} as Record<ClusterStatus, number>;
  for (const s of CLUSTER_STATUSES) byStatus[s] = 0;
  return { total: 0, byConfidence, byStatus, readyToApply: 0 };
}

/** Name for the queue row, taken from the record's canonical name columns. */
function labelOf(record: RecordSnapshot | undefined, schema: SourceSchema): string {
  if (!record) return "";
  const parts: string[] = [];
  for (const field of ["first", "last"] as const) {
    const col = schema.columnByCanonicalField[field];
    const value = col === undefined ? "" : (record.displayValues[col] ?? "");
    if (value.trim() !== "") parts.push(value.trim());
  }
  return parts.join(" ");
}

function toItem(
  row: ClusterRecord,
  byId: Map<string, RecordSnapshot>,
  schema: SourceSchema,
): QueueItem {
  const memberIds = asStrings(row.memberIds);
  const suggestedMemberIds = asStrings(row.suggestedMemberIds);
  const displayed = [...memberIds, ...suggestedMemberIds];

  let earliest: RecordSnapshot | undefined;
  for (const id of displayed) {
    const rec = byId.get(id);
    if (rec && (!earliest || rec.sourceRowAtScan < earliest.sourceRowAtScan)) earliest = rec;
  }

  return {
    clusterId: String(row.clusterId),
    clusterType: String(row.clusterType) as ClusterType,
    confidence: String(row.highestConfidence ?? "LOW") as Confidence,
    score: Number(row.maxScore ?? 0),
    status: String(row.status) as ClusterStatus,
    memberCount: displayed.length,
    suggestedCount: suggestedMemberIds.length,
    warnings: asStrings(row.warnings) as Warning[],
    firstSourceRow: earliest?.sourceRowAtScan ?? Number.MAX_SAFE_INTEGER,
    label: labelOf(earliest, schema),
    reviewerId: String(row.reviewerId ?? ""),
    reviewedAt: String(row.reviewedAt ?? ""),
  };
}

/** §18.4 confidence, then score descending, then earliest source row ascending. */
function compare(a: QueueItem, b: QueueItem): number {
  const rank = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  if (rank !== 0) return rank;
  if (a.score !== b.score) return b.score - a.score;
  if (a.firstSourceRow !== b.firstSourceRow) return a.firstSourceRow - b.firstSourceRow;
  return a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0;
}

/**
 * §21.5 One page of the review queue. Ordering is total, so the cursor is just
 * the clusterId the previous page ended on: a cursor that no longer resolves
 * restarts at the top rather than stranding the reviewer on an empty page.
 */
export function getQueuePage(
  gateway: SheetsGateway,
  request: QueuePageRequest,
  cfg: DedupConfig,
): QueuePage {
  const batch = batchesRepository(gateway).get(request.batchId);
  if (!batch) throw new DedupError("BATCH_NOT_FOUND");

  const schema = batch.schema as unknown as SourceSchema;
  const byId = new Map(
    recordsRepository(gateway)
      .readByBatch(request.batchId, schema.headers)
      .map((r) => [r.dedupId, r]),
  );

  const counts = emptyCounts();
  const all: QueueItem[] = [];
  for (const row of clustersRepository(gateway).listByBatch(request.batchId)) {
    const item = toItem(row, byId, schema);
    all.push(item);
    counts.total += 1;
    counts.byConfidence[item.confidence] += 1;
    counts.byStatus[item.status] += 1;
    if (item.status === "READY_TO_APPLY") counts.readyToApply += 1;
  }

  const wantedConfidence = request.confidence;
  const wantedStatuses = request.statuses;
  const matching = all
    .filter((i) => !wantedConfidence || wantedConfidence.includes(i.confidence))
    .filter((i) => !wantedStatuses || wantedStatuses.includes(i.status))
    .sort(compare);

  // A missing, zero, or nonsense page size falls back to the configured one.
  const maxSize = cfg.execution.queuePageSize;
  const requested = Number(request.pageSize);
  const pageSize = requested > 0 ? Math.min(requested, maxSize) : maxSize;

  const cursor = request.cursor ?? null;
  const at = cursor === null ? -1 : matching.findIndex((i) => i.clusterId === cursor);
  const start = at === -1 ? 0 : at + 1;
  const items = matching.slice(start, start + pageSize);
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: start + items.length < matching.length && last ? last.clusterId : null,
    counts,
    filteredCount: matching.length,
  };
}
