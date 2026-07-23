import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { CellValue } from "@/server/types";
import { NONTERMINAL_BATCH_STATUSES, SYSTEM_SHEETS } from "@/shared/constants";
import { nowIso, tableFor } from "@/server/systemSheets";

export type BatchRecord = Record<string, CellValue>;

export interface BatchInsert {
  batchId: string;
  sourceSpreadsheetId: string;
  sourceSheetId: number;
  sourceSheetName: string;
  headerRow: number;
  status: string;
  revision: number;
  [extra: string]: unknown;
}

export interface BatchesRepository {
  insert(rec: BatchInsert): void;
  get(batchId: string): BatchRecord | null;
  getActive(): BatchRecord | null;
  update(batchId: string, patch: Record<string, unknown>): void;
}

const NONTERMINAL = new Set<string>(NONTERMINAL_BATCH_STATUSES);

export function batchesRepository(gateway: SheetsGateway): BatchesRepository {
  const table = tableFor(gateway, SYSTEM_SHEETS.batches);

  return {
    insert(rec: BatchInsert): void {
      const ts = nowIso(gateway);
      table.append({
        createdAt: ts,
        createdBy: gateway.getActiveUserEmail() ?? "unknown",
        updatedAt: ts,
        ...rec,
      });
    },

    get(batchId: string): BatchRecord | null {
      const found = table.rows().find((r) => r.batchId === batchId);
      return found ?? null;
    },

    getActive(): BatchRecord | null {
      const found = table
        .rows()
        .find((r) => NONTERMINAL.has(String(r.status)));
      return found ?? null;
    },

    update(batchId: string, patch: Record<string, unknown>): void {
      const target = table
        .rowsWithIndex()
        .find((r) => r.rec.batchId === batchId);
      if (!target) return;
      table.writeAt(target.index, {
        ...target.rec,
        ...patch,
        updatedAt: nowIso(gateway),
      });
    },
  };
}
