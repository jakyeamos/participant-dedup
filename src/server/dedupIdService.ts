import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { CellValue, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import { DEDUP_ID_HEADER } from "@/shared/constants";
import { colLetters } from "@/server/systemSheets";
import { auditRepository } from "@/server/auditRepository";
import type { AuditActor } from "@/server/identity";
import { batchesRepository } from "@/server/batchesRepository";
import { stateRepository } from "@/server/stateRepository";

const REPAIR_LOCK_TIMEOUT_MS = 30_000;

function isBlank(value: CellValue | undefined): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

function relevantColumns(schema: SourceSchema): number[] {
  return [
    ...Object.values(schema.columnByCanonicalField),
    ...schema.extraColumns.map((e) => e.columnIndex),
  ];
}

/**
 * Ensure every participant row carries a `_Dedup_ID` (§11.1/11.2). Creates and
 * hides the column when absent, backfills blanks when present. Participant rows
 * are those with at least one nonblank mapped or extra field.
 */
export function ensureDedupIds(
  gateway: SheetsGateway,
  schema: SourceSchema,
  _cfg: DedupConfig,
  actor: AuditActor,
): { assigned: number } {
  const sheetName = schema.sheetName;
  const { rowCount } = gateway.getGridSize(sheetName);
  const dataStart = schema.headerRow + 1; // 1-based first data row
  const creating = schema.dedupIdColumnIndex < 0;
  const idCol = creating ? schema.headers.length : schema.dedupIdColumnIndex;
  const idColLetter = colLetters(idCol);

  const cols = relevantColumns(schema);
  const maxCol = Math.max(idCol, schema.headers.length - 1, ...cols);
  const lastColLetter = colLetters(maxCol);

  const block =
    rowCount >= dataStart
      ? gateway.readRange(sheetName, `A${dataStart}:${lastColLetter}${rowCount}`)
      : [];

  const columnValues: CellValue[][] = [];
  const assignedIds: string[] = [];
  for (const row of block) {
    const isParticipant = cols.some((c) => !isBlank(row[c]));
    const current = row[idCol];
    if (isParticipant && isBlank(current)) {
      const id = gateway.newUuid();
      columnValues.push([id]);
      assignedIds.push(id);
    } else {
      columnValues.push([creating ? "" : current ?? ""]);
    }
  }

  if (creating) {
    gateway.writeRange(sheetName, `${idColLetter}${schema.headerRow}`, [[DEDUP_ID_HEADER]]);
  }
  if (columnValues.length > 0) {
    gateway.writeRange(sheetName, `${idColLetter}${dataStart}`, columnValues);
  }
  if (creating) gateway.hideColumn(sheetName, idCol);

  const audit = auditRepository(gateway);
  for (const id of assignedIds) {
    audit.append({
      ...actor,
      eventType: "ID_ASSIGNED",
      sourceSheetId: schema.sheetId,
      sourceSheetName: sheetName,
      targetDedupId: id,
      result: "SUCCESS",
    });
  }

  return { assigned: assignedIds.length };
}

/** Ids that occur more than once, ignoring blanks (§11.3), in first-seen order. */
export function detectDuplicateIds(records: ReadonlyArray<{ dedupId: string }>): string[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const id = r.dedupId;
    if (isBlank(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

/**
 * Repair duplicated `_Dedup_ID`s (§11.3): keep the first physical occurrence,
 * reassign later ones, invalidate affected suppressions, cancel any active
 * batch, and audit — under a document lock, never touching participant values.
 */
export function repairDuplicateIds(
  gateway: SheetsGateway,
  schema: SourceSchema,
  actor: AuditActor,
): { repaired: number } {
  const idCol = schema.dedupIdColumnIndex;
  if (idCol < 0) return { repaired: 0 };

  const lock = gateway.getDocumentLock();
  lock.acquire(REPAIR_LOCK_TIMEOUT_MS);
  try {
    const sheetName = schema.sheetName;
    const { rowCount } = gateway.getGridSize(sheetName);
    const dataStart = schema.headerRow + 1;
    const idColLetter = colLetters(idCol);
    const block =
      rowCount >= dataStart
        ? gateway.readRange(sheetName, `${idColLetter}${dataStart}:${idColLetter}${rowCount}`)
        : [];

    const seen = new Set<string>();
    const duplicated = new Set<string>();
    const writes: CellValue[][] = [];
    const reassigned: Array<{ old: string; next: string }> = [];
    for (const row of block) {
      const current = row[0];
      if (isBlank(current)) {
        writes.push([current ?? ""]);
        continue;
      }
      const id = String(current);
      if (seen.has(id)) {
        const next = gateway.newUuid();
        writes.push([next]);
        duplicated.add(id);
        reassigned.push({ old: id, next });
      } else {
        seen.add(id);
        writes.push([id]);
      }
    }

    if (writes.length > 0) {
      gateway.writeRange(sheetName, `${idColLetter}${dataStart}`, writes);
    }

    const state = stateRepository(gateway);
    for (const s of state.listByType("SUPPRESSION")) {
      const value = (s.valueJson ?? {}) as { memberIds?: string[] };
      const members = Array.isArray(value.memberIds) ? value.memberIds : [];
      if (members.some((m) => duplicated.has(m))) {
        state.put("SUPPRESSION", s.stateKey, { ...value, invalidated: true });
      }
    }

    const batches = batchesRepository(gateway);
    const active = batches.getActive();
    if (active) {
      batches.update(String(active.batchId), {
        status: "CANCELLED",
        errorCode: "DUPLICATE_DEDUP_ID",
        staleReason: "DUPLICATE_DEDUP_ID_REPAIRED",
      });
    }

    const audit = auditRepository(gateway);
    for (const r of reassigned) {
      audit.append({
        ...actor,
        eventType: "ID_REPAIRED",
        sourceSheetId: schema.sheetId,
        sourceSheetName: sheetName,
        targetDedupId: r.next,
        relatedIds: [r.old],
        result: "SUCCESS",
      });
    }

    return { repaired: reassigned.length };
  } finally {
    lock.release();
  }
}
