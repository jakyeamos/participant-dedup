import type {
  Cluster,
  ClusterDecision,
  FieldChoice,
  RecordSnapshot,
  SourceSchema,
} from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import { buildMergePlan } from "@/server/review/mergePlan";

/** Case/whitespace-insensitive compare matching mergePlan. */
function comparisonKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Prefer the row that carries more usable data. Each non-blank field scores a
 * base point plus a length bonus so a more complete value beats a stub when
 * fill counts are equal (e.g. full address vs street-only).
 */
export function informationScore(rec: RecordSnapshot, schema: SourceSchema): number {
  let score = 0;
  schema.headers.forEach((header, columnIndex) => {
    if (columnIndex === schema.dedupIdColumnIndex) return;
    const value = String(rec.displayByHeader[header] ?? "").trim();
    if (value === "") return;
    score += 100 + Math.min(50, value.length);
  });
  return score;
}

/** Among candidate ids, keep the richest snapshot (tie-break: earlier sheet row). */
export function pickRichestId(
  candidateIds: readonly string[],
  records: readonly RecordSnapshot[],
  schema: SourceSchema,
): string {
  if (candidateIds.length === 0) {
    throw new Error("pickRichestId requires at least one candidate");
  }
  const byId = new Map(records.map((r) => [r.dedupId, r]));
  let bestId = candidateIds[0]!;
  let bestScore = -1;
  let bestRow = Number.POSITIVE_INFINITY;
  for (const id of candidateIds) {
    const rec = byId.get(id);
    if (!rec) continue;
    const score = informationScore(rec, schema);
    if (score > bestScore || (score === bestScore && rec.sourceRowAtScan < bestRow)) {
      bestId = id;
      bestScore = score;
      bestRow = rec.sourceRowAtScan;
    }
  }
  return bestId;
}

/**
 * When several deleted rows offer different values for the same blank field,
 * keep the longer (more informative) option.
 */
export function fieldChoicesPreferMoreInfo(
  conflicts: Array<{ retainedId: string; header: string; options: string[] }>,
  records: readonly RecordSnapshot[],
  deletedIds: readonly string[],
): Record<string, Record<string, FieldChoice>> {
  const fieldChoices: Record<string, Record<string, FieldChoice>> = {};
  const deleted = new Set(deletedIds);
  const sources = records.filter((r) => deleted.has(r.dedupId));

  for (const conflict of conflicts) {
    let bestValue = "";
    let bestSourceId: string | null = null;
    for (const option of conflict.options) {
      const optionKey = comparisonKey(option);
      if (optionKey === "") continue;
      const source = sources.find(
        (r) => comparisonKey(String(r.displayByHeader[conflict.header] ?? "")) === optionKey,
      );
      if (!source) continue;
      const len = option.trim().length;
      const bestLen = bestValue.trim().length;
      const better =
        bestSourceId === null ||
        len > bestLen ||
        (len === bestLen && optionKey < comparisonKey(bestValue));
      if (!better) continue;
      bestValue = option;
      bestSourceId = source.dedupId;
    }
    if (!fieldChoices[conflict.retainedId]) fieldChoices[conflict.retainedId] = {};
    fieldChoices[conflict.retainedId]![conflict.header] = bestSourceId
      ? { mode: "SOURCE", sourceId: bestSourceId }
      : { mode: "LEAVE_BLANK" };
  }
  return fieldChoices;
}

export interface RichestMergeResult {
  decision: ClusterDecision;
  retainedId: string;
  deletedIds: string[];
  fillCount: number;
  conflictResolutions: number;
  retainedScore: number;
  deletedScores: Array<{ id: string; score: number }>;
}

/** Keep a specific core id; merge blanks from the other cores; auto-resolve conflicts. */
export function buildMergeDecisionForKeeper(args: {
  batchId: string;
  cluster: Cluster;
  expectedRevision: number;
  retainedId: string;
  deletedIds: readonly string[];
  records: readonly RecordSnapshot[];
  schema: SourceSchema;
  cfg: DedupConfig;
  notes: string;
}): RichestMergeResult | null {
  const {
    batchId,
    cluster,
    expectedRevision,
    retainedId,
    deletedIds,
    records,
    schema,
    cfg,
    notes,
  } = args;
  if (deletedIds.length === 0) return null;

  const byId = new Map(records.map((r) => [r.dedupId, r]));
  let fieldChoices: Record<string, Record<string, FieldChoice>> = {};
  let conflictResolutions = 0;
  let fillCount = 0;

  for (let guard = 0; guard < 8; guard += 1) {
    const provisional: ClusterDecision = {
      batchId,
      clusterId: cluster.clusterId,
      expectedRevision,
      mode: "SELECT_RECORDS",
      retainedIds: [retainedId],
      deleteAssignments: Object.fromEntries(deletedIds.map((id) => [id, retainedId])),
      fieldChoices,
      notes,
    };
    const plan = buildMergePlan(cluster, provisional, [...records], schema, cfg);
    fillCount = plan.fills.length;
    if (plan.ok) {
      return {
        decision: provisional,
        retainedId,
        deletedIds: [...deletedIds],
        fillCount,
        conflictResolutions,
        retainedScore: informationScore(byId.get(retainedId)!, schema),
        deletedScores: deletedIds.map((id) => ({
          id,
          score: informationScore(byId.get(id)!, schema),
        })),
      };
    }
    if (plan.conflicts.length === 0) return null;
    const resolved = fieldChoicesPreferMoreInfo(plan.conflicts, records, deletedIds);
    conflictResolutions += plan.conflicts.length;
    for (const [targetId, headers] of Object.entries(resolved)) {
      if (!fieldChoices[targetId]) fieldChoices[targetId] = {};
      Object.assign(fieldChoices[targetId]!, headers);
    }
  }
  return null;
}

/**
 * Build a ready-to-save SELECT_RECORDS decision: keep the richest core member,
 * delete other cores into it, auto-fill blanks (including name/DOB), and resolve
 * multi-value conflicts by preferring the longer value.
 */
export function buildRichestMergeDecision(args: {
  batchId: string;
  cluster: Cluster;
  expectedRevision: number;
  coreIds: readonly string[];
  records: readonly RecordSnapshot[];
  schema: SourceSchema;
  cfg: DedupConfig;
  notes: string;
}): RichestMergeResult | null {
  const { coreIds, records, schema, batchId, cluster, expectedRevision, cfg, notes } = args;
  if (coreIds.length < 2) return null;
  const retainedId = pickRichestId(coreIds, records, schema);
  const deletedIds = coreIds.filter((id) => id !== retainedId);
  return buildMergeDecisionForKeeper({
    batchId,
    cluster,
    expectedRevision,
    retainedId,
    deletedIds,
    records,
    schema,
    cfg,
    notes,
  });
}
