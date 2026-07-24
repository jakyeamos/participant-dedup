import type { CellValue } from "@/server/types";
import { DedupError } from "@/server/errors";
import type {
  DocumentLock,
  GridValues,
  InsertSheetOptions,
  RangeSpec,
  SheetInfo,
  SheetsBatchUpdateRequest,
  SheetsBatchUpdateResult,
  SheetsGateway,
} from "@/server/sheets/SheetsGateway";

/**
 * The production side of the seam. This is the only module in the bundle that
 * touches an Apps Script global, which is what lets every other file run under
 * vitest against `FakeSheetsGateway`. It contains no deduplication logic: if a
 * decision can be made without a spreadsheet, it belongs somewhere else.
 */

/** Apps Script hands back live `Date` objects; nothing downstream accepts one. */
type RawCell = CellValue | Date | undefined;

/**
 * §13.3 A date cell reduced to text the pure normalizers can read. Formatting
 * happens in the spreadsheet's own time zone, because a New York birthday read
 * as UTC lands on the previous day. A midnight value is a plain date and is
 * written as one; anything else keeps its time rather than silently losing it.
 */
function formatDate(value: Date, tz: string): string {
  const dayOnly = Utilities.formatDate(value, tz, "yyyy-MM-dd");
  const time = Utilities.formatDate(value, tz, "HH:mm:ss");
  return time === "00:00:00" ? dayOnly : `${dayOnly} ${time}`;
}

function coerceCell(value: RawCell, tz: string): CellValue {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return formatDate(value, tz);
  return value as CellValue;
}

function coerceGrid(values: RawCell[][], tz: string): GridValues {
  return values.map((row) => row.map((cell) => coerceCell(cell, tz)));
}

/** §26 A document lock that reports a timeout as the error the sidebar shows. */
class AppsScriptDocumentLock implements DocumentLock {
  private readonly lock = LockService.getDocumentLock();

  acquire(timeoutMs: number): void {
    if (!this.lock.tryLock(timeoutMs)) throw new DedupError("LOCK_TIMEOUT");
  }

  release(): void {
    this.lock.releaseLock();
  }

  hasLock(): boolean {
    return this.lock.hasLock();
  }
}

export class AppsScriptSheetsGateway implements SheetsGateway {
  private readonly spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  /** Resolved once: every read coerces dates with it, and it cannot change mid-run. */
  private readonly tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  getSpreadsheetId(): string {
    return this.spreadsheet.getId();
  }

  getTimeZone(): string {
    return this.tz;
  }

  /**
   * §21.3 An email or nothing. Apps Script returns an empty string for a
   * consumer account outside the owning domain and throws outright under some
   * authorization modes; both mean the same thing here, and the sidebar asks
   * the reviewer to type a name instead.
   */
  getActiveUserEmail(): string | null {
    try {
      const email = Session.getActiveUser().getEmail();
      return email && email.trim() !== "" ? email : null;
    } catch {
      return null;
    }
  }

  listSheets(): SheetInfo[] {
    return this.spreadsheet.getSheets().map((sheet) => infoFor(sheet));
  }

  getSheetByName(name: string): SheetInfo | null {
    const sheet = this.spreadsheet.getSheetByName(name);
    return sheet ? infoFor(sheet) : null;
  }

  getActiveSheetName(): string | null {
    const sheet = this.spreadsheet.getActiveSheet();
    return sheet ? sheet.getName() : null;
  }

  insertSheet(title: string, options?: InsertSheetOptions): SheetInfo {
    const sheet = this.spreadsheet.insertSheet(title);
    if (options?.hidden) sheet.hideSheet();
    return infoFor(sheet);
  }

  hideSheet(name: string): void {
    this.sheet(name).hideSheet();
  }

  readRange(sheetName: string, a1: string): GridValues {
    return coerceGrid(this.sheet(sheetName).getRange(a1).getValues() as RawCell[][], this.tz);
  }

  readDisplayRange(sheetName: string, a1: string): string[][] {
    return this.sheet(sheetName).getRange(a1).getDisplayValues();
  }

  readFormulaRange(sheetName: string, a1: string): string[][] {
    return this.sheet(sheetName).getRange(a1).getFormulas();
  }

  /**
   * §7.2 One round-trip for many ranges. The advanced service returns the
   * ranges in request order, so the results line up positionally with `ranges`.
   */
  batchGet(ranges: RangeSpec[]): GridValues[] {
    if (ranges.length === 0) return [];
    const response = Sheets.Spreadsheets!.Values!.batchGet(this.getSpreadsheetId(), {
      ranges: ranges.map((r) => `'${r.sheetName.replace(/'/g, "''")}'!${r.a1}`),
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    return (response.valueRanges ?? []).map((vr) =>
      coerceGrid((vr.values ?? []) as RawCell[][], this.tz),
    );
  }

  writeRange(sheetName: string, a1: string, values: GridValues): void {
    if (values.length === 0) return;
    const sheet = this.sheet(sheetName);
    const width = Math.max(...values.map((r) => r.length));
    const padded = values.map((r) => {
      const row: CellValue[] = r.slice(0, width);
      while (row.length < width) row.push(null);
      return row;
    });
    // `getRange("A1")` is 1×1; setValues requires the range to match the matrix.
    // Anchor at the A1 start cell, then size to the padded grid (same as appendRows).
    const anchor = sheet.getRange(a1);
    sheet
      .getRange(anchor.getRow(), anchor.getColumn(), padded.length, width)
      .setValues(padded);
  }

  appendRows(sheetName: string, rows: GridValues): void {
    if (rows.length === 0) return;
    const sheet = this.sheet(sheetName);
    const width = Math.max(...rows.map((r) => r.length));
    const start = sheet.getLastRow() + 1;
    const needed = start + rows.length - 1;
    if (needed > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
    const padded = rows.map((r) => {
      const row: CellValue[] = r.slice(0, width);
      while (row.length < width) row.push(null);
      return row;
    });
    sheet.getRange(start, 1, padded.length, width).setValues(padded);
  }

  /**
   * §26.1 The apply path. Sheets applies the whole request or none of it, which
   * is the only reason deletions and blank fills can be treated as one unit.
   */
  batchUpdate(request: SheetsBatchUpdateRequest): SheetsBatchUpdateResult {
    const response = Sheets.Spreadsheets!.batchUpdate(
      request as unknown as GoogleAppsScript.Sheets.Schema.BatchUpdateSpreadsheetRequest,
      this.getSpreadsheetId(),
    );
    return { replies: (response.replies ?? []).length };
  }

  getDocumentLock(): DocumentLock {
    return new AppsScriptDocumentLock();
  }

  newUuid(): string {
    return Utilities.getUuid();
  }

  getGridSize(sheetName: string): { rowCount: number; columnCount: number } {
    const sheet = this.sheet(sheetName);
    return { rowCount: sheet.getLastRow(), columnCount: sheet.getLastColumn() };
  }

  hideColumn(sheetName: string, columnIndex: number): void {
    this.sheet(sheetName).hideColumns(columnIndex + 1);
  }

  /**
   * §21.7 The sheet is activated first: activating a range on a sheet the user
   * is not looking at moves the cursor somewhere they cannot see.
   */
  activateCell(sheetName: string, row: number, column: number): void {
    const sheet = this.sheet(sheetName);
    this.spreadsheet.setActiveSheet(sheet);
    sheet.getRange(row, column).activate();
  }

  private sheet(name: string): GoogleAppsScript.Spreadsheet.Sheet {
    const sheet = this.spreadsheet.getSheetByName(name);
    if (!sheet) throw new DedupError("INTERNAL");
    return sheet;
  }
}

function infoFor(sheet: GoogleAppsScript.Spreadsheet.Sheet): SheetInfo {
  return {
    sheetId: sheet.getSheetId(),
    title: sheet.getName(),
    // `getIndex()` is 1-based; the gateway contract is 0-based.
    index: sheet.getIndex() - 1,
    hidden: sheet.isSheetHidden(),
  };
}
