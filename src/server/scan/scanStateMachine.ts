import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { BatchRecord } from "@/server/batchesRepository";
import type { CellValue, PairScore, RecordSnapshot, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import type { BatchStatus } from "@/shared/constants";
import type { PairRecord } from "@/server/pairsRepository";
import { DedupError, type DedupErrorCode } from "@/server/errors";
import { configHash, makeClusterId, makePairKey } from "@/server/hashing";
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

const SCAN_LOCK_TIMEOUT_MS = 30_000;

export interface ScanMetrics {
  records: number;
  candidates: number;
  qualifiedEdges: number;
  clusters: number;
}

export interface ScanState {
  batchId: string;
  status: BatchStatus;
  phase: string;
  metrics: ScanMetrics;
  errorCode?: DedupErrorCode;
}

function num(value: CellValue | undefined): number {
  if (typeof value === "number") return value;
  return Number(value ?? 0) || 0;
}

function stateFromBatch(batch: BatchRecord): ScanState {
  const state: ScanState = {
    batchId: String(batch.batchId),
    status: String(batch.status) as BatchStatus,
    phase: String(batch.phase ?? batch.status),
    metrics: {
      records: num(batch.recordCount),
      candidates: num(batch.candidateCount),
      qualifiedEdges: num(batch.qualifiedEdgeCount),
      clusters: num(batch.clusterCount),
    },
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

/**
 * §12 Starts a scan. Assigns any missing `_Dedup_ID` values, records the resolved
 * schema on the batch row, and parks the batch in `SNAPSHOTTING` — no participant
 * values are read or written beyond the id column. Re-entrant: an already-active
 * batch is returned untouched.
 */
export function startScan(
  gateway: SheetsGateway,
  sheetName: string,
  cfg: DedupConfig,
): ScanState {
  const lock = gateway.getDocumentLock();
  lock.acquire(SCAN_LOCK_TIMEOUT_MS);
  try {
    ensureSystemSheets(gateway, cfg);
    const batches = batchesRepository(gateway);

    const active = batches.getActive();
    if (active) return stateFromBatch(active);

    // ensureDedupIds may create the id column, so the schema is resolved twice:
    // the second pass is what carries a populated dedupIdColumnIndex.
    ensureDedupIds(gateway, resolveSchema(gateway, sheetName, cfg), cfg);
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
      revision: 1,
    });
    auditRepository(gateway).append({
      eventType: "SCAN_STARTED",
      batchId,
      details: schema.sheetName,
    });

    const inserted = batches.get(batchId);
    if (!inserted) throw new DedupError("INTERNAL");
    return stateFromBatch(inserted);
  } finally {
    lock.release();
  }
}

/**
 * §12 Advances the active scan by exactly one slice and returns the new state.
 * Every phase persists its result before returning, so an interrupted execution
 * resumes from the sheets alone — pending pairs are the durable scoring cursor.
 * Calling this on a `READY` batch is a no-op.
 */
export function advanceScan(gateway: SheetsGateway, cfg: DedupConfig): ScanState {
  const lock = gateway.getDocumentLock();
  lock.acquire(SCAN_LOCK_TIMEOUT_MS);
  try {
    const batches = batchesRepository(gateway);
    const active = batches.getActive();
    if (!active) throw new DedupError("BATCH_STATE_CONFLICT");

    switch (String(active.status)) {
      case "SNAPSHOTTING":
        return snapshotPhase(gateway, cfg, active);
      case "GENERATING_CANDIDATES":
        return candidatePhase(gateway, cfg, active);
      case "SCORING":
        return scoringPhase(gateway, cfg, active);
      case "CLUSTERING":
        return clusteringPhase(gateway, cfg, active);
      default:
        return stateFromBatch(active);
    }
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
): ScanState {
  const batches = batchesRepository(gateway);
  const batchId = String(batch.batchId);
  const schema = schemaOf(batch);
  const revision = num(batch.revision);

  const records = buildSnapshots(gateway, batchId, schema, cfg, gateway.getTimeZone());

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
      eventType: "SCAN_FAILED",
      batchId,
      details: `duplicate _Dedup_ID count=${duplicates.length}`,
    });
    return reread(gateway, batchId);
  }

  recordsRepository(gateway).append(records);
  batches.update(batchId, {
    status: "GENERATING_CANDIDATES",
    phase: "GENERATING_CANDIDATES",
    recordCount: records.length,
    revision: revision + 1,
  });
  return reread(gateway, batchId);
}

function candidatePhase(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  batch: BatchRecord,
): ScanState {
  const batches = batchesRepository(gateway);
  const batchId = String(batch.batchId);
  const schema = schemaOf(batch);
  const revision = num(batch.revision);

  const records = recordsRepository(gateway).readByBatch(batchId, schema.headers);
  const { pairs, truncated } = generateCandidates(records, cfg);

  const rows: PairRecord[] = pairs.map((p) => ({
    batchId,
    pairKey: makePairKey(p.leftId, p.rightId),
    leftId: p.leftId,
    rightId: p.rightId,
    generationReasons: [],
    preScore: 0,
    scoreStatus: "PENDING",
    score: null,
    qualified: false,
  }));
  pairsRepository(gateway).append(rows);

  batches.update(batchId, {
    status: "SCORING",
    phase: "SCORING",
    candidateCount: rows.length,
    candidateTruncationCount: truncated ? 1 : 0,
    revision: revision + 1,
  });
  return reread(gateway, batchId);
}

function scoringPhase(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  batch: BatchRecord,
): ScanState {
  const batches = batchesRepository(gateway);
  const pairs = pairsRepository(gateway);
  const batchId = String(batch.batchId);
  const schema = schemaOf(batch);
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

  const byId = new Map<string, RecordSnapshot>();
  for (const rec of recordsRepository(gateway).readByBatch(batchId, schema.headers)) {
    byId.set(rec.dedupId, rec);
  }

  for (const { index, rec } of pending) {
    let updated: PairRecord;
    try {
      const left = byId.get(rec.leftId);
      const right = byId.get(rec.rightId);
      if (!left || !right) {
        updated = { ...rec, scoreStatus: "ERROR", score: null, qualified: false };
      } else {
        const score = scorePair(left, right, cfg);
        updated = {
          ...rec,
          scoreStatus: "SCORED",
          score,
          qualified: score.eligible && score.confidence !== "EXCLUDED",
        };
      }
    } catch {
      // A single unscoreable pair must not abandon the batch (§12.4).
      updated = { ...rec, scoreStatus: "ERROR", score: null, qualified: false };
    }
    pairs.writeAt(index, updated);
  }

  const remaining = pairs.readPendingWithIndex(batchId, 1).length;
  batches.update(
    batchId,
    remaining === 0
      ? { status: "CLUSTERING", phase: "CLUSTERING", revision: revision + 1 }
      : { phase: "SCORING", revision: revision + 1 },
  );
  return reread(gateway, batchId);
}

function clusteringPhase(
  gateway: SheetsGateway,
  cfg: DedupConfig,
  batch: BatchRecord,
): ScanState {
  const batches = batchesRepository(gateway);
  const pairs = pairsRepository(gateway);
  const batchId = String(batch.batchId);
  const schema = schemaOf(batch);
  const revision = num(batch.revision);

  const scores = pairs
    .readByBatch(batchId)
    .filter((p) => p.scoreStatus === "SCORED")
    .map((p) => p.score)
    .filter((s): s is PairScore => s !== null);

  const relevantHashes = new Map<string, string>();
  for (const rec of recordsRepository(gateway).readByBatch(batchId, schema.headers)) {
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
  clustersRepository(gateway).append(
    clusters.map((c) => ({
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
    })),
  );

  const qualifiedEdges = scores.filter(
    (s) => s.eligible && s.confidence !== "EXCLUDED",
  ).length;

  // Pair rows are working state; clusters carry everything review needs.
  pairs.deleteByBatch(batchId);

  batches.update(batchId, {
    status: "READY",
    phase: "READY",
    clusterCount: clusters.length,
    qualifiedEdgeCount: qualifiedEdges,
    revision: revision + 1,
  });
  auditRepository(gateway).append({
    eventType: "SCAN_COMPLETED",
    batchId,
    details: `clusters=${clusters.length}`,
  });
  return reread(gateway, batchId);
}
