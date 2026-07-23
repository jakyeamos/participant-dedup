import type { CellValue } from "@/server/types";

/**
 * The single architectural seam. Every Apps Script global and `Sheets.*` call
 * lives behind this interface, so all logic runs against `FakeSheetsGateway`
 * under vitest with no OAuth. The production adapter is the only module that
 * imports Apps Script; it must expose exactly this surface.
 */

/** A rectangular grid of typed cell values. */
export type GridValues = CellValue[][];

export interface SheetInfo {
  sheetId: number;
  title: string;
  index: number;
  hidden: boolean;
}

export interface RangeSpec {
  sheetName: string;
  a1: string;
}

export interface InsertSheetOptions {
  hidden?: boolean;
}

/** A document-scoped mutual-exclusion lock (maps to `LockService`). */
export interface DocumentLock {
  /** Acquire within `timeoutMs` or throw `DedupError("LOCK_TIMEOUT")`. */
  acquire(timeoutMs: number): void;
  release(): void;
  hasLock(): boolean;
}

// --- Sheets API v4 batchUpdate subset ----------------------------------------
// Only the request kinds this application emits are modeled, so the production
// adapter can pass these objects straight through to `Sheets.Spreadsheets.batchUpdate`.

/** A zero-based, half-open grid rectangle (Sheets API `GridRange`). */
export interface GridRange {
  sheetId: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

/** Sheets API `ExtendedValue` — exactly one field is set. */
export type ExtendedValue =
  | { stringValue: string }
  | { numberValue: number }
  | { boolValue: boolean }
  | Record<string, never>;

export interface CellData {
  userEnteredValue?: ExtendedValue;
}

export interface RowData {
  values: CellData[];
}

export interface UpdateCellsRequest {
  rows: RowData[];
  fields: string;
  /** Write starts at the range's start row/column; extent comes from `rows`. */
  range: GridRange;
}

export interface CopyPasteRequest {
  source: GridRange;
  destination: GridRange;
  pasteType: "PASTE_VALUES";
}

export interface DeleteDimensionRequest {
  range: {
    sheetId: number;
    dimension: "ROWS" | "COLUMNS";
    startIndex: number;
    endIndex: number;
  };
}

export interface AppendCellsRequest {
  sheetId: number;
  rows: RowData[];
  fields: string;
}

export type SheetsRequest =
  | { updateCells: UpdateCellsRequest }
  | { copyPaste: CopyPasteRequest }
  | { deleteDimension: DeleteDimensionRequest }
  | { appendCells: AppendCellsRequest };

export interface SheetsBatchUpdateRequest {
  requests: SheetsRequest[];
}

export interface SheetsBatchUpdateResult {
  replies: number;
}

export interface SheetsGateway {
  getSpreadsheetId(): string;
  getTimeZone(): string;
  /** The active user's email, or null when Apps Script cannot resolve it. */
  getActiveUserEmail(): string | null;

  listSheets(): SheetInfo[];
  getSheetByName(name: string): SheetInfo | null;
  insertSheet(title: string, options?: InsertSheetOptions): SheetInfo;
  hideSheet(name: string): void;

  /** Typed values (Apps Script `getValues`). */
  readRange(sheetName: string, a1: string): GridValues;
  /** Human-readable strings (Apps Script `getDisplayValues`). */
  readDisplayRange(sheetName: string, a1: string): string[][];
  /** Formula strings, blank where a cell holds a literal (`getFormulas`). */
  readFormulaRange(sheetName: string, a1: string): string[][];
  /** Bulk typed reads in one round-trip, in request order. */
  batchGet(ranges: RangeSpec[]): GridValues[];

  writeRange(sheetName: string, a1: string, values: GridValues): void;
  appendRows(sheetName: string, rows: GridValues): void;

  /** The atomic apply path. Applied as a single unit. */
  batchUpdate(request: SheetsBatchUpdateRequest): SheetsBatchUpdateResult;

  getDocumentLock(): DocumentLock;

  /** A fresh UUID (maps to `Utilities.getUuid()`). */
  newUuid(): string;
  /** Data extent of a sheet (maps to `getLastRow()`/`getLastColumn()`). */
  getGridSize(sheetName: string): { rowCount: number; columnCount: number };
  /** Hide a single zero-based column in a sheet (maps to `hideColumns`). */
  hideColumn(sheetName: string, columnIndex: number): void;
}
