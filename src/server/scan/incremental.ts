import type { ClusterRecord } from "@/server/clustersRepository";
import type { RecordSnapshot } from "@/server/types";

export interface RecordDelta {
  addedIds: string[];
  changedIds: string[];
  removedIds: string[];
  unchangedIds: string[];
}

const UNFINISHED_STATUSES = new Set([
  "UNREVIEWED",
  "IN_PROGRESS",
  "UNRESOLVED",
  "STALE",
  "APPLY_ERROR",
]);

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function memberIdsOf(row: ClusterRecord): string[] {
  const raw = row.memberIds as unknown;
  return Array.isArray(raw) ? raw.map(String) : [];
}

function suggestedIdsOf(row: ClusterRecord): string[] {
  const raw = row.suggestedMemberIds as unknown;
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** Classifies source rows by stable `_Dedup_ID` and matching-relevant content. */
export function classifyRecordDelta(
  prior: ReadonlyArray<RecordSnapshot>,
  next: ReadonlyArray<RecordSnapshot>,
): RecordDelta {
  const priorById = new Map(prior.map((r) => [r.dedupId, r]));
  const nextById = new Map(next.map((r) => [r.dedupId, r]));

  const addedIds: string[] = [];
  const changedIds: string[] = [];
  const unchangedIds: string[] = [];

  for (const rec of next) {
    const before = priorById.get(rec.dedupId);
    if (!before) {
      addedIds.push(rec.dedupId);
    } else if (before.relevantHash !== rec.relevantHash) {
      changedIds.push(rec.dedupId);
    } else {
      unchangedIds.push(rec.dedupId);
    }
  }

  const removedIds = prior.filter((r) => !nextById.has(r.dedupId)).map((r) => r.dedupId);

  return {
    addedIds: sorted(addedIds),
    changedIds: sorted(changedIds),
    removedIds: sorted(removedIds),
    unchangedIds: sorted(unchangedIds),
  };
}

/**
 * IDs that must participate in a rescan. Unfinished clusters are included even
 * when unchanged so unresolved work does not disappear from the next queue.
 */
export function dirtyIds(delta: RecordDelta, priorClusters: ReadonlyArray<ClusterRecord>): string[] {
  const ids = new Set([...delta.addedIds, ...delta.changedIds]);

  for (const row of priorClusters) {
    if (!UNFINISHED_STATUSES.has(String(row.status))) continue;
    for (const id of memberIdsOf(row)) ids.add(id);
    for (const id of suggestedIdsOf(row)) ids.add(id);
  }

  return sorted(ids);
}

/**
 * READY_TO_APPLY decisions can move forward unchanged when every referenced row
 * still exists and has the same relevant hash.
 */
export function carriedReadyClusters(
  priorClusters: ReadonlyArray<ClusterRecord>,
  unchangedIds: ReadonlyArray<string>,
): ClusterRecord[] {
  const unchanged = new Set(unchangedIds);
  return priorClusters.filter((row) => {
    if (String(row.status) !== "READY_TO_APPLY") return false;
    const ids = [...memberIdsOf(row), ...suggestedIdsOf(row)];
    return ids.length > 0 && ids.every((id) => unchanged.has(id));
  });
}

