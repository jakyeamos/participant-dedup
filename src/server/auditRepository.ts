import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { CellValue } from "@/server/types";
import { SYSTEM_SHEETS } from "@/shared/constants";
import { nowIso, tableFor } from "@/server/systemSheets";
import type { AuditActor } from "@/server/identity";

/** The recovery record for a deleted participant row (§25.4). */
export interface DeletedRowSnapshot {
  dedupId: string;
  row: number;
  values: string[];
}

/**
 * §8.7 Every audit row names its actor. Requiring it here rather than defaulting
 * it means a new writer cannot quietly file an unattributed event.
 *
 * The optional keys are exactly the §8.7 columns. encodeRow writes by column, so
 * anything else a caller passes is silently discarded — spelling the shape out
 * turns that into a compile error instead. `eventId` and `eventAt` are omitted
 * because append() stamps them; the apply path stamps its own and uses
 * `AuditRowFields`.
 */
export interface AuditEvent extends AuditActor {
  eventType: string;
  batchId?: string;
  applyBatchId?: string;
  clusterId?: string;
  sourceSheetId?: number;
  sourceSheetName?: string;
  targetDedupId?: string;
  relatedIds?: string[];
  fieldName?: string;
  beforeValue?: CellValue;
  afterValue?: CellValue;
  rowSnapshot?: DeletedRowSnapshot;
  confidence?: string;
  score?: number;
  reasons?: unknown[];
  warnings?: string[];
  result?: "SUCCESS" | "SKIPPED" | "FAILED";
  errorCode?: string;
  errorMessage?: string;
}
/**
 * An audit row written straight through `batchUpdate` rather than by append():
 * the apply composes its rows up front so the whole change reaches the sheet in
 * one request, which means it stamps its own identifiers.
 */
export interface AuditRowFields extends AuditEvent {
  eventId: string;
  eventAt: string;
}

export type AuditRecord = Record<string, CellValue>;

/** Event types whose before/after value columns carry meaningful data. */
const VALUE_BEARING_EVENTS = new Set<string>(["FIELD_FILLED"]);

let auditSeq = 0;

export function newEventId(): string {
  auditSeq += 1;
  return `evt_${Date.now().toString(36)}_${auditSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface AuditRepository {
  append(event: AuditEvent): void;
  readAll(): AuditRecord[];
}

export function auditRepository(gateway: SheetsGateway): AuditRepository {
  const table = tableFor(gateway, SYSTEM_SHEETS.audit);

  return {
    append(event: AuditEvent): void {
      const carriesValues = VALUE_BEARING_EVENTS.has(event.eventType);
      table.append({
        eventId: newEventId(),
        eventAt: nowIso(gateway),
        ...event,
        beforeValue: carriesValues ? event.beforeValue ?? null : null,
        afterValue: carriesValues ? event.afterValue ?? null : null,
      });
    },

    readAll(): AuditRecord[] {
      return table.rows();
    },
  };
}
