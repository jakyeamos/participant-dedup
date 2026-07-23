import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { CellValue } from "@/server/types";
import { SYSTEM_SHEETS } from "@/shared/constants";
import { nowIso, tableFor } from "@/server/systemSheets";

export interface StateRecord {
  stateType: string;
  stateKey: string;
  valueJson: unknown;
  createdAt: CellValue;
  updatedAt: CellValue;
}

export interface StateRepository {
  put(stateType: string, stateKey: string, value: unknown): void;
  get(stateType: string, stateKey: string): StateRecord | null;
  listByType(stateType: string): StateRecord[];
}

export function stateRepository(gateway: SheetsGateway): StateRepository {
  const table = tableFor(gateway, SYSTEM_SHEETS.state);

  const toRec = (r: Record<string, CellValue>): StateRecord => ({
    stateType: r.stateType as string,
    stateKey: r.stateKey as string,
    valueJson: r.valueJson,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  });

  return {
    put(stateType: string, stateKey: string, value: unknown): void {
      const ts = nowIso(gateway);
      const existing = table
        .rowsWithIndex()
        .find((r) => r.rec.stateType === stateType && r.rec.stateKey === stateKey);
      const rec = {
        stateType,
        stateKey,
        valueJson: value,
        createdAt: existing ? existing.rec.createdAt : ts,
        updatedAt: ts,
      };
      if (existing) table.writeAt(existing.index, rec);
      else table.append(rec);
    },

    get(stateType: string, stateKey: string): StateRecord | null {
      const found = table
        .rows()
        .find((r) => r.stateType === stateType && r.stateKey === stateKey);
      return found ? toRec(found) : null;
    },

    listByType(stateType: string): StateRecord[] {
      return table
        .rows()
        .filter((r) => r.stateType === stateType)
        .map(toRec);
    },
  };
}
