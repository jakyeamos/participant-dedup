import { DedupError } from "@/server/errors";
import type { MergePlan } from "@/server/review/mergePlan";
import type {
  ExtendedValue,
  RowData,
  SheetsBatchUpdateRequest,
  SheetsRequest,
} from "@/server/sheets/SheetsGateway";
import { AUDIT_FIELDS, encodeRow } from "@/server/systemSheets";
import type { CellValue } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import type { AuditRow } from "@/server/apply/audit";

/** A full-width write of one system-sheet row, addressed by grid index. */
export interface SystemRowUpdate {
  sheetId: number;
  /** Zero-based grid row; the header occupies index 0. */
  rowIndex: number;
  cells: CellValue[];
}

export interface AtomicRequestInput {
  sourceSheetId: number;
  columnIndexByHeader: Record<string, number>;
  /** Current one-based source row of every record the plans touch. */
  rowByDedupId: Record<string, number>;
  plans: MergePlan[];
  auditSheetId: number;
  auditRows: AuditRow[];
  statusUpdates: SystemRowUpdate[];
}

function toExtendedValue(value: CellValue): ExtendedValue {
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: value === null ? "" : value };
}

function toRowData(cells: CellValue[]): RowData {
  return { values: cells.map((c) => ({ userEnteredValue: toExtendedValue(c) })) };
}

function rowOf(input: AtomicRequestInput, dedupId: string): number {
  const row = input.rowByDedupId[dedupId];
  // Preflight resolves a live row for every affected record; a gap here is a bug.
  if (row === undefined) throw new DedupError("INTERNAL");
  return row;
}

function columnOf(input: AtomicRequestInput, header: string): number {
  const column = input.columnIndexByHeader[header];
  if (column === undefined) throw new DedupError("INTERNAL");
  return column;
}

/** §25.3 Zero-based half-open row intervals, merged and ordered bottom-up. */
function deleteIntervals(rows: number[]): Array<{ startIndex: number; endIndex: number }> {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const intervals: Array<{ startIndex: number; endIndex: number }> = [];
  for (const oneBased of sorted) {
    const index = oneBased - 1;
    const last = intervals[intervals.length - 1];
    if (last && last.endIndex === index) last.endIndex = index + 1;
    else intervals.push({ startIndex: index, endIndex: index + 1 });
  }
  // Descending, so each deletion leaves the rows above it at their own indexes.
  return intervals.reverse();
}

/**
 * §25 Assembles one `batchUpdate` carrying every change of an apply: blank-field
 * value copies, source-row deletions, the audit trail, and the queue and batch
 * status writes. The Sheets API applies a valid batch as a unit, so building a
 * single request is what makes an apply all-or-nothing — never split it.
 *
 * Deviation from the plan's parameter list: deletions are read off the plans
 * rather than passed alongside them, so the two can never disagree.
 */
export function buildAtomicRequest(
  input: AtomicRequestInput,
  cfg: DedupConfig,
): SheetsBatchUpdateRequest {
  const requests: SheetsRequest[] = [];

  // §25.1 step 1: copy values into blank fields while the source rows still exist.
  for (const plan of input.plans) {
    for (const fill of plan.fills) {
      const column = columnOf(input, fill.header);
      const sourceRow = rowOf(input, fill.sourceId);
      const targetRow = rowOf(input, fill.retainedId);
      requests.push({
        copyPaste: {
          source: {
            sheetId: input.sourceSheetId,
            startRowIndex: sourceRow - 1,
            endRowIndex: sourceRow,
            startColumnIndex: column,
            endColumnIndex: column + 1,
          },
          destination: {
            sheetId: input.sourceSheetId,
            startRowIndex: targetRow - 1,
            endRowIndex: targetRow,
            startColumnIndex: column,
            endColumnIndex: column + 1,
          },
          pasteType: "PASTE_VALUES",
        },
      });
    }
  }

  // §25.1 step 2: delete the merged-away rows, bottom-up.
  const deletionRows = input.plans.flatMap((plan) =>
    plan.deletions.map((d) => rowOf(input, d.deletedId)),
  );
  for (const interval of deleteIntervals(deletionRows)) {
    requests.push({
      deleteDimension: {
        range: {
          sheetId: input.sourceSheetId,
          dimension: "ROWS",
          startIndex: interval.startIndex,
          endIndex: interval.endIndex,
        },
      },
    });
  }

  // §25.1 step 3: the audit trail rides in the same batch as the changes it records.
  if (input.auditRows.length > 0) {
    requests.push({
      appendCells: {
        sheetId: input.auditSheetId,
        rows: input.auditRows.map((row) => toRowData(encodeRow(AUDIT_FIELDS, row))),
        fields: "userEnteredValue",
      },
    });
  }

  // §25.1 steps 4-5 / §25.5: cluster and batch status, never a second write after.
  for (const update of input.statusUpdates) {
    requests.push({
      updateCells: {
        rows: [toRowData(update.cells)],
        fields: "userEnteredValue",
        range: {
          sheetId: update.sheetId,
          startRowIndex: update.rowIndex,
          endRowIndex: update.rowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: update.cells.length,
        },
      },
    });
  }

  // §25.6 Splitting would break atomicity, so fail before touching the sheet.
  if (requests.length > cfg.execution.maxAtomicApplyRequests) {
    throw new DedupError("ATOMIC_REQUEST_TOO_LARGE");
  }

  return { requests };
}
