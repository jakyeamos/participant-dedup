import { DedupError } from "@/server/errors";
import { schemaHash } from "@/server/hashing";
import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { SourceSchema } from "@/server/types";
import { DEDUP_ID_HEADER, type CanonicalField } from "@/shared/constants";
import { HEADER_ALIASES, type DedupConfig } from "@/shared/config";

/** Normalize a header cell: trim, lowercase, strip punctuation, collapse spaces. */
function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ALIAS_TO_FIELD = new Map<string, CanonicalField>();
for (const field of Object.keys(HEADER_ALIASES) as CanonicalField[]) {
  for (const alias of HEADER_ALIASES[field]) ALIAS_TO_FIELD.set(alias, field);
}

interface RowMatch {
  rowIndex: number; // 0-based within the searched block
  /** canonical field → column indexes that matched it (0-based). */
  matched: Map<CanonicalField, number[]>;
}

function matchRow(cells: string[]): RowMatch["matched"] {
  const matched = new Map<CanonicalField, number[]>();
  for (let col = 0; col < cells.length; col++) {
    const raw = cells[col] ?? "";
    if (raw.trim() === DEDUP_ID_HEADER) continue;
    const field = ALIAS_TO_FIELD.get(normalizeHeader(raw));
    if (!field) continue;
    const list = matched.get(field);
    if (list) list.push(col);
    else matched.set(field, [col]);
  }
  return matched;
}

function qualifies(matched: RowMatch["matched"]): boolean {
  return matched.has("first") && matched.has("last") && matched.size >= 3;
}

export function resolveSchema(
  gateway: SheetsGateway,
  sheetName: string,
  cfg: DedupConfig,
): SourceSchema {
  const block = gateway.readDisplayRange(sheetName, `1:${cfg.headerSearchRows}`);

  const rows: RowMatch[] = block.map((cells, rowIndex) => ({
    rowIndex,
    matched: matchRow(cells),
  }));

  const qualifying = rows.filter((r) => qualifies(r.matched));

  if (qualifying.length === 0) {
    // Distinguish "found a plausible header but missing First/Last" from noise.
    const best = rows
      .filter((r) => r.matched.size > 0)
      .sort((a, b) => b.matched.size - a.matched.size)[0];
    if (best && (!best.matched.has("first") || !best.matched.has("last"))) {
      throw new DedupError("MISSING_REQUIRED_HEADERS");
    }
    throw new DedupError("MISSING_REQUIRED_HEADERS");
  }

  const maxScore = Math.max(...qualifying.map((r) => r.matched.size));
  const top = qualifying.filter((r) => r.matched.size === maxScore);
  if (top.length > 1) throw new DedupError("HEADER_AMBIGUOUS");

  const header = top[0]!;
  const headerCells = block[header.rowIndex] ?? [];

  // Duplicate detection: any canonical field mapped by >1 column, or any
  // repeated nonblank normalized header string.
  for (const cols of header.matched.values()) {
    if (cols.length > 1) throw new DedupError("DUPLICATE_HEADERS");
  }
  const seen = new Set<string>();
  for (const raw of headerCells) {
    const norm = normalizeHeader(raw ?? "");
    if (!norm || (raw ?? "").trim() === DEDUP_ID_HEADER) continue;
    if (seen.has(norm)) throw new DedupError("DUPLICATE_HEADERS");
    seen.add(norm);
  }

  const columnByCanonicalField: Partial<Record<CanonicalField, number>> = {};
  for (const [field, cols] of header.matched) columnByCanonicalField[field] = cols[0]!;
  const canonicalColumns = new Set<number>(Object.values(columnByCanonicalField));

  let dedupIdColumnIndex = -1;
  const extraColumns: Array<{ header: string; columnIndex: number }> = [];
  for (let col = 0; col < headerCells.length; col++) {
    const raw = (headerCells[col] ?? "").trim();
    if (raw === DEDUP_ID_HEADER) {
      dedupIdColumnIndex = col;
      continue;
    }
    if (raw === "" || canonicalColumns.has(col)) continue;
    extraColumns.push({ header: raw, columnIndex: col });
  }

  const headers = headerCells.map((c) => c ?? "");
  const info = gateway.getSheetByName(sheetName);

  return {
    spreadsheetId: gateway.getSpreadsheetId(),
    sheetId: info?.sheetId ?? -1,
    sheetName,
    headerRow: header.rowIndex + 1,
    headers,
    normalizedHeaders: headers.map(normalizeHeader),
    columnByCanonicalField,
    extraColumns,
    dedupIdColumnIndex,
    schemaHash: schemaHash(headers, columnByCanonicalField),
  };
}
