import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { Cluster, ClusterDecision, RecordSnapshot, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import type { ClusterStatus } from "@/shared/constants";
import type { MergePlan } from "@/server/review/mergePlan";
import { DedupError, type DedupErrorCode } from "@/server/errors";
import { decisionHash } from "@/server/hashing";
import { actorTypeOf, resolveReviewer } from "@/server/identity";
import { auditRepository } from "@/server/auditRepository";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { resolveSchema } from "@/server/schemaResolver";
import { buildSnapshots } from "@/server/scan/snapshot";
import { buildMergePlan } from "@/server/review/mergePlan";
import { clusterFromRow } from "@/server/review/clusterRow";
import { clearKeepAll, recordKeepAll } from "@/server/review/suppression";
import { nowIso } from "@/server/systemSheets";

const SAVE_LOCK_TIMEOUT_MS = 30_000;

export interface SavedDecision {
  clusterId: string;
  status: ClusterStatus;
  revision: number;
  reviewerId: string;
  reviewedAt: string;
  decisionHash: string;
  /**
   * The decision as persisted. Its `expectedRevision` is the revision the row
   * now holds, so the apply path can submit it back unchanged.
   */
  decision: ClusterDecision;
  /**
   * The recomputed plan, or null for an explicitly unresolved cluster. A plan
   * with `ok: false` is returned rather than thrown: the sidebar shows the
   * reviewer what is still missing.
   */
  plan: MergePlan | null;
}

/** Why a cluster can no longer be decided against its scan snapshot (§22.6). */
type StaleReason = "SCHEMA_CHANGED" | "ROW_EDITED" | "ROW_MISSING" | "DUPLICATE_DEDUP_ID";

const STALE_ERROR: Record<StaleReason, DedupErrorCode> = {
  SCHEMA_CHANGED: "SCHEMA_CHANGED",
  ROW_EDITED: "STALE_ROW",
  ROW_MISSING: "STALE_ROW",
  DUPLICATE_DEDUP_ID: "DUPLICATE_DEDUP_ID",
};

/** Every participant the decision would touch, plus the cluster's own members. */
function involvedIds(cluster: Cluster, decision: ClusterDecision): Set<string> {
  const ids = new Set<string>(cluster.memberIds);
  for (const id of decision.retainedIds) ids.add(id);
  for (const [deletedId, retainedId] of Object.entries(decision.deleteAssignments)) {
    ids.add(deletedId);
    ids.add(retainedId);
  }
  return ids;
}

/**
 * §22.6 step 3. Re-reads the source sheet and reports the first reason the
 * frozen snapshots no longer describe it. Read-only: the caller decides what to
 * do with a stale cluster.
 */
function detectStaleness(
  gateway: SheetsGateway,
  schema: SourceSchema,
  schemaHash: string,
  frozen: Map<string, RecordSnapshot>,
  involved: Set<string>,
  cfg: DedupConfig,
): StaleReason | null {
  const liveSchema = resolveSchema(gateway, schema.sheetName, cfg);
  if (liveSchema.schemaHash !== schemaHash) return "SCHEMA_CHANGED";

  const current = new Map<string, RecordSnapshot>();
  const seen = new Set<string>();
  for (const rec of buildSnapshots(gateway, "", liveSchema, cfg, gateway.getTimeZone())) {
    if (current.has(rec.dedupId)) seen.add(rec.dedupId);
    current.set(rec.dedupId, rec);
  }

  for (const id of involved) {
    if (seen.has(id)) return "DUPLICATE_DEDUP_ID";
    const live = current.get(id);
    if (!live) return "ROW_MISSING";
    const before = frozen.get(id);
    if (!before || before.rowFingerprint !== live.rowFingerprint) return "ROW_EDITED";
  }
  return null;
}

function statusFor(mode: ClusterDecision["mode"], plan: MergePlan | null): ClusterStatus {
  if (mode === "KEEP_ALL") return "KEEP_ALL";
  if (mode === "UNRESOLVED") return "UNRESOLVED";
  return plan?.ok ? "READY_TO_APPLY" : "UNRESOLVED";
}

function eventTypeFor(mode: ClusterDecision["mode"], priorStatus: string): string {
  if (mode === "KEEP_ALL") return "KEEP_ALL_SAVED";
  return priorStatus === "UNREVIEWED" || priorStatus === "IN_PROGRESS"
    ? "CLUSTER_REVIEWED"
    : "DECISION_CHANGED";
}

/**
 * §22.6 Saves one reviewer decision. The submitted body carries choices only:
 * the merge plan is always recomputed here from the scan snapshots, and the
 * status the cluster lands in is derived from that plan rather than from the
 * client. Nothing on the participant sheet is touched — deletion happens only
 * later, in the confirmed apply.
 */
export function saveClusterDecision(
  gateway: SheetsGateway,
  submitted: ClusterDecision,
  cfg: DedupConfig,
): SavedDecision {
  const reviewer = resolveReviewer(gateway, submitted.fallbackReviewerName);
  const reviewerId = reviewer.email ?? reviewer.display;

  const lock = gateway.getDocumentLock();
  lock.acquire(SAVE_LOCK_TIMEOUT_MS);
  try {
    const batch = batchesRepository(gateway).get(submitted.batchId);
    if (!batch) throw new DedupError("BATCH_NOT_FOUND");

    const clusters = clustersRepository(gateway);
    const row = clusters.get(submitted.clusterId);
    if (!row || String(row.batchId) !== submitted.batchId) {
      throw new DedupError("CLUSTER_NOT_FOUND");
    }
    // §26.3 an applied cluster is history; it cannot be decided again.
    if (String(row.status) === "APPLIED") throw new DedupError("BATCH_STATE_CONFLICT");
    // §27.2 optimistic concurrency: the reviewer must have seen this revision.
    if (Number(row.revision ?? 0) !== submitted.expectedRevision) {
      throw new DedupError("REVISION_CONFLICT");
    }

    const cluster = clusterFromRow(row);
    const schema = batch.schema as unknown as SourceSchema;
    const frozen = recordsRepository(gateway).readByBatch(submitted.batchId, schema.headers);
    const frozenById = new Map(frozen.map((r) => [r.dedupId, r]));

    const stale = detectStaleness(
      gateway,
      schema,
      String(batch.schemaHash),
      frozenById,
      involvedIds(cluster, submitted),
      cfg,
    );
    if (stale) {
      // The prior decision is left on the row: a rescan may well revive it, and
      // the apply path re-checks every fingerprint anyway.
      clusters.update(cluster.clusterId, { status: "STALE", staleReason: stale });
      throw new DedupError(STALE_ERROR[stale]);
    }

    const plan =
      submitted.mode === "UNRESOLVED"
        ? null
        : buildMergePlan(cluster, submitted, frozen, schema, cfg);
    const status = statusFor(submitted.mode, plan);
    const revision = Number(row.revision ?? 0) + 1;
    const reviewedAt = nowIso(gateway);

    // Stored at the revision it produces, so preflight accepts it unmodified.
    // The fallback reviewer name is deliberately dropped: it belongs to the
    // session that supplied it, not to the durable decision (§21.3).
    const stored: ClusterDecision = {
      batchId: submitted.batchId,
      clusterId: submitted.clusterId,
      expectedRevision: revision,
      mode: submitted.mode,
      retainedIds: submitted.retainedIds,
      deleteAssignments: submitted.deleteAssignments,
      fieldChoices: submitted.fieldChoices,
      notes: submitted.notes,
    };
    const hash = decisionHash(stored);

    clusters.update(cluster.clusterId, {
      status,
      revision,
      decision: stored,
      decisionHash: hash,
      reviewerId,
      reviewedAt,
      notes: submitted.notes,
      staleReason: "",
    });

    // §19.2/§19.3 Keep All suppresses this membership; any other decision — or a
    // later change of mind — releases it.
    const configHash = String(batch.configHash);
    if (submitted.mode === "KEEP_ALL") {
      recordKeepAll(
        gateway,
        cluster.memberIds.map((id) => ({
          dedupId: id,
          relevantHash: frozenById.get(id)?.relevantHash ?? "",
        })),
        configHash,
      );
    } else {
      clearKeepAll(gateway, cluster.memberIds, configHash);
    }

    auditRepository(gateway).append({
      eventType: eventTypeFor(submitted.mode, String(row.status)),
      batchId: submitted.batchId,
      clusterId: cluster.clusterId,
      reviewerId,
      actorId: reviewerId,
      actorType: actorTypeOf(reviewer),
      sourceSheetId: schema.sheetId,
      sourceSheetName: schema.sheetName,
      relatedIds: cluster.memberIds,
      confidence: cluster.topConfidence,
      score: cluster.topScore,
      warnings: plan?.issues ?? [],
      result: status,
    });

    return {
      clusterId: cluster.clusterId,
      status,
      revision,
      reviewerId,
      reviewedAt,
      decisionHash: hash,
      decision: stored,
      plan,
    };
  } finally {
    lock.release();
  }
}
