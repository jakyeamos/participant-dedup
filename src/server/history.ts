import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { CellValue } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import { auditRepository } from "@/server/auditRepository";

/**
 * One audit row as the sidebar sees it (§21.1 AUDIT_HISTORY). Every member is a
 * primitive or an array of them: §6.2 forbids returning Dates, Maps or class
 * instances across google.script.run.
 *
 * `rowSnapshot` is deliberately absent. It holds a whole deleted participant row
 * and exists so a delete can be reconstructed from the sheet; putting it in
 * every page would multiply the payload for something no list view displays.
 */
export interface HistoryEvent {
  eventId: string;
  eventAt: string;
  eventType: string;
  actorId: string;
  actorType: string;
  reviewerId: string;
  batchId: string;
  applyBatchId: string;
  clusterId: string;
  sourceSheetName: string;
  targetDedupId: string;
  relatedIds: string[];
  fieldName: string;
  beforeValue: CellValue;
  afterValue: CellValue;
  confidence: string;
  score: number | null;
  reasons: string[];
  warnings: string[];
  result: string;
  errorCode: string;
  errorMessage: string;
}

export interface HistoryPageRequest {
  batchId?: string;
  applyBatchId?: string;
  clusterId?: string;
  /** Matches a participant whether it was the merge target or a related member. */
  dedupId?: string;
  eventTypes?: string[];
  actorId?: string;
  /** The eventId the previous page ended on. */
  cursor?: string | null;
  pageSize?: number;
}

export interface HistoryPage {
  events: HistoryEvent[];
  nextCursor: string | null;
  /** Rows the active filter matches, across every page. */
  filteredCount: number;
  /** Rows in the audit sheet, unaffected by the filter. */
  totalCount: number;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toEvent(row: Record<string, CellValue>): HistoryEvent {
  return {
    eventId: str(row.eventId),
    eventAt: str(row.eventAt),
    eventType: str(row.eventType),
    actorId: str(row.actorId),
    actorType: str(row.actorType),
    reviewerId: str(row.reviewerId),
    batchId: str(row.batchId),
    applyBatchId: str(row.applyBatchId),
    clusterId: str(row.clusterId),
    sourceSheetName: str(row.sourceSheetName),
    targetDedupId: str(row.targetDedupId),
    relatedIds: strings(row.relatedIds),
    fieldName: str(row.fieldName),
    beforeValue: row.beforeValue ?? null,
    afterValue: row.afterValue ?? null,
    confidence: str(row.confidence),
    score: num(row.score),
    reasons: strings(row.reasons),
    warnings: strings(row.warnings),
    result: str(row.result),
    errorCode: str(row.errorCode),
    errorMessage: str(row.errorMessage),
  };
}

function matches(event: HistoryEvent, request: HistoryPageRequest): boolean {
  if (request.batchId && event.batchId !== request.batchId) return false;
  if (request.applyBatchId && event.applyBatchId !== request.applyBatchId) return false;
  if (request.clusterId && event.clusterId !== request.clusterId) return false;
  if (request.actorId && event.actorId !== request.actorId) return false;
  if (request.eventTypes && !request.eventTypes.includes(event.eventType)) return false;
  if (request.dedupId) {
    const id = request.dedupId;
    if (event.targetDedupId !== id && !event.relatedIds.includes(id)) return false;
  }
  return true;
}

/**
 * §21.5 One page of the audit trail, newest first.
 *
 * The audit sheet is append-only and never reordered, so sheet position is
 * chronological and reversing it is enough — eventAt alone would tie whenever
 * two rows land in the same millisecond, which an apply does routinely. That
 * same append-only property makes eventId a stable cursor: rows added after the
 * first page appear above the cursor, never inside the pages already served.
 *
 * A cursor that no longer resolves — a filter changed underneath it, say —
 * restarts at the newest event rather than stranding the reader on a blank page.
 */
export function getHistoryPage(
  gateway: SheetsGateway,
  request: HistoryPageRequest,
  cfg: DedupConfig,
): HistoryPage {
  const all = auditRepository(gateway).readAll();
  const matching: HistoryEvent[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const event = toEvent(all[i]!);
    if (matches(event, request)) matching.push(event);
  }

  const maxSize = cfg.execution.queuePageSize;
  const requested = Number(request.pageSize);
  const pageSize = requested > 0 ? Math.min(requested, maxSize) : maxSize;

  const cursor = request.cursor ?? null;
  const at = cursor === null ? -1 : matching.findIndex((e) => e.eventId === cursor);
  const start = at === -1 ? 0 : at + 1;
  const events = matching.slice(start, start + pageSize);
  const last = events[events.length - 1];

  return {
    events,
    nextCursor: start + events.length < matching.length && last ? last.eventId : null,
    filteredCount: matching.length,
    totalCount: all.length,
  };
}
