import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type {
  CellValue,
  NormalizedParticipant,
  RecordSnapshot,
  SourceSchema,
} from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import { colLetters } from "@/server/systemSheets";
import { relevantHash, rowFingerprint } from "@/server/hashing";
import { normalizeParticipant } from "@/server/match/normalizeParticipant";

function isBlank(value: CellValue | undefined): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

/** Flatten the normalized fields that define a participant's identity (§13). */
function relevantFields(n: NormalizedParticipant): Record<string, string | null> {
  const out: Record<string, string | null> = {
    name_ordered: n.name.orderedNoMiddle || null,
    name_sorted: n.name.sortedTokenSignature || null,
    middle: n.name.middleTokens.join(" ") || null,
    dob: n.dob.value,
    zip: n.zip,
    address: n.address?.full ?? null,
    city: n.city,
    state: n.state,
    county: n.county,
  };
  for (const [k, v] of Object.entries(n.extras)) out[`extra:${k}`] = v;
  return out;
}

function toStrings(cells: ReadonlyArray<CellValue>, width: number): string[] {
  const out: string[] = [];
  for (let c = 0; c < width; c++) {
    const v = cells[c];
    out.push(v === null || v === undefined ? "" : String(v));
  }
  return out;
}

/**
 * §12 snapshot builder. Bulk-reads every data row's typed/display/formula cells
 * and materializes an immutable {@link RecordSnapshot} per participant row. The
 * fingerprint excludes the system-managed `_Dedup_ID` column so ID assignment
 * never counts as a participant edit. Non-participant rows (every mapped and
 * extra column blank) are skipped.
 */
export function buildSnapshots(
  gateway: SheetsGateway,
  batchId: string,
  schema: SourceSchema,
  cfg: DedupConfig,
  tz: string,
): RecordSnapshot[] {
  const sheetName = schema.sheetName;
  const width = schema.headers.length;
  const { rowCount } = gateway.getGridSize(sheetName);
  const dataStart = schema.headerRow + 1;
  if (rowCount < dataStart) return [];

  const lastCol = colLetters(width - 1);
  const a1 = `A${dataStart}:${lastCol}${rowCount}`;
  const rawBlock = gateway.readRange(sheetName, a1);
  const displayBlock = gateway.readDisplayRange(sheetName, a1);
  const formulaBlock = gateway.readFormulaRange(sheetName, a1);

  const idCol = schema.dedupIdColumnIndex;
  const relevantCols = [
    ...Object.values(schema.columnByCanonicalField),
    ...schema.extraColumns.map((e) => e.columnIndex),
  ];

  const out: RecordSnapshot[] = [];
  for (let i = 0; i < rawBlock.length; i++) {
    const rawRow = rawBlock[i] ?? [];
    if (!relevantCols.some((c) => !isBlank(rawRow[c]))) continue; // non-participant row

    const rawValues: CellValue[] = [];
    for (let c = 0; c < width; c++) rawValues.push(rawRow[c] ?? null);
    const displayValues = toStrings(displayBlock[i] ?? [], width);
    const formulas = toStrings(formulaBlock[i] ?? [], width);

    const valuesByHeader: Record<string, CellValue> = {};
    const displayByHeader: Record<string, string> = {};
    schema.headers.forEach((h, c) => {
      valuesByHeader[h] = rawValues[c] ?? null;
      displayByHeader[h] = displayValues[c] ?? "";
    });

    const normalized = normalizeParticipant(valuesByHeader, displayByHeader, schema, tz, cfg);

    const fpHeaders: string[] = [];
    const fpRaw: CellValue[] = [];
    const fpDisplay: string[] = [];
    const fpFormula: string[] = [];
    for (let c = 0; c < width; c++) {
      if (c === idCol) continue; // exclude _Dedup_ID from the change fingerprint
      fpHeaders.push(schema.headers[c] ?? "");
      fpRaw.push(rawValues[c] ?? null);
      fpDisplay.push(displayValues[c] ?? "");
      fpFormula.push(formulas[c] ?? "");
    }

    out.push({
      batchId,
      dedupId: idCol >= 0 ? String(rawValues[idCol] ?? "") : "",
      sourceRowAtScan: dataStart + i,
      rowFingerprint: rowFingerprint(fpHeaders, fpRaw, fpDisplay, fpFormula),
      relevantHash: relevantHash(relevantFields(normalized)),
      rawValues,
      displayValues,
      formulas,
      valuesByHeader,
      displayByHeader,
      normalized,
    });
  }
  return out;
}
