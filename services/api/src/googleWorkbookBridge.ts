import { google, type sheets_v4 } from "googleapis";
import type { CellValue } from "@/server/types";
import { FakeSheetsGateway, type DumpedSheet } from "@/server/sheets/FakeSheetsGateway";
import { DEDUP_ID_HEADER, SYSTEM_SHEET_PREFIX, SYSTEM_SHEETS } from "@/shared/constants";
import { colLetters } from "@/server/systemSheets";

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export type BridgeLoadMode = "scan" | "status";

export interface BridgeLoadResult {
  gateway: FakeSheetsGateway;
  sheetsLoaded: number;
  sheetTitles: string[];
}

/** System sheets rewritten after a finished scan (config/state are left alone). */
const SCAN_OUTPUT_SHEETS = new Set<string>([
  SYSTEM_SHEETS.batches,
  SYSTEM_SHEETS.records,
  SYSTEM_SHEETS.pairs,
  SYSTEM_SHEETS.clusters,
  SYSTEM_SHEETS.audit,
]);

/** Lightweight progress flush while a background job is still running. */
const PROGRESS_SHEETS = new Set<string>([SYSTEM_SHEETS.batches, SYSTEM_SHEETS.audit]);

function parseCredentials(raw: string): ServiceAccountCredentials {
  const parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
  };
}

function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function cell(value: unknown): CellValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return value === null || value === undefined ? "" : String(value);
}

function grid(values: unknown[][] | undefined): CellValue[][] {
  return (values ?? []).map((row) => row.map(cell));
}

function formulaGrid(values: unknown[][] | undefined): string[][] {
  return (values ?? []).map((row) =>
    row.map((value) => (typeof value === "string" && value.startsWith("=") ? value : "")),
  );
}

function maxColumns(values: CellValue[][]): number {
  return values.reduce((max, row) => Math.max(max, row.length), 0);
}

function trimForWrite(values: CellValue[][]): CellValue[][] {
  let lastRow = values.length - 1;
  while (lastRow >= 0) {
    const row = values[lastRow] ?? [];
    if (row.some((value) => value !== "" && value !== null)) break;
    lastRow -= 1;
  }
  if (lastRow < 0) return [];
  const width = maxColumns(values.slice(0, lastRow + 1));
  return values.slice(0, lastRow + 1).map((row) => {
    const out: CellValue[] = [];
    for (let i = 0; i < width; i++) out.push(row[i] ?? "");
    return out;
  });
}

function shouldLoadTitle(title: string, sourceSheetName: string | null, mode: BridgeLoadMode): boolean {
  if (title.startsWith(SYSTEM_SHEET_PREFIX)) {
    if (mode === "status") {
      return title === SYSTEM_SHEETS.batches || title === SYSTEM_SHEETS.audit;
    }
    return true;
  }
  if (mode === "status") return false;
  return sourceSheetName !== null && title === sourceSheetName;
}

export class GoogleWorkbookBridge {
  private readonly sheets: sheets_v4.Sheets;

  constructor(serviceAccountJson: string) {
    const credentials = parseCredentials(serviceAccountJson);
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  /**
   * Load only the participant source sheet plus `_Dedup_*` system sheets.
   * `status` mode loads batches/audit only (cheap poll after restart).
   */
  async load(
    spreadsheetId: string,
    sourceSheetName: string | null,
    mode: BridgeLoadMode = "scan",
  ): Promise<BridgeLoadResult> {
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
    });
    const spreadsheet = meta.data;
    const timeZone = spreadsheet.properties?.timeZone ?? "Etc/UTC";
    const fake = new FakeSheetsGateway({
      spreadsheetId,
      timeZone,
      activeUserEmail: "remote-backend",
      activeSheetName: sourceSheetName,
    });

    const titles: string[] = [];
    for (const sheet of spreadsheet.sheets ?? []) {
      const props = sheet.properties;
      const title = props?.title;
      if (!title || !shouldLoadTitle(title, sourceSheetName, mode)) continue;
      titles.push(title);
      const range = quoteSheetName(title);
      const [typed, display, formula] = await Promise.all([
        this.sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
          valueRenderOption: "UNFORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING",
        }),
        this.sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
          valueRenderOption: "FORMATTED_VALUE",
        }),
        this.sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
          valueRenderOption: "FORMULA",
        }),
      ]);
      fake.loadSheet(title, {
        values: grid(typed.data.values as unknown[][] | undefined),
        display: grid(display.data.values as unknown[][] | undefined).map((row) =>
          row.map((value) => (value === null ? "" : String(value))),
        ),
        formulas: formulaGrid(formula.data.values as unknown[][] | undefined),
        hidden: props?.hidden ?? false,
        sheetId: props?.sheetId ?? undefined,
      });
    }

    if (mode === "scan" && sourceSheetName && !titles.includes(sourceSheetName)) {
      throw new Error(`Source sheet not found: ${sourceSheetName}`);
    }

    return { gateway: fake, sheetsLoaded: titles.length, sheetTitles: titles };
  }

  async flushScanOutputs(
    spreadsheetId: string,
    fake: FakeSheetsGateway,
    sourceSheetName: string,
  ): Promise<void> {
    const dumped = fake.dumpSheets();
    await this.ensureSystemSheets(spreadsheetId, dumped);

    for (const sheet of dumped) {
      if (!SCAN_OUTPUT_SHEETS.has(sheet.info.title)) continue;
      await this.replaceSheetValues(spreadsheetId, sheet);
    }

    const source = dumped.find((sheet) => sheet.info.title === sourceSheetName);
    if (source) await this.flushDedupIdColumn(spreadsheetId, source);
  }

  /** Mid-scan progress: batches (+ audit) only — keeps sidebar polls cheap. */
  async flushProgress(spreadsheetId: string, fake: FakeSheetsGateway): Promise<void> {
    const dumped = fake.dumpSheets();
    await this.ensureSystemSheets(spreadsheetId, dumped);
    for (const sheet of dumped) {
      if (!PROGRESS_SHEETS.has(sheet.info.title)) continue;
      await this.replaceSheetValues(spreadsheetId, sheet);
    }
  }

  /**
   * Local CLI flush: every `_Dedup_*` tab plus the participant source grid.
   * Used after scan / auto-review / apply so row deletions land in Google Sheets.
   */
  async flushCliOutputs(
    spreadsheetId: string,
    fake: FakeSheetsGateway,
    sourceSheetName: string | null,
  ): Promise<void> {
    const dumped = fake.dumpSheets();
    await this.ensureSystemSheets(spreadsheetId, dumped);
    for (const sheet of dumped) {
      if (!sheet.info.title.startsWith(SYSTEM_SHEET_PREFIX)) continue;
      await this.replaceSheetValues(spreadsheetId, sheet);
    }
    if (sourceSheetName) {
      const source = dumped.find((sheet) => sheet.info.title === sourceSheetName);
      if (source) await this.replaceSheetValues(spreadsheetId, source);
    }
  }

  private async ensureSystemSheets(spreadsheetId: string, dumped: DumpedSheet[]): Promise<void> {
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
    const existing = new Set((meta.data.sheets ?? []).map((sheet) => sheet.properties?.title ?? ""));
    const requests: sheets_v4.Schema$Request[] = [];
    for (const sheet of dumped) {
      if (!sheet.info.title.startsWith(SYSTEM_SHEET_PREFIX) || existing.has(sheet.info.title)) {
        continue;
      }
      requests.push({
        addSheet: {
          properties: {
            title: sheet.info.title,
            hidden: true,
          },
        },
      });
    }
    if (requests.length > 0) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });
    }
  }

  /**
   * Write values from A1, then clear only trailing rows if the sheet shrank —
   * avoids a full clear+rewrite round-trip when possible.
   */
  private async replaceSheetValues(spreadsheetId: string, sheet: DumpedSheet): Promise<void> {
    const title = quoteSheetName(sheet.info.title);
    const values = trimForWrite(sheet.values);
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
    });
    const live = (meta.data.sheets ?? []).find((s) => s.properties?.title === sheet.info.title);
    const existingRows = live?.properties?.gridProperties?.rowCount ?? 0;

    if (values.length === 0) {
      if (existingRows > 0) {
        await this.sheets.spreadsheets.values.clear({ spreadsheetId, range: title });
      }
      return;
    }

    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });

    if (existingRows > values.length) {
      const clearStart = values.length + 1;
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${title}!A${clearStart}:${colLetters(Math.max(0, maxColumns(values) - 1))}${existingRows}`,
      });
    }
  }

  private async flushDedupIdColumn(spreadsheetId: string, sheet: DumpedSheet): Promise<void> {
    const headerRowIndex = sheet.values.findIndex((row) => row.includes(DEDUP_ID_HEADER));
    if (headerRowIndex < 0) return;
    const idCol = sheet.values[headerRowIndex]!.findIndex((value) => value === DEDUP_ID_HEADER);
    if (idCol < 0) return;

    const col = colLetters(idCol);
    const values = sheet.values.slice(headerRowIndex).map((row) => [row[idCol] ?? ""]);
    const title = quoteSheetName(sheet.info.title);
    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!${col}${headerRowIndex + 1}`,
      valueInputOption: "RAW",
      requestBody: { values },
    });

    if (sheet.hiddenColumns.includes(idCol)) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateDimensionProperties: {
                range: {
                  sheetId: sheet.info.sheetId,
                  dimension: "COLUMNS",
                  startIndex: idCol,
                  endIndex: idCol + 1,
                },
                properties: { hiddenByUser: true },
                fields: "hiddenByUser",
              },
            },
          ],
        },
      });
    }
  }
}
