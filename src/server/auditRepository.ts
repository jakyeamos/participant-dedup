import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { CellValue } from "@/server/types";
import { SYSTEM_SHEETS } from "@/shared/constants";
import { nowIso, tableFor } from "@/server/systemSheets";

export type AuditEvent = Record<string, unknown> & { eventType: string };
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
        actorId: gateway.getActiveUserEmail() ?? "unknown",
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
