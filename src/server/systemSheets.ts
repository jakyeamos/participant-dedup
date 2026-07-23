import type { CellValue } from "@/server/types";
import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { DedupConfig } from "@/shared/config";
import { SYSTEM_SHEETS } from "@/shared/constants";

export type TableRow = Record<string, CellValue>;

export type FieldKind = "str" | "num" | "bool" | "json";

export interface FieldSpec {
  col: string;
  key: string;
  kind: FieldKind;
}

// --- Column schemas (§8.1–8.7). Order here is the on-sheet column order. ------

export const CONFIG_FIELDS: FieldSpec[] = [
  { col: "config_key", key: "configKey", kind: "str" },
  { col: "value_json", key: "valueJson", kind: "json" },
  { col: "description", key: "description", kind: "str" },
  { col: "schema_version", key: "schemaVersion", kind: "num" },
  { col: "updated_at", key: "updatedAt", kind: "str" },
  { col: "updated_by", key: "updatedBy", kind: "str" },
];

export const BATCH_FIELDS: FieldSpec[] = [
  { col: "batch_id", key: "batchId", kind: "str" },
  { col: "source_spreadsheet_id", key: "sourceSpreadsheetId", kind: "str" },
  { col: "source_sheet_id", key: "sourceSheetId", kind: "num" },
  { col: "source_sheet_name", key: "sourceSheetName", kind: "str" },
  { col: "header_row", key: "headerRow", kind: "num" },
  { col: "source_last_row", key: "sourceLastRow", kind: "num" },
  { col: "source_last_col", key: "sourceLastCol", kind: "num" },
  { col: "schema_json", key: "schema", kind: "json" },
  { col: "schema_hash", key: "schemaHash", kind: "str" },
  { col: "config_hash", key: "configHash", kind: "str" },
  { col: "status", key: "status", kind: "str" },
  { col: "phase", key: "phase", kind: "str" },
  { col: "phase_cursor", key: "phaseCursor", kind: "str" },
  { col: "record_count", key: "recordCount", kind: "num" },
  { col: "candidate_count", key: "candidateCount", kind: "num" },
  { col: "qualified_edge_count", key: "qualifiedEdgeCount", kind: "num" },
  { col: "cluster_count", key: "clusterCount", kind: "num" },
  { col: "candidate_truncation_count", key: "candidateTruncationCount", kind: "num" },
  { col: "created_at", key: "createdAt", kind: "str" },
  { col: "created_by", key: "createdBy", kind: "str" },
  { col: "updated_at", key: "updatedAt", kind: "str" },
  { col: "error_code", key: "errorCode", kind: "str" },
  { col: "error_message", key: "errorMessage", kind: "str" },
  { col: "revision", key: "revision", kind: "num" },
];

export const RECORD_FIELDS: FieldSpec[] = [
  { col: "batch_id", key: "batchId", kind: "str" },
  { col: "dedup_id", key: "dedupId", kind: "str" },
  { col: "source_row_at_scan", key: "sourceRowAtScan", kind: "num" },
  { col: "row_fingerprint", key: "rowFingerprint", kind: "str" },
  { col: "relevant_hash", key: "relevantHash", kind: "str" },
  { col: "raw_values_json", key: "rawValues", kind: "json" },
  { col: "display_values_json", key: "displayValues", kind: "json" },
  { col: "formulas_json", key: "formulas", kind: "json" },
  { col: "normalized_json", key: "normalized", kind: "json" },
];

export const PAIR_FIELDS: FieldSpec[] = [
  { col: "batch_id", key: "batchId", kind: "str" },
  { col: "pair_key", key: "pairKey", kind: "str" },
  { col: "left_id", key: "leftId", kind: "str" },
  { col: "right_id", key: "rightId", kind: "str" },
  { col: "generation_reasons_json", key: "generationReasons", kind: "json" },
  { col: "pre_score", key: "preScore", kind: "num" },
  { col: "score_status", key: "scoreStatus", kind: "str" },
  { col: "score_json", key: "score", kind: "json" },
  { col: "qualified", key: "qualified", kind: "bool" },
];

export const CLUSTER_FIELDS: FieldSpec[] = [
  { col: "batch_id", key: "batchId", kind: "str" },
  { col: "cluster_id", key: "clusterId", kind: "str" },
  { col: "cluster_type", key: "clusterType", kind: "str" },
  { col: "member_ids_json", key: "memberIds", kind: "json" },
  { col: "core_member_ids_json", key: "coreMemberIds", kind: "json" },
  { col: "suggested_member_ids_json", key: "suggestedMemberIds", kind: "json" },
  { col: "edge_keys_json", key: "edgeKeys", kind: "json" },
  { col: "highest_confidence", key: "highestConfidence", kind: "str" },
  { col: "max_score", key: "maxScore", kind: "num" },
  { col: "warnings_json", key: "warnings", kind: "json" },
  { col: "status", key: "status", kind: "str" },
  { col: "revision", key: "revision", kind: "num" },
  { col: "decision_json", key: "decision", kind: "json" },
  { col: "reviewer_id", key: "reviewerId", kind: "str" },
  { col: "reviewed_at", key: "reviewedAt", kind: "str" },
  { col: "notes", key: "notes", kind: "str" },
  { col: "decision_hash", key: "decisionHash", kind: "str" },
  { col: "stale_reason", key: "staleReason", kind: "str" },
  { col: "apply_batch_id", key: "applyBatchId", kind: "str" },
  { col: "applied_at", key: "appliedAt", kind: "str" },
];

export const STATE_FIELDS: FieldSpec[] = [
  { col: "state_type", key: "stateType", kind: "str" },
  { col: "state_key", key: "stateKey", kind: "str" },
  { col: "value_json", key: "valueJson", kind: "json" },
  { col: "created_at", key: "createdAt", kind: "str" },
  { col: "updated_at", key: "updatedAt", kind: "str" },
];

export const AUDIT_FIELDS: FieldSpec[] = [
  { col: "event_id", key: "eventId", kind: "str" },
  { col: "event_type", key: "eventType", kind: "str" },
  { col: "event_at", key: "eventAt", kind: "str" },
  { col: "actor_id", key: "actorId", kind: "str" },
  { col: "actor_type", key: "actorType", kind: "str" },
  { col: "reviewer_id", key: "reviewerId", kind: "str" },
  { col: "batch_id", key: "batchId", kind: "str" },
  { col: "apply_batch_id", key: "applyBatchId", kind: "str" },
  { col: "cluster_id", key: "clusterId", kind: "str" },
  { col: "source_sheet_id", key: "sourceSheetId", kind: "num" },
  { col: "source_sheet_name", key: "sourceSheetName", kind: "str" },
  { col: "target_dedup_id", key: "targetDedupId", kind: "str" },
  { col: "related_ids_json", key: "relatedIds", kind: "json" },
  { col: "field_name", key: "fieldName", kind: "str" },
  { col: "before_value_json", key: "beforeValue", kind: "json" },
  { col: "after_value_json", key: "afterValue", kind: "json" },
  { col: "row_snapshot_json", key: "rowSnapshot", kind: "json" },
  { col: "confidence", key: "confidence", kind: "str" },
  { col: "score", key: "score", kind: "num" },
  { col: "reasons_json", key: "reasons", kind: "json" },
  { col: "warnings_json", key: "warnings", kind: "json" },
  { col: "result", key: "result", kind: "str" },
  { col: "error_code", key: "errorCode", kind: "str" },
  { col: "error_message", key: "errorMessage", kind: "str" },
];

export const SYSTEM_SHEET_FIELDS: Record<string, FieldSpec[]> = {
  [SYSTEM_SHEETS.config]: CONFIG_FIELDS,
  [SYSTEM_SHEETS.batches]: BATCH_FIELDS,
  [SYSTEM_SHEETS.records]: RECORD_FIELDS,
  [SYSTEM_SHEETS.pairs]: PAIR_FIELDS,
  [SYSTEM_SHEETS.clusters]: CLUSTER_FIELDS,
  [SYSTEM_SHEETS.state]: STATE_FIELDS,
  [SYSTEM_SHEETS.audit]: AUDIT_FIELDS,
};

// --- Codec ------------------------------------------------------------------

function encodeField(kind: FieldKind, value: unknown): CellValue {
  if (value === undefined || value === null) return "";
  if (kind === "json") return JSON.stringify(value);
  if (kind === "num") return typeof value === "number" ? value : Number(value);
  if (kind === "bool") return Boolean(value);
  return String(value);
}

function decodeField(kind: FieldKind, raw: CellValue): unknown {
  if (kind === "json") {
    return typeof raw === "string" && raw !== "" ? JSON.parse(raw) : null;
  }
  if (kind === "num") return raw === "" || raw === null ? null : Number(raw);
  if (kind === "bool") return raw === true || raw === "TRUE" || raw === "true";
  return raw === null ? "" : String(raw);
}

// --- Column geometry --------------------------------------------------------

export function colLetters(index0: number): string {
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isBlankRow(cells: CellValue[]): boolean {
  return cells.every((c) => c === "" || c === null);
}

/** A hidden system sheet as a header-plus-rows table. */
export class SheetTable {
  readonly columns: string[];
  private readonly lastCol: string;

  constructor(
    private readonly gateway: SheetsGateway,
    readonly sheetName: string,
    readonly fields: FieldSpec[],
  ) {
    this.columns = fields.map((f) => f.col);
    this.lastCol = colLetters(this.columns.length - 1);
  }

  ensure(): void {
    const info = this.gateway.getSheetByName(this.sheetName);
    if (!info) {
      this.gateway.insertSheet(this.sheetName, { hidden: true });
    } else if (!info.hidden) {
      this.gateway.hideSheet(this.sheetName);
    }
    const header = this.readGrid()[0] ?? [];
    const matches = this.columns.every((c, i) => header[i] === c);
    if (!matches) this.gateway.writeRange(this.sheetName, "A1", [[...this.columns]]);
  }

  private readGrid(): CellValue[][] {
    return this.gateway.readRange(this.sheetName, `A1:${this.lastCol}`);
  }

  private cellsFor(rec: Record<string, unknown>): CellValue[] {
    return this.fields.map((f) => encodeField(f.kind, rec[f.key]));
  }

  private recFor(cells: CellValue[]): TableRow {
    const rec: TableRow = {};
    this.fields.forEach((f, i) => {
      rec[f.key] = decodeField(f.kind, cells[i] ?? "") as CellValue;
    });
    return rec;
  }

  append(rec: Record<string, unknown>): void {
    this.gateway.appendRows(this.sheetName, [this.cellsFor(rec)]);
  }

  appendMany(recs: Record<string, unknown>[]): void {
    if (recs.length === 0) return;
    this.gateway.appendRows(
      this.sheetName,
      recs.map((r) => this.cellsFor(r)),
    );
  }

  rowsWithIndex(): Array<{ index: number; rec: TableRow }> {
    const grid = this.readGrid();
    const out: Array<{ index: number; rec: TableRow }> = [];
    for (let r = 1; r < grid.length; r++) {
      const cells = grid[r] ?? [];
      if (isBlankRow(cells)) continue;
      out.push({ index: r, rec: this.recFor(cells) });
    }
    return out;
  }

  rows(): TableRow[] {
    return this.rowsWithIndex().map((r) => r.rec);
  }

  writeAt(index: number, rec: Record<string, unknown>): void {
    this.gateway.writeRange(this.sheetName, `A${index + 1}`, [this.cellsFor(rec)]);
  }
}

export function tableFor(gateway: SheetsGateway, sheetName: string): SheetTable {
  const fields = SYSTEM_SHEET_FIELDS[sheetName];
  if (!fields) throw new Error(`Unknown system sheet: ${sheetName}`);
  return new SheetTable(gateway, sheetName, fields);
}

// --- Initialization ---------------------------------------------------------

export function nowIso(gateway: SheetsGateway): string {
  void gateway;
  return new Date().toISOString();
}

/**
 * Create (or migrate) every hidden system sheet, seed config defaults on first
 * run, and record the current schema version. Idempotent.
 */
export function ensureSystemSheets(gateway: SheetsGateway, cfg: DedupConfig): void {
  for (const sheetName of Object.values(SYSTEM_SHEETS)) {
    tableFor(gateway, sheetName).ensure();
  }

  const actor = gateway.getActiveUserEmail() ?? "unknown";
  const ts = nowIso(gateway);

  // Seed config defaults only on first run (empty config sheet).
  const configTable = tableFor(gateway, SYSTEM_SHEETS.config);
  if (configTable.rows().length === 0) {
    const rows = (Object.keys(cfg) as Array<keyof DedupConfig>).map((key) => ({
      configKey: key,
      valueJson: cfg[key],
      description: "",
      schemaVersion: cfg.schemaVersion,
      updatedAt: ts,
      updatedBy: actor,
    }));
    configTable.appendMany(rows);
  }

  // Record/migrate the schema version as a single SYSTEM state row.
  const stateTable = tableFor(gateway, SYSTEM_SHEETS.state);
  const existing = stateTable
    .rowsWithIndex()
    .find((r) => r.rec.stateType === "SYSTEM" && r.rec.stateKey === "schema_version");
  const stateRec = {
    stateType: "SYSTEM",
    stateKey: "schema_version",
    valueJson: cfg.schemaVersion,
    createdAt: existing ? existing.rec.createdAt : ts,
    updatedAt: ts,
  };
  if (existing) stateTable.writeAt(existing.index, stateRec);
  else stateTable.append(stateRec);
}
