import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { BatchRecord } from "@/server/batchesRepository";
import type {
  CellValue,
  ClusterDecision,
  PairScore,
  RecordSnapshot,
  SourceSchema,
} from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import { DEFAULT_CONFIG } from "@/shared/config";
import type { BatchStatus } from "@/shared/constants";
import type { PairRecord } from "@/server/pairsRepository";
import { DedupError, type DedupErrorCode } from "@/server/errors";
import { configHash, decisionHash, makeClusterId, makePairKey } from "@/server/hashing";
import { auditActor, type AuditActor } from "@/server/identity";
import { ensureSystemSheets } from "@/server/systemSheets";
import { batchesRepository } from "@/server/batchesRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { pairsRepository } from "@/server/pairsRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { auditRepository } from "@/server/auditRepository";
import { resolveSchema } from "@/server/schemaResolver";
import { detectDuplicateIds, ensureDedupIds } from "@/server/dedupIdService";
import { buildSnapshots } from "@/server/scan/snapshot";
import { generateCandidates } from "@/server/match/candidateGenerator";
import { scorePair } from "@/server/match/scorePair";
import { formCluster } from "@/server/match/cluster";
import { filterSuppressed } from "@/server/review/suppression";
import { clusterFromRow } from "@/server/review/clusterRow";
import {
  carriedReadyClusters,
  classifyRecordDelta,
  dirtyIds as dirtyIdsFor,
} from "@/server/scan/incremental";

const SCAN_LOCK_TIMEOUT_MS = 30_000;

interface ScanCursor {
  priorBatchId?: string;
  dirtyIds?: string[];
  carryClusterIds?: string[];
  /** How many snapshot rows are already appended for this batch (resumable write). */
  snapshotOffset?: number;
  /** How many candidate pairs are already spilled to `_Dedup_Pairs`. */
  pairAppendOffset?: number;
}

const RESCANNABLE_STATUSES = new Set<string>(["READY", "PAUSED"]);

const SCANNING_STATUSES = new Set<string>([
  "SNAPSHOTTING",
  "GENERATING_CANDIDATES",
  "SCORING",
  "CLUSTERING",
]);

export interface ScanMetrics {
  records: number;
  candidates: number;
  qualifiedEdges: number;
  clusters: number;
  /** Source data rows at scan start (header excluded) — progress denominator. */
  sourceRows: number;
}

export interface ScanState {
  batchId: string;
  status: BatchStatus;
  phase: string;
  metrics: ScanMetrics;
  /** Soft signals for the sidebar (truncation / high candidate volume). */
  warnings: string[];
  errorCode?: DedupErrorCode;
}

function num(value: CellValue | undefined): number {
  if (typeof value === "number") return value;
  return Number(value ?? 0) || 0;
}

/** The scan state a batch row represents — what §21.2 shows for an active scan. */
export function stateFromBatch(batch: BatchRecord): ScanState {
  const candidates = num(batch.candidateCount);
  const truncated = num(batch.candidateTruncationCount) > 0;
  const warnings: string[] = [];
  if (truncated) warnings.push("CANDIDATE_TRUNCATION");
  else if (candidates >= DEFAULT_CONFIG.blocking.candidateWarnAt) {
    warnings.push("HIGH_CANDIDATE_VOLUME");
  }

  const state: ScanState = {
    batchId: String(batch.batchId),
    status: String(batch.status) as BatchStatus,
    phase: String(batch.phase ?? batch.status),
    metrics: {
      records: num(batch.recordCount),
      candidates,
      qualifiedEdges: num(batch.qualifiedEdgeCount),
      clusters: num(batch.clusterCount),
      sourceRows: Math.max(0, num(batch.sourceLastRow) - num(batch.headerRow)),
    },
    warnings,
  };
  const code = batch.errorCode;
  if (code !== null && code !== undefined && String(code) !== "") {
    state.errorCode = String(code) as DedupErrorCode;
  }
  return state;
}

function schemaOf(batch: BatchRecord): SourceSchema {
  return batch.schema as unknown as SourceSchema;
}

function cursorOf(batch: BatchRecord): ScanCursor {
  const raw = batch.phaseCursor;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as ScanCursor;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function cursorJson(cursor: ScanCursor): string {
  return JSON.stringify(cursor);
}

function memberKey(memberIds: ReadonlyArray<string>): string {
  return [...memberIds].sort().join("\u0000");
}

function idsFromCursor(cursor: ScanCursor): Set<string> | null {
  return Array.isArray(cursor.dirtyIds) ? new Set(cursor.dirtyIds.map(String)) : null;
}

function decisionForCarry(
  value: unknown,
  batchId: string,
  clusterId: string,
  revision: number,
): ClusterDecision | null {
  if (!value || typeof value !== "object") return null;
  const prior = value as ClusterDecision;
  return {
    batchId,
    clusterId,
    expectedRevision: revision,
    mode: prior.mode,
    retainedIds: Array.isArray(prior.retainedIds) ? prior.retainedIds.map(String) : [],
    deleteAssignments:
      prior.deleteAssignments && typeof prior.deleteAssignments === "object"
        ? Object.fromEntries(
            Object.entries(prior.deleteAssignments).map(([deletedId, retainedId]) => [
              deletedId,
              String(retainedId),
            ]),
          )
        : {},
    fieldChoices:
      prior.fieldChoices && typeof prior.fieldChoices === "object" ? prior.fieldChoices : {},
    notes: typeof prior.notes === "string" ? prior.notes : "",
  };
}

/**
 * §12 Starts a scan. Assigns any missing `_Dedup_ID` values, records the resolved
 * schema on the batch row, then drains as much of the scan as fits in
 * `execution.sliceBudgetMs` — small sheets typically finish in this one Apps
 * Script call. Mid-scan active batches are returned untouched; READY/PAUSED
 * batches are superseded first.
 */
export function startScan(
  gateway: SheetsGateway,
  sheetName: string,
  cfg: DedupConfig,
  fallbackName?: string,
): ScanState {
  const actor = auditActor(gateway, fallbackName);

  const lock = gateway.getDocumentLock();
  lock.acquire(SCAN_LOCK_TIMEOUT_MS);
  try {
    ensureSystemSheets(gateway, cfg);
    const batches = batchesRepository(gateway);

    const active = batches.getActive();
    let priorBatchId = "";
    if (active) {
      if (!RESCANNABLE_STATUSES.has(String(active.status))) return stateFromBatch(active);
      priorBatchId = String(active.batchId);
      batches.update(priorBatchId, {
        status: "SUPERSEDED",
        phase: "SUPERSEDED",
        revision: num(active.revision) + 1,
      });
    }

    // ensureDedupIds may create the id column, so the schema is resolved twice:
    // the second pass is what carries a populated dedupIdColumnIndex.
    ensureDedupIds(gateway, resolveSchema(gateway, sheetName, cfg), cfg, actor);
    const schema = resolveSchema(gateway, sheetName, cfg);
    const grid = gateway.getGridSize(sheetName);

    const batchId = gateway.newUuid();
    batches.insert({
      batchId,
      sourceSpreadsheetId: schema.spreadsheetId,
      sourceSheetId: schema.sheetId,
      sourceSheetName: schema.sheetName,
      headerRow: schema.headerRow,
      sourceLastRow: grid.rowCount,
      sourceLastCol: grid.columnCount,
      schema,
      schemaHash: schema.schemaHash,
      configHash: configHash(cfg),
      status: "SNAPSHOTTING",
      phase: "SNAPSHOTTING",
      recordCount: 0,
      candidateCount: 0,
      qualifiedEdgeCount: 0,
      clusterCount: 0,
      candidateTruncationCount: 0,
      createdBy: actor.actorId,
      phaseCursor: priorBatchId === "" ? "" : cursorJson({ priorBatchId }),
      revision: 1,
    });
    auditRepository(gateway).append({
      ...actor,
      eventType: "SCAN_STARTED",
      batchId,
      sourceSheetId: schema.sheetId,
      sourceSheetName: schema.sheetName,
    });

    if (!batches.get(batchId)) throw new DedupError("INTERNAL");
    return drainScan(gateway, cfg, actor, Math.max(0, cfg.execution.sliceBudgetMs));
  } finally {
    lock.release();
  }
}

/**
 * §12 Advances the active scan by one time-bounded slice and returns the new
 * state. A slice is bounded by `execution.sliceBudgetMs`: on a small sheet that
 * usually means snapshot → candidates → score → cluster in one Apps Script
 * round-trip. Every unit of work still persists before the next, so an
 * interrupted execution resumes from the sheets alone. Calling this on a
 * `READY` batch is a no-op.
 */
export function advanceScan(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  fallbackName?: string,
): ScanState {
  const actor = auditActor(gateway, fallbackName);

  const lock = gateway.getDocumentLock();
  lock.acquire(SCAN_LOCK_TIMEOUT_MS);
  try {
    return drainScan(gateway, cfg, actor, Math.max(0, cfg.execution.sliceBudgetMs));
  } finally {
    lock.release();
  }
}

/**
 * Runs scan units until the batch leaves a scanning status or the budget is
 * spent. Caller must already hold the document lock.
 *
 * `records` is kept in memory for the rest of this execution so candidate /
 * score / cluster phases do not re-read the records sheet.
 */
function drainScan(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  actor: AuditActor,
  budgetMs: number,
): ScanState {
  const batches = batchesRepository(gateway);
  const deadline = Date.now() + budgetMs;
  const ctx: DrainContext = { records: null };
  let state: ScanState | null = null;

  while (true) {
    if (budgetMs > 0 && Date.now() >= deadline) {
      const active = batches.getActive();
      if (!active) throw new DedupError("BATCH_STATE_CONFLICT");
      return stateFromBatch(active);
    }

    const active = batches.getActive();
    if (!active) throw new DedupError("BATCH_STATE_CONFLICT");

    switch (String(active.status)) {
      case "SNAPSHOTTING":
        state = snapshotPhase(gateway, cfg, active, actor, ctx);
        break;
      case "GENERATING_CANDIDATES":
        state = candidatePhase(gateway, cfg, active, actor, ctx);
        break;
      case "SCORING":
        state = scoringPhase(gateway, cfg, active, ctx);
        break;
      case "CLUSTERING":
        state = clusteringPhase(gateway, cfg, active, actor, ctx);
        break;
      default:
        return stateFromBatch(active);
    }

    // budgetMs === 0 forces one unit per call (used by resume tests).
    if (!SCANNING_STATUSES.has(state.status) || budgetMs === 0 || Date.now() >= deadline) {
      return state;
    }
  }
}

interface DrainContext {
  records: RecordSnapshot[] | null;
}

function recordsFor(
  gateway: SheetsGateway,
  batch: BatchRecord,
  ctx: DrainContext,
): RecordSnapshot[] {
  if (ctx.records) return ctx.records;
  const records = recordsRepository(gateway).readByBatch(
    String(batch.batchId),
    schemaOf(batch).headers,
  );
  ctx.records = records;
  return records;
}

/**
 * §20.6 Cancels the active batch. The working rows — records, pairs, clusters —
 * are discarded; the audit trail is not, so a cancelled scan still says who ran
 * it and who ended it. Refuses to cancel mid-apply: the apply pipeline owns the
 * batch until it finishes or fails, and pulling its snapshots out from under it
 * would leave the source sheet half-changed with nothing to reconcile against.
 */
export function cancelScan(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  fallbackName?: string,
): ScanState {
  const actor = auditActor(gateway, fallbackName);

  const lock = gateway.getDocumentLock();
  lock.acquire(SCAN_LOCK_TIMEOUT_MS);
  try {
    ensureSystemSheets(gateway, cfg);
    const batches = batchesRepository(gateway);
    const active = batches.getActive();
    if (!active) throw new DedupError("BATCH_STATE_CONFLICT");
    if (String(active.status) === "APPLYING") throw new DedupError("BATCH_STATE_CONFLICT");

    const batchId = String(active.batchId);
    const schema = schemaOf(active);

    recordsRepository(gateway).deleteByBatch(batchId);
    pairsRepository(gateway).deleteByBatch(batchId);
    clustersRepository(gateway).deleteByBatch(batchId);

    batches.update(batchId, {
      status: "CANCELLED",
      phase: "CANCELLED",
      recordCount: 0,
      candidateCount: 0,
      qualifiedEdgeCount: 0,
      clusterCount: 0,
      revision: num(active.revision) + 1,
    });
    auditRepository(gateway).append({
      ...actor,
      eventType: "SCAN_CANCELLED",
      batchId,
      sourceSheetId: schema.sheetId,
      sourceSheetName: schema.sheetName,
    });
    return reread(gateway, batchId);
  } finally {
    lock.release();
  }
}

function reread(gateway: SheetsGateway, batchId: string): ScanState {
  const batch = batchesRepository(gateway).get(batchId);
  if (!batch) throw new DedupError("INTERNAL");
  return stateFromBatch(batch);
}

function snapshotPhase(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  batch: BatchRecord,
  actor: AuditActor,
  ctx: DrainContext,
): ScanState {
  const batches = batchesRepository(gateway);
  const recordsRepo = recordsRepository(gateway);
  const batchId = String(batch.batchId);
  const schema = schemaOf(batch);
  const revision = num(batch.revision);
  const cursor = cursorOf(batch);
  const chunkSize = Math.max(1, cfg.execution.sheetWriteChunkSize);

  const hadCachedRecords = ctx.records !== null;
  const records =
    ctx.records ?? buildSnapshots(gateway, batchId, schema, cfg, gateway.getTimeZone());
  ctx.records = records;

  if (records.length > cfg.execution.maxParticipantRows) {
    const error = new DedupError("SHEET_TOO_LARGE");
    batches.update(batchId, {
      status: "FAILED",
      phase: "FAILED",
      errorCode: error.code,
      errorMessage: error.safeMessage,
      recordCount: records.length,
      revision: revision + 1,
    });
    auditRepository(gateway).append({
      ...actor,
      eventType: "SCAN_FAILED",
      batchId,
      sourceSheetId: schema.sheetId,
      sourceSheetName: schema.sheetName,
      result: "FAILED",
      errorCode: error.code,
      errorMessage: error.safeMessage,
    });
    return reread(gateway, batchId);
  }

  let offset = cursor.snapshotOffset ?? 0;
  if (offset === 0) {
    recordsRepo.deleteByBatch(batchId);
  } else if (!hadCachedRecords) {
    // Cross-execution resume: a crash between append and cursor update can leave
    // a torn write. Restart snapshot rows when counts disagree.
    const existingCount = recordsRepo.readByBatch(batchId, schema.headers).length;
    if (existingCount !== offset) {
      recordsRepo.deleteByBatch(batchId);
      offset = 0;
    }
  }

  if (offset === 0) {
    const duplicates = detectDuplicateIds(records);
    if (duplicates.length > 0) {
      const error = new DedupError("DUPLICATE_DEDUP_ID");
      batches.update(batchId, {
        status: "FAILED",
        phase: "FAILED",
        errorCode: error.code,
        errorMessage: error.safeMessage,
        revision: revision + 1,
      });
      auditRepository(gateway).append({
        ...actor,
        eventType: "SCAN_FAILED",
        batchId,
        sourceSheetId: schema.sheetId,
        sourceSheetName: schema.sheetName,
        result: "FAILED",
        errorCode: error.code,
        errorMessage: error.safeMessage,
      });
      return reread(gateway, batchId);
    }
  }

  let baseCursor: ScanCursor =
    offset === 0
      ? {}
      : {
          ...(cursor.priorBatchId ? { priorBatchId: cursor.priorBatchId } : {}),
          ...(cursor.dirtyIds ? { dirtyIds: cursor.dirtyIds } : {}),
          ...(cursor.carryClusterIds ? { carryClusterIds: cursor.carryClusterIds } : {}),
        };

  if (offset === 0 && cursor.priorBatchId) {
    const prior = batches.get(cursor.priorBatchId);
    if (
      prior &&
      String(prior.schemaHash) === String(batch.schemaHash) &&
      String(prior.configHash) === String(batch.configHash)
    ) {
      const priorSchema = schemaOf(prior);
      const priorRecords = recordsRepo.readByBatch(cursor.priorBatchId, priorSchema.headers);
      const priorClusters = clustersRepository(gateway).listByBatch(cursor.priorBatchId);
      const delta = classifyRecordDelta(priorRecords, records);
      const carry = carriedReadyClusters(priorClusters, delta.unchangedIds);
      baseCursor = {
        priorBatchId: cursor.priorBatchId,
        dirtyIds: dirtyIdsFor(delta, priorClusters),
        carryClusterIds: carry.map((row) => String(row.clusterId)).sort(),
      };
    }
  }

  const slice = records.slice(offset, offset + chunkSize);
  if (slice.length > 0) {
    recordsRepo.append(slice, chunkSize);
  }
  const nextOffset = offset + slice.length;

  if (nextOffset < records.length) {
    batches.update(batchId, {
      status: "SNAPSHOTTING",
      phase: "SNAPSHOTTING",
      phaseCursor: cursorJson({ ...baseCursor, snapshotOffset: nextOffset }),
      recordCount: nextOffset,
      revision: revision + 1,
    });
    return reread(gateway, batchId);
  }

  batches.update(batchId, {
    status: "GENERATING_CANDIDATES",
    phase: "GENERATING_CANDIDATES",
    phaseCursor: Object.keys(baseCursor).length === 0 ? "" : cursorJson(baseCursor),
    recordCount: records.length,
    revision: revision + 1,
  });
  return reread(gateway, batchId);
}

function candidatePhase(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  batch: BatchRecord,
  actor: AuditActor,
  ctx: DrainContext,
): ScanState {
  const batches = batchesRepository(gateway);
  const pairs = pairsRepository(gateway);
  const batchId = String(batch.batchId);
  const revision = num(batch.revision);

  const records = recordsFor(gateway, batch, ctx);
  const cursor = cursorOf(batch);
  const dirtyIds = idsFromCursor(cursor);
  const generated = generateCandidates(records, cfg);
  const candidatePairs =
    dirtyIds === null
      ? generated.pairs
      : generated.pairs.filter((p) => dirtyIds.has(p.leftId) || dirtyIds.has(p.rightId));

  const baseCursor: ScanCursor = {
    ...(cursor.priorBatchId ? { priorBatchId: cursor.priorBatchId } : {}),
    ...(cursor.dirtyIds ? { dirtyIds: cursor.dirtyIds } : {}),
    ...(cursor.carryClusterIds ? { carryClusterIds: cursor.carryClusterIds } : {}),
  };

  // Prefer scoring in memory: the pairs sheet is only for cross-execution resume.
  if (
    (cursor.pairAppendOffset ?? 0) === 0 &&
    candidatePairs.length <= cfg.execution.inMemoryPairScoreMax
  ) {
    const byId = new Map(records.map((rec) => [rec.dedupId, rec]));
    const scores = candidatePairs
      .map((p) =>
        scorePairRecord(
          {
            batchId,
            pairKey: makePairKey(p.leftId, p.rightId),
            leftId: p.leftId,
            rightId: p.rightId,
            generationReasons: [],
            preScore: 0,
            scoreStatus: "PENDING",
            score: null,
            qualified: false,
          },
          byId,
          cfg,
        ),
      )
      .map((p) => p.score)
      .filter((s): s is PairScore => s !== null);
    batches.update(batchId, {
      candidateCount: candidatePairs.length,
      candidateTruncationCount: generated.truncated ? 1 : 0,
      revision: revision + 1,
    });
    const refreshed = batches.get(batchId);
    if (!refreshed) throw new DedupError("INTERNAL");
    return finalizeClusters(gateway, cfg, refreshed, actor, scores, ctx, { clearPairs: false });
  }

  const writeChunk = Math.max(1, cfg.execution.sheetWriteChunkSize);
  let offset = cursor.pairAppendOffset ?? 0;
  if (offset === 0) {
    pairs.deleteByBatch(batchId);
  } else {
    // Cross-execution resume: restart spill if counts disagree.
    const existing = pairs.readByBatch(batchId).length;
    if (existing !== offset) {
      pairs.deleteByBatch(batchId);
      offset = 0;
    }
  }

  const slice = candidatePairs.slice(offset, offset + writeChunk);
  if (slice.length > 0) {
    pairs.append(
      slice.map((p) => ({
        batchId,
        pairKey: makePairKey(p.leftId, p.rightId),
        leftId: p.leftId,
        rightId: p.rightId,
        generationReasons: [],
        preScore: 0,
        scoreStatus: "PENDING" as const,
        score: null,
        qualified: false,
      })),
      writeChunk,
    );
  }
  const nextOffset = offset + slice.length;

  if (nextOffset < candidatePairs.length) {
    batches.update(batchId, {
      status: "GENERATING_CANDIDATES",
      phase: "GENERATING_CANDIDATES",
      phaseCursor: cursorJson({ ...baseCursor, pairAppendOffset: nextOffset }),
      candidateCount: candidatePairs.length,
      candidateTruncationCount: generated.truncated ? 1 : 0,
      revision: revision + 1,
    });
    return reread(gateway, batchId);
  }

  batches.update(batchId, {
    status: "SCORING",
    phase: "SCORING",
    phaseCursor: Object.keys(baseCursor).length === 0 ? "" : cursorJson(baseCursor),
    candidateCount: candidatePairs.length,
    candidateTruncationCount: generated.truncated ? 1 : 0,
    revision: revision + 1,
  });
  return reread(gateway, batchId);
}

function scorePairRecord(
  rec: PairRecord,
  byId: Map<string, RecordSnapshot>,
  cfg: DedupConfig,
): PairRecord {
  try {
    const left = byId.get(rec.leftId);
    const right = byId.get(rec.rightId);
    if (!left || !right) {
      return { ...rec, scoreStatus: "ERROR", score: null, qualified: false };
    }
    const score = scorePair(left, right, cfg);
    return {
      ...rec,
      scoreStatus: "SCORED",
      score,
      qualified: score.eligible && score.confidence !== "EXCLUDED",
    };
  } catch {
    // A single unscoreable pair must not abandon the batch (§12.4).
    return { ...rec, scoreStatus: "ERROR", score: null, qualified: false };
  }
}

function scoringPhase(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  batch: BatchRecord,
  ctx: DrainContext,
): ScanState {
  const batches = batchesRepository(gateway);
  const pairs = pairsRepository(gateway);
  const batchId = String(batch.batchId);
  const revision = num(batch.revision);

  const pending = pairs.readPendingWithIndex(batchId, cfg.execution.pairScoreChunkSize);
  if (pending.length === 0) {
    batches.update(batchId, {
      status: "CLUSTERING",
      phase: "CLUSTERING",
      revision: revision + 1,
    });
    return reread(gateway, batchId);
  }

  const byId = new Map(
    recordsFor(gateway, batch, ctx).map((rec) => [rec.dedupId, rec] as const),
  );

  const updates = pending.map(({ index, rec }) => ({
    index,
    rec: scorePairRecord(rec, byId, cfg),
  }));
  pairs.writeMany(updates);

  // A full chunk usually means more pending work; avoid a second full-sheet read
  // just to ask that question (that re-read dominated large-sheet scoring).
  const morePending = pending.length >= cfg.execution.pairScoreChunkSize;
  batches.update(
    batchId,
    morePending
      ? { phase: "SCORING", revision: revision + 1 }
      : { status: "CLUSTERING", phase: "CLUSTERING", revision: revision + 1 },
  );
  return reread(gateway, batchId);
}

function carryReadyClusterRows(
  gateway: SheetsGateway,
  batchId: string,
  cursor: ScanCursor,
  generatedMemberKeys: Set<string>,
): Record<string, unknown>[] {
  if (!cursor.priorBatchId || !Array.isArray(cursor.carryClusterIds)) return [];

  const carryIds = new Set(cursor.carryClusterIds.map(String));
  const out: Record<string, unknown>[] = [];
  for (const row of clustersRepository(gateway).listByBatch(cursor.priorBatchId)) {
    if (!carryIds.has(String(row.clusterId))) continue;
    const cluster = clusterFromRow(row);
    if (generatedMemberKeys.has(memberKey(cluster.memberIds))) continue;

    const revision = Number(row.revision ?? 1) || 1;
    const clusterId = makeClusterId(batchId, cluster.memberIds);
    const decision = decisionForCarry(row.decision, batchId, clusterId, revision);
    if (!decision) continue;

    out.push({
      ...row,
      batchId,
      clusterId,
      edgeKeys: [],
      status: "READY_TO_APPLY",
      revision,
      decision,
      decisionHash: decisionHash(decision),
      staleReason: "",
      applyBatchId: "",
      appliedAt: "",
    });
  }
  return out;
}

function clusteringPhase(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  batch: BatchRecord,
  actor: AuditActor,
  ctx: DrainContext,
): ScanState {
  const scores = pairsRepository(gateway)
    .readByBatch(String(batch.batchId))
    .filter((p) => p.scoreStatus === "SCORED")
    .map((p) => p.score)
    .filter((s): s is PairScore => s !== null);
  return finalizeClusters(gateway, cfg, batch, actor, scores, ctx, { clearPairs: true });
}

function finalizeClusters(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  batch: BatchRecord,
  actor: AuditActor,
  scores: PairScore[],
  ctx: DrainContext,
  options: { clearPairs: boolean },
): ScanState {
  const batches = batchesRepository(gateway);
  const batchId = String(batch.batchId);
  const schema = schemaOf(batch);
  const revision = num(batch.revision);

  const relevantHashes = new Map<string, string>();
  for (const rec of recordsFor(gateway, batch, ctx)) {
    relevantHashes.set(rec.dedupId, rec.relevantHash);
  }

  // §19.3 Clusters the reviewer already kept stay out of the queue until one of
  // their members' relevant fields — or the config — changes.
  const clusters = filterSuppressed(
    gateway,
    formCluster(scores, cfg),
    (id) => relevantHashes.get(id) ?? "",
    String(batch.configHash),
  );
  const generatedMemberKeys = new Set(clusters.map((c) => memberKey(c.memberIds)));
  const generatedRows = clusters.map((c) => ({
    batchId,
    clusterId: makeClusterId(batchId, c.memberIds),
    clusterType: c.clusterType,
    memberIds: c.memberIds,
    coreMemberIds: c.memberIds,
    suggestedMemberIds: c.suggestedMemberIds,
    edgeKeys: c.edges.map((e) => e.pairKey),
    highestConfidence: c.topConfidence,
    maxScore: c.topScore,
    warnings: c.chainWarning ? ["POSSIBLE_CHAIN_CLUSTER"] : [],
    status: "UNREVIEWED",
    revision: 1,
  }));
  const carriedRows = carryReadyClusterRows(gateway, batchId, cursorOf(batch), generatedMemberKeys);
  clustersRepository(gateway).append(
    [...generatedRows, ...carriedRows],
    cfg.execution.sheetWriteChunkSize,
  );

  const qualifiedEdges = scores.filter(
    (s) => s.eligible && s.confidence !== "EXCLUDED",
  ).length;

  // Pair rows are working state; clusters carry everything review needs.
  if (options.clearPairs) pairsRepository(gateway).deleteByBatch(batchId);

  batches.update(batchId, {
    status: "READY",
    phase: "READY",
    clusterCount: generatedRows.length + carriedRows.length,
    qualifiedEdgeCount: qualifiedEdges,
    revision: revision + 1,
  });
  auditRepository(gateway).append({
    ...actor,
    eventType: "SCAN_COMPLETED",
    batchId,
    sourceSheetId: schema.sheetId,
    sourceSheetName: schema.sheetName,
  });
  return reread(gateway, batchId);
}
