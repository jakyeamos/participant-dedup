import type { Cluster, ClusterDecision, RecordSnapshot, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import type { CanonicalField, Warning } from "@/shared/constants";

/** §22.3 Identity fields a reviewer must edit by hand — never auto-filled. */
const PROTECTED_CANONICAL_FIELDS: CanonicalField[] = ["first", "middle", "last", "dob"];

export type MergePlanIssue =
  | "NO_RETAINED"
  | "UNASSIGNED_MEMBER"
  | "SELF_TARGET"
  | "UNKNOWN_ID"
  | "TARGET_NOT_RETAINED"
  | "OVERSIZED_CLUSTER"
  | "UNRESOLVED_CONFLICT";

export interface MergeFill {
  retainedId: string;
  header: string;
  value: string;
  sourceId: string;
}

export interface MergeDeletion {
  deletedId: string;
  retainedId: string;
}

export interface MergeConflict {
  retainedId: string;
  header: string;
  options: string[];
}

export interface MergePlan {
  clusterId: string;
  retainedIds: string[];
  fills: MergeFill[];
  deletions: MergeDeletion[];
  conflicts: MergeConflict[];
  warnings: Warning[];
  issues: MergePlanIssue[];
  ok: boolean;
}

/** §22.5 step 3: values are compared case- and whitespace-insensitively. */
function comparisonKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isFormula(rec: RecordSnapshot, index: number): boolean {
  return String(rec.formulas[index] ?? "").trim() !== "";
}

function displayAt(rec: RecordSnapshot, header: string): string {
  return String(rec.displayByHeader[header] ?? "");
}

function protectedHeaders(schema: SourceSchema): Set<string> {
  const out = new Set<string>();
  for (const field of PROTECTED_CANONICAL_FIELDS) {
    const col = schema.columnByCanonicalField[field];
    if (col === undefined) continue;
    const header = schema.headers[col];
    if (header !== undefined) out.add(header);
  }
  const idHeader = schema.headers[schema.dedupIdColumnIndex];
  if (idHeader !== undefined) out.add(idHeader);
  return out;
}

function bySourceOrder(a: RecordSnapshot, b: RecordSnapshot): number {
  if (a.sourceRowAtScan !== b.sourceRowAtScan) return a.sourceRowAtScan - b.sourceRowAtScan;
  return a.dedupId < b.dedupId ? -1 : a.dedupId > b.dedupId ? 1 : 0;
}

function emptyPlan(cluster: Cluster, retainedIds: string[], issues: MergePlanIssue[]): MergePlan {
  return {
    clusterId: cluster.clusterId,
    retainedIds,
    fills: [],
    deletions: [],
    conflicts: [],
    warnings: [],
    issues,
    ok: issues.length === 0,
  };
}

/**
 * §22 Recomputes a cluster's merge plan from the scan snapshots. The browser
 * sends only choices — every value written here comes from a snapshot, never
 * from the client. A plan with unresolved conflicts or a failed validation is
 * returned with `ok: false` rather than thrown, so the sidebar can show the
 * reviewer exactly what still needs a decision.
 */
export function buildMergePlan(
  cluster: Cluster,
  decision: ClusterDecision,
  records: RecordSnapshot[],
  schema: SourceSchema,
  _cfg: DedupConfig,
): MergePlan {
  const byId = new Map(records.map((r) => [r.dedupId, r]));
  const known = new Set([...cluster.memberIds, ...cluster.suggestedMemberIds]);

  // §22.1 Keep All retains every displayed member and plans nothing.
  if (decision.mode === "KEEP_ALL") {
    return emptyPlan(cluster, [...cluster.memberIds], []);
  }

  const retainedIds = decision.retainedIds.filter((id) => byId.has(id) || known.has(id));
  const assignments = Object.entries(decision.deleteAssignments);
  const issues = new Set<MergePlanIssue>();

  // §22.2 validation.
  if (decision.retainedIds.length === 0) issues.add("NO_RETAINED");
  const retainedSet = new Set(decision.retainedIds);
  for (const id of decision.retainedIds) {
    if (!known.has(id) || !byId.has(id)) issues.add("UNKNOWN_ID");
  }
  for (const [deletedId, targetId] of assignments) {
    if (!known.has(deletedId) || !byId.has(deletedId)) issues.add("UNKNOWN_ID");
    if (!known.has(targetId) || !byId.has(targetId)) issues.add("UNKNOWN_ID");
    if (deletedId === targetId) issues.add("SELF_TARGET");
    else if (!retainedSet.has(targetId)) issues.add("TARGET_NOT_RETAINED");
    if (retainedSet.has(deletedId)) issues.add("TARGET_NOT_RETAINED");
  }
  for (const id of cluster.memberIds) {
    if (!retainedSet.has(id) && !(id in decision.deleteAssignments)) {
      issues.add("UNASSIGNED_MEMBER");
    }
  }

  // §18.3 an oversized cluster needs manual cleanup; nothing may be deleted.
  if (cluster.oversized && assignments.length > 0) {
    issues.add("OVERSIZED_CLUSTER");
    return emptyPlan(cluster, retainedIds, [...issues]);
  }
  if (issues.size > 0) return emptyPlan(cluster, retainedIds, [...issues]);

  const deletionRecords = assignments
    .map(([deletedId, retainedId]) => ({ rec: byId.get(deletedId)!, retainedId }))
    .sort((a, b) => bySourceOrder(a.rec, b.rec));

  const deletions: MergeDeletion[] = deletionRecords.map((d) => ({
    deletedId: d.rec.dedupId,
    retainedId: d.retainedId,
  }));

  const protectedSet = protectedHeaders(schema);
  const warnings = new Set<Warning>();
  const fills: MergeFill[] = [];
  const conflicts: MergeConflict[] = [];

  // §22.5 automatic proposal, per retained target and eligible header.
  for (const retainedId of decision.retainedIds) {
    const target = byId.get(retainedId);
    if (!target) continue;
    // §22.5 rule 6: only records being deleted into this target are sources.
    const sources = deletionRecords
      .filter((d) => d.retainedId === retainedId)
      .map((d) => d.rec);
    if (sources.length === 0) continue;

    schema.headers.forEach((header, columnIndex) => {
      if (protectedSet.has(header)) return;

      // §22.4 a formula target is never blank, so it is never a fill site.
      if (isFormula(target, columnIndex)) {
        warnings.add("FORMULA_FIELD_SKIPPED");
        return;
      }
      if (displayAt(target, header).trim() !== "") return;

      const candidates: Array<{ rec: RecordSnapshot; value: string }> = [];
      for (const source of sources) {
        if (isFormula(source, columnIndex)) {
          warnings.add("FORMULA_FIELD_SKIPPED");
          continue;
        }
        const value = displayAt(source, header);
        if (value.trim() === "") continue;
        candidates.push({ rec: source, value });
      }
      if (candidates.length === 0) return;

      const groups = new Map<string, { rec: RecordSnapshot; value: string }>();
      for (const candidate of candidates) {
        const key = comparisonKey(candidate.value);
        if (!groups.has(key)) groups.set(key, candidate);
      }

      const choice = decision.fieldChoices[retainedId]?.[header];
      if (choice?.mode === "LEAVE_BLANK") return;
      if (choice?.mode === "SOURCE") {
        const picked = candidates.find((c) => c.rec.dedupId === choice.sourceId);
        if (picked) {
          fills.push({ retainedId, header, value: picked.value, sourceId: picked.rec.dedupId });
        }
        return;
      }

      if (groups.size === 1) {
        const [only] = [...groups.values()];
        if (only) {
          fills.push({ retainedId, header, value: only.value, sourceId: only.rec.dedupId });
        }
        return;
      }

      // §22.5 rule 5: multiple distinct values need an explicit reviewer choice.
      conflicts.push({
        retainedId,
        header,
        options: [...groups.values()].map((g) => g.value),
      });
    });
  }

  if (conflicts.length > 0) issues.add("UNRESOLVED_CONFLICT");

  return {
    clusterId: cluster.clusterId,
    retainedIds,
    fills,
    deletions,
    conflicts,
    warnings: [...warnings],
    issues: [...issues],
    ok: issues.size === 0,
  };
}
