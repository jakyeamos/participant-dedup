import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { Cluster, ClusterDecision, RecordSnapshot, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import type { MergePlan } from "@/server/review/mergePlan";
import { DedupError } from "@/server/errors";
import { canonicalJson, decisionHash, sha256Hex } from "@/server/hashing";
import { auditActor, type AuditActor } from "@/server/identity";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { auditRepository } from "@/server/auditRepository";
import { stateRepository } from "@/server/stateRepository";
import { resolveSchema } from "@/server/schemaResolver";
import { buildSnapshots } from "@/server/scan/snapshot";
import { buildMergePlan } from "@/server/review/mergePlan";
import { clusterFromRow } from "@/server/review/clusterRow";

/** §23.2 The confirmation challenge outlives the execution that created it. */
export const APPLY_CHALLENGE_STATE_TYPE = "APPLY_CHALLENGE";

/** §23.2 Exact confirmation token typed before a destructive apply. */
export const APPLY_CONFIRMATION_TEXT = "confirm";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface ApplyChallenge {
  token: string;
  summaryHash: string;
  confirmed: boolean;
}

export interface ApplySummary {
  clusterCount: number;
  retainedCount: number;
  deletionRowCount: number;
  fillCount: number;
}

export interface CreatedChallenge {
  token: string;
  summaryHash: string;
  summary: ApplySummary;
  warningText: string;
  expiresAt: string;
}

export interface PreflightResult {
  batchId: string;
  /** Plans for the clusters this apply still has to perform. */
  plans: MergePlan[];
  deletionRowCount: number;
  summaryHash: string;
  /** The live schema, proven to still hash to the batch's schema. */
  schema: SourceSchema;
  /** Scan snapshots, proven to still match the live rows they describe. */
  records: RecordSnapshot[];
  /** Where each record sits in the sheet right now, one-based. */
  rowByDedupId: Record<string, number>;
}

interface StoredChallenge {
  token: string;
  reviewerKey: string;
  batchId: string;
  summaryHash: string;
  expiresAtMs: number;
}

interface ResolvedDecision {
  decision: ClusterDecision;
  cluster: Cluster;
  /** The cluster was already applied by an earlier run (§26.3). */
  applied: boolean;
}

function actorOf(gateway: SheetsGateway, decisions: ClusterDecision[]): AuditActor {
  return auditActor(gateway, decisions[0]?.fallbackReviewerName);
}

function schemaOf(batch: Record<string, unknown>): SourceSchema {
  return batch.schema as unknown as SourceSchema;
}

/**
 * §24 steps 1–4, 12: loads the batch, matches every submitted decision to its
 * stored cluster row, and rejects anything the reviewer did not actually save.
 */
function resolveDecisions(
  gateway: SheetsGateway,
  batchId: string,
  decisions: ClusterDecision[],
): ResolvedDecision[] {
  const clusters = clustersRepository(gateway);
  return decisions.map((decision) => {
    if (decision.batchId !== batchId) throw new DedupError("BATCH_STATE_CONFLICT");

    const row = clusters.get(decision.clusterId);
    if (!row) throw new DedupError("CLUSTER_NOT_FOUND");
    if (String(row.batchId) !== batchId) throw new DedupError("BATCH_STATE_CONFLICT");

    // §27.2 optimistic concurrency: the row must be the revision the reviewer
    // decided against, and the submitted body must be the one that was saved.
    if (Number(row.revision ?? 0) !== decision.expectedRevision) {
      throw new DedupError("REVISION_CONFLICT");
    }
    const storedHash = String(row.decisionHash ?? "");
    if (storedHash === "" || storedHash !== decisionHash(decision)) {
      throw new DedupError("REVISION_CONFLICT");
    }

    return { decision, cluster: clusterFromRow(row), applied: String(row.status) === "APPLIED" };
  });
}

function summarize(plans: MergePlan[]): ApplySummary {
  return {
    clusterCount: plans.length,
    retainedCount: plans.reduce((n, p) => n + p.retainedIds.length, 0),
    deletionRowCount: plans.reduce((n, p) => n + p.deletions.length, 0),
    fillCount: plans.reduce((n, p) => n + p.fills.length, 0),
  };
}

/**
 * The hash the reviewer confirms. It covers every decision in the apply — the
 * already-applied ones included — so replaying an interrupted apply produces the
 * same hash instead of looking like tampering (§26.3).
 */
function hashSummary(
  batchId: string,
  resolved: ResolvedDecision[],
  summary: ApplySummary,
): string {
  return sha256Hex(
    canonicalJson({
      batchId,
      decisionHashes: resolved.map((r) => decisionHash(r.decision)).sort(),
      summary,
    }),
  );
}

/** §22 Plans are always recomputed from the scan snapshots, never from client input. */
function buildPlans(
  resolved: ResolvedDecision[],
  records: RecordSnapshot[],
  schema: SourceSchema,
  cfg: DedupConfig,
): MergePlan[] {
  return resolved.map((r) => buildMergePlan(r.cluster, r.decision, records, schema, cfg));
}

/**
 * §23.2 Builds the confirmation challenge for an apply. The summary is computed
 * from freshly recalculated merge plans, and its hash is stored so preflight can
 * prove the reviewer confirmed exactly this work. No lock is taken and nothing is
 * written to the participant sheet: the reviewer has not confirmed yet.
 */
export function createApplyChallenge(
  gateway: SheetsGateway,
  batchId: string,
  decisions: ClusterDecision[],
  cfg: DedupConfig,
): CreatedChallenge {
  const reviewerKey = actorOf(gateway, decisions).actorId;

  const batch = batchesRepository(gateway).get(batchId);
  if (!batch) throw new DedupError("BATCH_NOT_FOUND");
  if (String(batch.status) === "APPLIED") throw new DedupError("DUPLICATE_APPLY");

  const schema = schemaOf(batch);
  const resolved = resolveDecisions(gateway, batchId, decisions);
  const records = recordsRepository(gateway).readByBatch(batchId, schema.headers);
  const summary = summarize(buildPlans(resolved, records, schema, cfg));
  const summaryHash = hashSummary(batchId, resolved, summary);

  const token = gateway.newUuid();
  const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;
  const stored: StoredChallenge = { token, reviewerKey, batchId, summaryHash, expiresAtMs };
  stateRepository(gateway).put(APPLY_CHALLENGE_STATE_TYPE, batchId, stored);

  return {
    token,
    summaryHash,
    summary,
    warningText: APPLY_CONFIRMATION_TEXT,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function readChallenge(gateway: SheetsGateway, batchId: string): StoredChallenge | null {
  const row = stateRepository(gateway).get(APPLY_CHALLENGE_STATE_TYPE, batchId);
  const value = row?.valueJson;
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    token: String(raw.token ?? ""),
    reviewerKey: String(raw.reviewerKey ?? ""),
    batchId: String(raw.batchId ?? ""),
    summaryHash: String(raw.summaryHash ?? ""),
    expiresAtMs: Number(raw.expiresAtMs ?? 0),
  };
}

/** §24 step 2: an apply proceeds only on a live challenge its own reviewer confirmed. */
function requireChallenge(
  gateway: SheetsGateway,
  batchId: string,
  challenge: ApplyChallenge,
  reviewerKey: string,
): StoredChallenge {
  if (!challenge.confirmed) throw new DedupError("NOT_CONFIRMED");
  const stored = readChallenge(gateway, batchId);
  if (!stored) throw new DedupError("NOT_CONFIRMED");
  if (stored.token === "" || stored.token !== challenge.token) {
    throw new DedupError("NOT_CONFIRMED");
  }
  if (stored.reviewerKey !== reviewerKey) throw new DedupError("NOT_CONFIRMED");
  if (stored.expiresAtMs <= Date.now()) throw new DedupError("NOT_CONFIRMED");
  return stored;
}

/**
 * §24 steps 6–9: re-derives the participant sheet as it stands right now and
 * checks that every row the apply will touch is exactly where — and how — the
 * reviewer left it.
 */
function verifyLiveRows(
  current: RecordSnapshot[],
  frozen: Map<string, RecordSnapshot>,
  affectedIds: Set<string>,
): void {
  const byId = new Map<string, RecordSnapshot[]>();
  for (const rec of current) {
    const bucket = byId.get(rec.dedupId);
    if (bucket) bucket.push(rec);
    else byId.set(rec.dedupId, [rec]);
  }

  for (const id of affectedIds) {
    const found = byId.get(id) ?? [];
    if (found.length > 1) throw new DedupError("DUPLICATE_DEDUP_ID");
    // AT-22: a row that moved out of the participant range is as stale as an
    // edited one — either way the apply no longer knows what it would delete.
    if (found.length === 0) throw new DedupError("STALE_ROW");
    const before = frozen.get(id);
    if (!before || found[0]!.rowFingerprint !== before.rowFingerprint) {
      throw new DedupError("STALE_ROW");
    }
  }
}

function affectedIdsOf(resolved: ResolvedDecision[]): Set<string> {
  const ids = new Set<string>();
  for (const r of resolved) {
    if (r.applied) continue;
    for (const id of r.cluster.memberIds) ids.add(id);
    for (const id of r.decision.retainedIds) ids.add(id);
    for (const [deletedId, retainedId] of Object.entries(r.decision.deleteAssignments)) {
      ids.add(deletedId);
      ids.add(retainedId);
    }
  }
  return ids;
}

/**
 * §24 step 13. Two clusters that disagree about the same participant cannot be
 * applied independently, so the whole preflight fails rather than silently
 * dropping one of them.
 */
function verifyNoCrossClusterOverlap(plans: MergePlan[]): void {
  const retained = new Set<string>();
  const deleted = new Set<string>();
  for (const plan of plans) {
    for (const id of plan.retainedIds) retained.add(id);
    for (const d of plan.deletions) {
      if (deleted.has(d.deletedId)) throw new DedupError("BATCH_STATE_CONFLICT");
      deleted.add(d.deletedId);
    }
  }
  for (const id of deleted) {
    if (retained.has(id)) throw new DedupError("BATCH_STATE_CONFLICT");
  }
}

function verifyPlans(plans: MergePlan[]): void {
  for (const plan of plans) {
    if (plan.ok) continue;
    if (plan.issues.includes("UNRESOLVED_CONFLICT")) {
      throw new DedupError("UNRESOLVED_CONFLICT");
    }
    throw new DedupError("BATCH_STATE_CONFLICT");
  }
}

/**
 * §24 Validates everything that must hold before a single cell is written, and
 * returns the work the apply will perform. Every check fails closed: the caller
 * gets a `DedupError` and the sheet is untouched.
 *
 * Deliberate deviation from §24 step 3: the document lock is *not* taken here.
 * Acquiring and releasing it inside preflight would open a window between the
 * last check and the atomic write. `applyDecisions` holds one lock across both.
 */
export function preflight(
  gateway: SheetsGateway,
  batchId: string,
  decisions: ClusterDecision[],
  challenge: ApplyChallenge,
  cfg: DedupConfig,
): PreflightResult {
  const actor = actorOf(gateway, decisions);

  const batch = batchesRepository(gateway).get(batchId);
  if (!batch) throw new DedupError("BATCH_NOT_FOUND");
  // §26.3 the batch as a whole is applied exactly once.
  if (String(batch.status) === "APPLIED") throw new DedupError("DUPLICATE_APPLY");

  const stored = requireChallenge(gateway, batchId, challenge, actor.actorId);

  const schema = schemaOf(batch);
  const resolved = resolveDecisions(gateway, batchId, decisions);

  // §24 step 9: a renamed or moved column invalidates every stored fingerprint,
  // so the schema is checked before the rows are.
  const liveSchema = resolveSchema(gateway, schema.sheetName, cfg);
  if (liveSchema.schemaHash !== String(batch.schemaHash)) {
    throw new DedupError("SCHEMA_CHANGED");
  }

  const frozen = recordsRepository(gateway).readByBatch(batchId, schema.headers);
  const frozenById = new Map(frozen.map((r) => [r.dedupId, r]));
  const current = buildSnapshots(gateway, batchId, liveSchema, cfg, gateway.getTimeZone());
  verifyLiveRows(current, frozenById, affectedIdsOf(resolved));

  const allPlans = buildPlans(resolved, frozen, schema, cfg);
  const summaryHash = hashSummary(batchId, resolved, summarize(allPlans));
  // AT-18: what runs must be what was confirmed, byte for byte.
  if (summaryHash !== stored.summaryHash || summaryHash !== challenge.summaryHash) {
    throw new DedupError("SUMMARY_HASH_CHANGED");
  }

  verifyPlans(allPlans);

  // AT-26: clusters an earlier run already applied contribute to the confirmed
  // summary but carry no work, so a replay is a no-op rather than a double apply.
  const plans = allPlans.filter((_, i) => !resolved[i]!.applied);
  verifyNoCrossClusterOverlap(plans);

  auditRepository(gateway).append({
    ...actor,
    eventType: "APPLY_ATTEMPTED",
    batchId,
  });

  // Live positions, not `sourceRowAtScan`: the fingerprint checks prove content,
  // not position, so a row that merely moved is still a valid apply target.
  const rowByDedupId: Record<string, number> = {};
  for (const rec of current) rowByDedupId[rec.dedupId] = rec.sourceRowAtScan;

  return {
    batchId,
    plans,
    deletionRowCount: plans.reduce((n, p) => n + p.deletions.length, 0),
    summaryHash,
    schema: liveSchema,
    records: frozen,
    rowByDedupId,
  };
}
