/**
 * Load / save workbooks as `.xlsx` through `FakeSheetsGateway`.
 *
 * This is the local Excel seam: the same scan/review/apply engine runs in
 * memory, then sheets (including `_Dedup_*`) are written back to a file.
 */
import ExcelJS from "exceljs";
import { basename } from "node:path";
import type { CellValue } from "@/server/types";
import { FakeSheetsGateway, type DumpedSheet } from "@/server/sheets/FakeSheetsGateway";
import type { GridValues } from "@/server/sheets/SheetsGateway";

function cellToValue(cell: ExcelJS.Cell): CellValue {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("text" in v && typeof (v as { text: unknown }).text === "string") {
      return (v as { text: string }).text;
    }
    if ("result" in v) {
      const result = (v as { result: unknown }).result;
      if (
        typeof result === "string" ||
        typeof result === "number" ||
        typeof result === "boolean"
      ) {
        return result;
      }
      if (result instanceof Date) return result.toISOString().slice(0, 10);
      return result == null ? "" : String(result);
    }
    if ("richText" in v && Array.isArray((v as { richText: { text: string }[] }).richText)) {
      return (v as { richText: { text: string }[] }).richText.map((p) => p.text).join("");
    }
    if ("hyperlink" in v && "text" in v) {
      return String((v as { text: unknown }).text ?? "");
    }
  }
  return String(v);
}

/**
 * Google Sheets → xlsx exports often leave `_Dedup_ID` far to the right of the
 * used data rectangle (`actualColumnCount` << `columnCount`). Prefer the wider
 * bound and always include non-empty header cells.
 */
function usedColCount(ws: ExcelJS.Worksheet): number {
  let max = Math.max(ws.actualColumnCount || 0, ws.columnCount || 0);
  const header = ws.getRow(1);
  header.eachCell({ includeEmpty: false }, (_cell, colNumber) => {
    max = Math.max(max, colNumber);
  });
  return max;
}

function sheetToGrid(ws: ExcelJS.Worksheet): GridValues {
  const rowCount = ws.actualRowCount || ws.rowCount;
  const colCount = usedColCount(ws);
  if (rowCount === 0 || colCount === 0) return [];
  const grid: GridValues = [];
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const out: CellValue[] = [];
    for (let c = 1; c <= colCount; c++) {
      out.push(cellToValue(row.getCell(c)));
    }
    grid.push(out);
  }
  return trimTrailingEmpty(grid);
}

function trimTrailingEmpty(rows: GridValues): GridValues {
  let end = rows.length;
  while (end > 0) {
    const row = rows[end - 1]!;
    if (row.some((v) => v !== "" && v !== null)) break;
    end -= 1;
  }
  return rows.slice(0, end);
}

export interface LoadXlsxOptions {
  /** Prefer this sheet as active (scan target). */
  activeSheetName?: string | null;
  activeUserEmail?: string | null;
  spreadsheetId?: string;
}

/** Read an `.xlsx` into a FakeSheetsGateway (all worksheets become sheets). */
export async function loadXlsxFile(
  path: string,
  options: LoadXlsxOptions = {},
): Promise<FakeSheetsGateway> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const gateway = new FakeSheetsGateway({
    spreadsheetId: options.spreadsheetId ?? basename(path),
    activeUserEmail: options.activeUserEmail ?? "xlsx-cli@local",
  });

  let index = 0;
  for (const ws of workbook.worksheets) {
    const values = trimTrailingEmpty(sheetToGrid(ws));
    gateway.loadSheet(ws.name, {
      values,
      hidden: ws.state === "hidden" || ws.state === "veryHidden",
      sheetId: ws.id || index + 1,
    });
    index += 1;
  }

  const preferred = options.activeSheetName;
  if (preferred && gateway.getSheetByName(preferred)) {
    gateway.setActiveSheet(preferred);
  } else {
    const firstVisible = gateway.listSheets().find((s) => !s.hidden);
    gateway.setActiveSheet(firstVisible?.title ?? null);
  }
  return gateway;
}

function writeGrid(ws: ExcelJS.Worksheet, values: GridValues): void {
  for (let r = 0; r < values.length; r++) {
    const row = values[r]!;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      ws.getCell(r + 1, c + 1).value = v === null ? null : v;
    }
  }
}

/** Persist gateway sheets (participant + `_Dedup_*`) to an `.xlsx` file. */
export async function saveXlsxFile(gateway: FakeSheetsGateway, path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const dumped: DumpedSheet[] = gateway.dumpSheets();
  for (const sheet of dumped) {
    const ws = workbook.addWorksheet(sheet.info.title, {
      state: sheet.info.hidden ? "hidden" : "visible",
    });
    writeGrid(ws, sheet.values);
    for (const col of sheet.hiddenColumns) {
      ws.getColumn(col + 1).hidden = true;
    }
  }
  await workbook.xlsx.writeFile(path);
}

/** Default output path: `foo.xlsx` → `foo.dedup.xlsx`. */
export function defaultDedupOutPath(inputPath: string): string {
  return inputPath.replace(/(\.xlsx)?$/i, ".dedup.xlsx");
}
