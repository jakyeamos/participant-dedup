import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { ClusterDecision, RecordSnapshot, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import type { ClusterStatus, ClusterType, Confidence, Warning } from "@/shared/constants";
import type { MergePlan } from "@/server/review/mergePlan";
import { DedupError } from "@/server/errors";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { buildMergePlan } from "@/server/review/mergePlan";
import { clusterFromRow } from "@/server/review/clusterRow";

/** One participant card in the cluster view (§21.6). */
export interface ClusterDetailRecord {
  dedupId: string;
  /** Sheet row at scan time — what `Open source row` navigates to. */
  sourceRow: number;
  label: string;
  /** §18.2 suggested members are shown but are not part of the core match. */
  role: "CORE" | "SUGGESTED";
  /** Display values, one per entry of `headers`. */
  values: string[];
}

/**
 * Everything the cluster review screen renders, as plain serializable values.
 *
 * Per-edge match reasons are deliberately absent: clustering deletes the pair
 * rows that carried them once a cluster exists, and the cluster row keeps only
 * the highest confidence, the top score, and the warnings. Those three are what
 * §21.6 can show about why the records matched.
 */
export interface ClusterDetail {
  batchId: string;
  clusterId: string;
  clusterType: ClusterType;
  confidence: Confidence;
  score: number;
  status: ClusterStatus;
  revision: number;
  warnings: Warning[];
  /** §18.3 too many members to delete from safely. */
  oversized: boolean;
  reviewerId: string;
  reviewedAt: string;
  notes: string;
  staleReason: string;
  headers: string[];
  records: ClusterDetailRecord[];
  /** Headers whose values disagree across the displayed records. */
  differingHeaders: string[];
  /** The stored decision, or null while the cluster is unreviewed. */
  decision: ClusterDecision | null;
  /**
   * The plan that decision implies, recomputed from the scan snapshots. Null
   * until a decision exists: §21.6 forbids opening a cluster from proposing
   * deletions on its own.
   */
  plan: MergePlan | null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** Name for the card, taken from the record's canonical name columns. */
function labelOf(record: RecordSnapshot, schema: SourceSchema): string {
  const parts: string[] = [];
  for (const field of ["first", "last"] as const) {
    const col = schema.columnByCanonicalField[field];
    const value = col === undefined ? "" : (record.displayValues[col] ?? "");
    if (value.trim() !== "") parts.push(value.trim());
  }
  return parts.join(" ");
}

/**
 * §21.6 One cluster, with its members' values and the fields they disagree on.
 * Read-only: nothing here changes a cluster's status or its revision.
 */
export function getClusterDetail(
  gateway: SheetsGateway,
  batchId: string,
  clusterId: string,
  cfg: DedupConfig,
): ClusterDetail {
  const batch = batchesRepository(gateway).get(batchId);
  if (!batch) throw new DedupError("BATCH_NOT_FOUND");

  const row = clustersRepository(gateway).get(clusterId);
  if (!row || String(row.batchId) !== batchId) throw new DedupError("CLUSTER_NOT_FOUND");

  const schema = batch.schema as unknown as SourceSchema;
  const headers = schema.headers;
  const snapshots = recordsRepository(gateway).readByBatch(batchId, headers);
  const byId = new Map(snapshots.map((r) => [r.dedupId, r]));

  const cluster = clusterFromRow(row);
  const roles: Array<[string, ClusterDetailRecord["role"]]> = [
    ...cluster.memberIds.map((id): [string, "CORE"] => [id, "CORE"]),
    ...cluster.suggestedMemberIds.map((id): [string, "SUGGESTED"] => [id, "SUGGESTED"]),
  ];

  const records: ClusterDetailRecord[] = [];
  for (const [dedupId, role] of roles) {
    const snapshot = byId.get(dedupId);
    if (!snapshot) continue;
    records.push({
      dedupId,
      sourceRow: snapshot.sourceRowAtScan,
      label: labelOf(snapshot, schema),
      role,
      values: headers.map((_, i) => snapshot.displayValues[i] ?? ""),
    });
  }
  records.sort((a, b) => a.sourceRow - b.sourceRow);

  // The id column differs by construction, so naming it would be noise.
  const differingHeaders = headers.filter((header, i) => {
    if (i === schema.dedupIdColumnIndex) return false;
    const first = records[0]?.values[i] ?? "";
    return records.some((r) => (r.values[i] ?? "") !== first);
  });

  const decision = (row.decision as ClusterDecision | null) ?? null;
  const plan = decision ? buildMergePlan(cluster, decision, snapshots, schema, cfg) : null;

  return {
    batchId,
    clusterId: cluster.clusterId,
    clusterType: cluster.clusterType,
    confidence: String(row.highestConfidence ?? "LOW") as Confidence,
    score: cluster.topScore,
    status: String(row.status) as ClusterStatus,
    revision: Number(row.revision ?? 0),
    warnings: asStrings(row.warnings) as Warning[],
    oversized: cluster.oversized,
    reviewerId: String(row.reviewerId ?? ""),
    reviewedAt: String(row.reviewedAt ?? ""),
    notes: String(row.notes ?? ""),
    staleReason: String(row.staleReason ?? ""),
    headers,
    records,
    differingHeaders,
    decision,
    plan,
  };
}
