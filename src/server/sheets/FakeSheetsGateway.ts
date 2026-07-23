import { DedupError } from "@/server/errors";
import type { CellValue } from "@/server/types";
import type {
  DocumentLock,
  ExtendedValue,
  GridRange,
  GridValues,
  InsertSheetOptions,
  RangeSpec,
  SheetInfo,
  SheetsBatchUpdateRequest,
  SheetsBatchUpdateResult,
  SheetsGateway,
} from "@/server/sheets/SheetsGateway";

export interface FakeGatewayOptions {
  spreadsheetId: string;
  timeZone?: string;
  activeUserEmail?: string | null;
  /** The sheet a menu click would act on. Unset means no active sheet. */
  activeSheetName?: string | null;
}

/** Where `activateCell` last put the cursor, for tests to assert on. */
export interface ActivatedCell {
  sheetName: string;
  row: number;
  column: number;
}

export interface LoadSheetOptions {
  values: GridValues;
  display?: string[][];
  formulas?: string[][];
  hidden?: boolean;
  sheetId?: number;
}

interface FakeSheet {
  info: SheetInfo;
  grid: GridValues;
  display?: string[][];
  formulas?: string[][];
}

interface ParsedRange {
  startRow: number;
  startCol: number;
  endRow: number | null; // exclusive; null = to grid end
  endCol: number | null; // exclusive; null = to grid end
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

function parseA1(a1: string): ParsedRange {
  const cell = (token: string): { row: number | null; col: number | null } => {
    const m = /^([A-Za-z]*)(\d*)$/.exec(token);
    if (!m) throw new Error(`Invalid A1 token: ${token}`);
    const [, letters, digits] = m;
    return {
      col: letters ? colLettersToIndex(letters) : null,
      row: digits ? Number(digits) - 1 : null,
    };
  };
  const [startToken, endToken] = a1.split(":");
  const start = cell(startToken ?? "");
  if (endToken === undefined) {
    // Single cell.
    return {
      startRow: start.row ?? 0,
      startCol: start.col ?? 0,
      endRow: start.row === null ? null : start.row + 1,
      endCol: start.col === null ? null : start.col + 1,
    };
  }
  const end = cell(endToken);
  return {
    startRow: start.row ?? 0,
    startCol: start.col ?? 0,
    endRow: end.row === null ? null : end.row + 1,
    endCol: end.col === null ? null : end.col + 1,
  };
}

function extendedToCell(value: ExtendedValue | undefined): CellValue {
  if (!value) return "";
  if ("stringValue" in value) return value.stringValue;
  if ("numberValue" in value) return value.numberValue;
  if ("boolValue" in value) return value.boolValue;
  return "";
}

function toDisplay(value: CellValue): string {
  if (value === null) return "";
  return typeof value === "string" ? value : String(value);
}

class FakeDocumentLock implements DocumentLock {
  private held = false;
  constructor(private readonly state: { holder: FakeDocumentLock | null }) {}

  acquire(_timeoutMs: number): void {
    void _timeoutMs;
    if (this.state.holder && this.state.holder !== this) {
      throw new DedupError("LOCK_TIMEOUT");
    }
    this.state.holder = this;
    this.held = true;
  }

  release(): void {
    if (this.state.holder === this) this.state.holder = null;
    this.held = false;
  }

  hasLock(): boolean {
    return this.held && this.state.holder === this;
  }
}

export class FakeSheetsGateway implements SheetsGateway {
  private readonly spreadsheetId: string;
  private readonly timeZone: string;
  private readonly activeUserEmail: string | null;
  private readonly sheets = new Map<string, FakeSheet>();
  private nextSheetId = 1;
  private uuidSeq = 0;
  private lastBatchUpdate: SheetsBatchUpdateRequest | null = null;
  private readonly lockState: { holder: FakeDocumentLock | null } = { holder: null };
  private readonly hiddenColumns = new Set<string>();
  private activeSheetName: string | null = null;
  private lastActivatedCell: ActivatedCell | null = null;

  constructor(options: FakeGatewayOptions) {
    this.spreadsheetId = options.spreadsheetId;
    this.timeZone = options.timeZone ?? "America/New_York";
    this.activeUserEmail = options.activeUserEmail ?? null;
    this.activeSheetName = options.activeSheetName ?? null;
  }

  loadSheet(name: string, options: LoadSheetOptions): SheetInfo {
    const info: SheetInfo = {
      sheetId: options.sheetId ?? this.nextSheetId++,
      title: name,
      index: this.sheets.size,
      hidden: options.hidden ?? false,
    };
    if (options.sheetId !== undefined && options.sheetId >= this.nextSheetId) {
      this.nextSheetId = options.sheetId + 1;
    }
    this.sheets.set(name, {
      info,
      grid: options.values.map((row) => [...row]),
      display: options.display?.map((row) => [...row]),
      formulas: options.formulas?.map((row) => [...row]),
    });
    return info;
  }

  private require(name: string): FakeSheet {
    const sheet = this.sheets.get(name);
    if (!sheet) throw new Error(`Sheet not found: ${name}`);
    return sheet;
  }

  private requireById(sheetId: number): FakeSheet {
    for (const sheet of this.sheets.values()) {
      if (sheet.info.sheetId === sheetId) return sheet;
    }
    throw new Error(`Sheet id not found: ${sheetId}`);
  }

  getSpreadsheetId(): string {
    return this.spreadsheetId;
  }

  getTimeZone(): string {
    return this.timeZone;
  }

  getActiveUserEmail(): string | null {
    return this.activeUserEmail;
  }

  listSheets(): SheetInfo[] {
    return [...this.sheets.values()]
      .map((s) => ({ ...s.info }))
      .sort((a, b) => a.index - b.index);
  }

  getSheetByName(name: string): SheetInfo | null {
    const sheet = this.sheets.get(name);
    return sheet ? { ...sheet.info } : null;
  }

  getActiveSheetName(): string | null {
    return this.activeSheetName;
  }

  /** Test hook: put the user on a sheet, as clicking its tab would. */
  setActiveSheet(name: string | null): void {
    if (name !== null) this.require(name);
    this.activeSheetName = name;
  }

  insertSheet(title: string, options?: InsertSheetOptions): SheetInfo {
    const existing = this.sheets.get(title);
    if (existing) return { ...existing.info };
    return this.loadSheet(title, { values: [], hidden: options?.hidden ?? false });
  }

  hideSheet(name: string): void {
    this.require(name).info.hidden = true;
  }

  private slice<T>(grid: T[][], range: ParsedRange, fill: T): T[][] {
    const endRow = range.endRow ?? grid.length;
    const out: T[][] = [];
    for (let r = range.startRow; r < endRow; r++) {
      const row = grid[r] ?? [];
      const endCol = range.endCol ?? row.length;
      const outRow: T[] = [];
      for (let c = range.startCol; c < endCol; c++) {
        outRow.push((row[c] ?? fill) as T);
      }
      out.push(outRow);
    }
    return out;
  }

  readRange(sheetName: string, a1: string): GridValues {
    const sheet = this.require(sheetName);
    return this.slice(sheet.grid, parseA1(a1), "");
  }

  readDisplayRange(sheetName: string, a1: string): string[][] {
    const sheet = this.require(sheetName);
    if (sheet.display) return this.slice(sheet.display, parseA1(a1), "");
    return this.slice(sheet.grid, parseA1(a1), "").map((row) => row.map(toDisplay));
  }

  readFormulaRange(sheetName: string, a1: string): string[][] {
    const sheet = this.require(sheetName);
    const source = sheet.formulas ?? sheet.grid.map((row) => row.map(() => ""));
    return this.slice(source, parseA1(a1), "");
  }

  batchGet(ranges: RangeSpec[]): GridValues[] {
    return ranges.map((r) => this.readRange(r.sheetName, r.a1));
  }

  private ensureCell(grid: GridValues, row: number, col: number): void {
    while (grid.length <= row) grid.push([]);
    const target = grid[row]!;
    while (target.length <= col) target.push("");
  }

  writeRange(sheetName: string, a1: string, values: GridValues): void {
    const sheet = this.require(sheetName);
    const { startRow, startCol } = parseA1(a1);
    for (let i = 0; i < values.length; i++) {
      const row = values[i]!;
      for (let j = 0; j < row.length; j++) {
        this.ensureCell(sheet.grid, startRow + i, startCol + j);
        sheet.grid[startRow + i]![startCol + j] = row[j]!;
      }
    }
  }

  appendRows(sheetName: string, rows: GridValues): void {
    const sheet = this.require(sheetName);
    for (const row of rows) sheet.grid.push([...row]);
  }

  getLastBatchUpdate(): SheetsBatchUpdateRequest | null {
    return this.lastBatchUpdate;
  }

  batchUpdate(request: SheetsBatchUpdateRequest): SheetsBatchUpdateResult {
    this.lastBatchUpdate = request;
    for (const req of request.requests) {
      if ("deleteDimension" in req) {
        const { sheetId, dimension, startIndex, endIndex } = req.deleteDimension.range;
        if (dimension !== "ROWS") throw new Error("Only ROWS deletion is supported");
        const sheet = this.requireById(sheetId);
        sheet.grid.splice(startIndex, endIndex - startIndex);
        sheet.display?.splice(startIndex, endIndex - startIndex);
        sheet.formulas?.splice(startIndex, endIndex - startIndex);
      } else if ("updateCells" in req) {
        const { range, rows } = req.updateCells;
        const sheet = this.requireById(range.sheetId);
        const startRow = range.startRowIndex ?? 0;
        const startCol = range.startColumnIndex ?? 0;
        for (let i = 0; i < rows.length; i++) {
          const cells = rows[i]!.values;
          for (let j = 0; j < cells.length; j++) {
            this.ensureCell(sheet.grid, startRow + i, startCol + j);
            sheet.grid[startRow + i]![startCol + j] = extendedToCell(cells[j]!.userEnteredValue);
          }
        }
      } else if ("copyPaste" in req) {
        const { source, destination } = req.copyPaste;
        const src = this.requireById(source.sheetId);
        const dst = this.requireById(destination.sheetId);
        const copied = this.slice(
          src.grid,
          {
            startRow: source.startRowIndex ?? 0,
            startCol: source.startColumnIndex ?? 0,
            endRow: source.endRowIndex ?? null,
            endCol: source.endColumnIndex ?? null,
          },
          "",
        );
        const dr = destination.startRowIndex ?? 0;
        const dc = destination.startColumnIndex ?? 0;
        for (let i = 0; i < copied.length; i++) {
          for (let j = 0; j < copied[i]!.length; j++) {
            this.ensureCell(dst.grid, dr + i, dc + j);
            dst.grid[dr + i]![dc + j] = copied[i]![j]!;
          }
        }
      } else if ("appendCells" in req) {
        const sheet = this.requireById(req.appendCells.sheetId);
        for (const rowData of req.appendCells.rows) {
          sheet.grid.push(rowData.values.map((c) => extendedToCell(c.userEnteredValue)));
        }
      }
    }
    return { replies: request.requests.length };
  }

  getDocumentLock(): DocumentLock {
    return new FakeDocumentLock(this.lockState);
  }

  newUuid(): string {
    this.uuidSeq += 1;
    const h = this.uuidSeq.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${h}`;
  }

  getGridSize(sheetName: string): { rowCount: number; columnCount: number } {
    const sheet = this.require(sheetName);
    const columnCount = sheet.grid.reduce((m, row) => Math.max(m, row.length), 0);
    return { rowCount: sheet.grid.length, columnCount };
  }

  hideColumn(sheetName: string, columnIndex: number): void {
    this.require(sheetName);
    this.hiddenColumns.add(`${sheetName}:${columnIndex}`);
  }

  isColumnHidden(sheetName: string, columnIndex: number): boolean {
    return this.hiddenColumns.has(`${sheetName}:${columnIndex}`);
  }

  activateCell(sheetName: string, row: number, column: number): void {
    const sheet = this.require(sheetName);
    if (row < 1 || column < 1) {
      throw new Error(`Cell out of range: ${sheetName}!${row}:${column}`);
    }
    this.activeSheetName = sheet.info.title;
    this.lastActivatedCell = { sheetName: sheet.info.title, row, column };
  }

  /** Test hook: the cell `activateCell` last selected. */
  activatedCell(): ActivatedCell | null {
    return this.lastActivatedCell ? { ...this.lastActivatedCell } : null;
  }
}
