import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { CellValue, RecordSnapshot } from "@/server/types";
import { SYSTEM_SHEETS } from "@/shared/constants";
import { tableFor } from "@/server/systemSheets";

export interface RecordsRepository {
  append(records: RecordSnapshot[]): void;
  readByBatch(batchId: string, headers: string[]): RecordSnapshot[];
}

function byHeader(headers: string[], values: readonly CellValue[]): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  headers.forEach((h, i) => {
    out[h] = values[i] ?? null;
  });
  return out;
}

export function recordsRepository(gateway: SheetsGateway): RecordsRepository {
  const table = tableFor(gateway, SYSTEM_SHEETS.records);

  return {
    append(records: RecordSnapshot[]): void {
      table.appendMany(records as unknown as Record<string, unknown>[]);
    },

    readByBatch(batchId: string, headers: string[]): RecordSnapshot[] {
      return table
        .rows()
        .filter((r) => r.batchId === batchId)
        .map((r) => {
          const rawValues = r.rawValues as unknown as CellValue[];
          const displayValues = r.displayValues as unknown as string[];
          return {
            batchId: r.batchId as string,
            dedupId: r.dedupId as string,
            sourceRowAtScan: r.sourceRowAtScan as number,
            rowFingerprint: r.rowFingerprint as string,
            relevantHash: r.relevantHash as string,
            rawValues,
            displayValues,
            formulas: r.formulas as unknown as string[],
            valuesByHeader: byHeader(headers, rawValues),
            displayByHeader: byHeader(headers, displayValues) as Record<string, string>,
            normalized: r.normalized as unknown as RecordSnapshot["normalized"],
          };
        });
    },
  };
}
