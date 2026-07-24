import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { ClusterDecision, SourceSchema } from "@/server/types";
import type { DedupConfig } from "@/shared/config";
import type { ClusterStatus, Confidence } from "@/shared/constants";
import type { ClusterDetail } from "@/server/review/clusterDetail";
import type { QueueCounts, QueuePage, QueuePageRequest } from "@/server/review/queue";
import type { BatchSummary } from "@/server/review/summary";
import type { HistoryPage, HistoryPageRequest } from "@/server/history";
import type { SavedDecision } from "@/server/review/decisions";
import type { ApplyResult } from "@/server/apply/applyDecisions";
import type { CreatedChallenge } from "@/server/apply/preflight";
import type { ScanState } from "@/server/scan/scanStateMachine";
import { cloneDefaultConfig } from "@/shared/config";
import { DedupError } from "@/server/errors";
import { colLetters, ensureSystemSheets } from "@/server/systemSheets";
import { configRepository } from "@/server/configRepository";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { resolveSchema } from "@/server/schemaResolver";
import { auditActor, tryResolveReviewer } from "@/server/identity";
import { repairDuplicateIds } from "@/server/dedupIdService";
import { advanceScan, cancelScan, startScan, stateFromBatch } from "@/server/scan/scanStateMachine";
import {
  advanceRemoteScan,
  cancelRemoteScan,
  shouldUseRemoteScan,
  startRemoteScan,
} from "@/server/scan/remoteScan";
import { getQueuePage } from "@/server/review/queue";
import { getClusterDetail } from "@/server/review/clusterDetail";
import { saveClusterDecision } from "@/server/review/decisions";
import { getBatchSummary } from "@/server/review/summary";
import { getHistoryPage } from "@/server/history";
import { applyDecisions } from "@/server/apply/applyDecisions";
import { APPLY_CONFIRMATION_TEXT, createApplyChallenge } from "@/server/apply/preflight";
import { runRpc, type RpcRequest, type RpcResult } from "@/server/rpc/envelope";

/** §21.2 Who the sidebar is acting as, and whether it must ask. */
export interface BootstrapIdentity {
  email: string | null;
  /** What the sidebar shows; empty while nothing identifies the reviewer. */
  display: string;
  needsFallbackName: boolean;
}

export interface BootstrapData {
  identity: BootstrapIdentity;
  /** The sheet `Scan Active Sheet` would act on. */
  activeSheetName: string | null;
  activeBatch: ScanState | null;
  /** The sheet the active batch was scanned from, empty when there is none. */
  sourceSheetName: string;
  counts: QueueCounts | null;
  /**
   * First queue page for a reviewable active batch, so the sidebar can paint
   * without a second cold `rpcGetQueuePage` round-trip.
   */
  queue: QueuePage | null;
  defaultFilters: { confidence: Confidence[]; statuses: ClusterStatus[] };
  /** §24 The exact sentence the reviewer must accept before an apply runs. */
  applyConfirmationText: string;
}

export interface StartScanRequest extends RpcRequest {
  /** Defaults to the sheet the user is looking at. */
  sheetName?: string;
}

export interface BatchRequest extends RpcRequest {
  batchId: string;
}

export interface ClusterRequest extends BatchRequest {
  clusterId: string;
}

export interface SaveDecisionRequest extends RpcRequest {
  decision: ClusterDecision;
}

export interface ApplyRequest extends BatchRequest {
  token: string;
  summaryHash: string;
  confirmed: boolean;
}

export interface FocusRequest extends BatchRequest {
  dedupId: string;
}

export interface RepairRequest extends RpcRequest {
  sheetName?: string;
}

export type QueuePageRpcRequest = QueuePageRequest & RpcRequest;
export type AuditPageRpcRequest = HistoryPageRequest & RpcRequest;

/** Where `Open source row` landed. */
export interface FocusResult {
  sheetName: string;
  row: number;
}

export interface Handlers {
  rpcBootstrap(request?: RpcRequest): RpcResult<BootstrapData>;
  rpcStartScan(request: StartScanRequest): RpcResult<ScanState>;
  rpcAdvanceScan(request?: RpcRequest): RpcResult<ScanState>;
  rpcCancelCurrentBatch(request?: RpcRequest): RpcResult<ScanState>;
  rpcGetQueuePage(request: QueuePageRpcRequest): RpcResult<QueuePage>;
  rpcGetCluster(request: ClusterRequest): RpcResult<ClusterDetail>;
  rpcSaveClusterDecision(request: SaveDecisionRequest): RpcResult<SavedDecision>;
  rpcGetBatchSummary(request: BatchRequest): RpcResult<BatchSummary>;
  rpcCreateApplyChallenge(request: BatchRequest): RpcResult<CreatedChallenge>;
  rpcApplyBatch(request: ApplyRequest): RpcResult<ApplyResult>;
  rpcGetAuditPage(request: AuditPageRpcRequest): RpcResult<HistoryPage>;
  rpcRepairDuplicateIds(request: RepairRequest): RpcResult<{ repaired: number }>;
  rpcFocusSourceRow(request: FocusRequest): RpcResult<FocusResult>;
}

/** §21.4 High and Medium checked, Low unchecked; only undecided clusters. */
const DEFAULT_CONFIDENCE: Confidence[] = ["HIGH", "MEDIUM"];
const DEFAULT_STATUSES: ClusterStatus[] = ["UNREVIEWED", "IN_PROGRESS"];

/**
 * Clusters a confirmed apply acts on. `APPLIED` belongs here: §26.3 requires a
 * replay of an interrupted run to reproduce the same summary hash, and it can
 * only do that if the decisions already written are still counted. `KEEP_ALL`
 * and `UNRESOLVED` are absent because they delete nothing.
 */
const APPLICABLE_STATUSES = new Set<string>(["READY_TO_APPLY", "APPLIED"]);

/**
 * §6 The whole server surface, with the gateway injected so tests drive it
 * against `FakeSheetsGateway`. Every method answers with an envelope; none of
 * them throws.
 */
export function createHandlers(gateway: SheetsGateway): Handlers {
  let cached: DedupConfig | null = null;

  /**
   * The stored config, seeding the system sheets first: a virgin spreadsheet has
   * no config sheet to read, and the sidebar's first call must still work.
   */
  const config = (): DedupConfig => {
    if (!cached) {
      ensureSystemSheets(gateway, cloneDefaultConfig());
      cached = configRepository(gateway).load();
    }
    return cached;
  };

  /**
   * The sheet a request means. An explicit name wins; otherwise it is whichever
   * sheet the user is looking at, which is what the §6.1 menu items act on. A
   * bound script always has an active sheet, so the last case is unreachable in
   * the add-on and only guards a misconfigured caller.
   */
  const sheetNameFor = (explicit?: string): string => {
    const named = (explicit ?? "").trim();
    if (named !== "") return named;
    const active = gateway.getActiveSheetName();
    if (active === null || active === "") throw new DedupError("INTERNAL");
    return active;
  };

  const schemaOfBatch = (batchId: string): SourceSchema => {
    const batch = batchesRepository(gateway).get(batchId);
    if (!batch) throw new DedupError("BATCH_NOT_FOUND");
    return batch.schema as unknown as SourceSchema;
  };

  /**
   * The decisions an apply covers, read from the cluster rows rather than taken
   * from the browser: the client cannot widen an apply beyond what was saved.
   * The session's fallback name is grafted back on because the stored decision
   * deliberately drops it (§21.3) and the apply still has to be attributed.
   */
  const applicableDecisions = (batchId: string, fallbackName?: string): ClusterDecision[] => {
    const decisions: ClusterDecision[] = [];
    for (const row of clustersRepository(gateway).listByBatch(batchId)) {
      if (!APPLICABLE_STATUSES.has(String(row.status))) continue;
      const decision = row.decision;
      if (!decision || typeof decision !== "object") continue;
      decisions.push(
        fallbackName
          ? { ...(decision as unknown as ClusterDecision), fallbackReviewerName: fallbackName }
          : (decision as unknown as ClusterDecision),
      );
    }
    return decisions;
  };

  return {
    rpcBootstrap(request: RpcRequest = {}): RpcResult<BootstrapData> {
      return runRpc(request, () => {
        const cfg = config();
        const reviewer = tryResolveReviewer(gateway, request.fallbackName);
        const active = batchesRepository(gateway).getActive();
        const batchId = active ? String(active.batchId) : "";
        const defaultFilters = {
          confidence: [...DEFAULT_CONFIDENCE],
          statuses: [...DEFAULT_STATUSES],
        };
        // One page for reviewable batches — avoids a second cold RPC on open.
        const reviewable =
          active !== null &&
          (active.status === "READY" ||
            active.status === "APPLIED" ||
            active.status === "APPLYING" ||
            active.status === "PAUSED");
        const queue =
          batchId !== "" && reviewable
            ? getQueuePage(
                gateway,
                {
                  batchId,
                  confidence: defaultFilters.confidence,
                  statuses: defaultFilters.statuses,
                  cursor: null,
                  pageSize: cfg.execution.queuePageSize,
                },
                cfg,
              )
            : null;

        return {
          identity: {
            email: reviewer?.email ?? null,
            display: reviewer?.display ?? "",
            needsFallbackName: reviewer === null,
          },
          activeSheetName: gateway.getActiveSheetName(),
          activeBatch: active ? stateFromBatch(active) : null,
          sourceSheetName: active ? String(active.sourceSheetName ?? "") : "",
          counts: queue?.counts ?? null,
          queue,
          defaultFilters,
          applyConfirmationText: APPLY_CONFIRMATION_TEXT,
        };
      });
    },

    rpcStartScan(request: StartScanRequest): RpcResult<ScanState> {
      return runRpc(request, () => {
        const sheetName = sheetNameFor(request.sheetName);
        const cfg = config();
        if (shouldUseRemoteScan()) {
          return startRemoteScan(gateway, sheetName, cfg, request.fallbackName);
        }
        return startScan(gateway, sheetName, cfg, request.fallbackName);
      });
    },

    rpcAdvanceScan(request: RpcRequest = {}): RpcResult<ScanState> {
      return runRpc(request, () => {
        if (shouldUseRemoteScan()) {
          return advanceRemoteScan(gateway, request.fallbackName);
        }
        return advanceScan(gateway, config(), request.fallbackName);
      });
    },

    rpcCancelCurrentBatch(request: RpcRequest = {}): RpcResult<ScanState> {
      return runRpc(request, () => {
        if (shouldUseRemoteScan()) {
          return cancelRemoteScan(gateway, request.fallbackName);
        }
        return cancelScan(gateway, config(), request.fallbackName);
      });
    },

    rpcGetQueuePage(request: QueuePageRpcRequest): RpcResult<QueuePage> {
      return runRpc(request, () => getQueuePage(gateway, request, config()));
    },

    rpcGetCluster(request: ClusterRequest): RpcResult<ClusterDetail> {
      return runRpc(request, () =>
        getClusterDetail(gateway, request.batchId, request.clusterId, config()),
      );
    },

    rpcSaveClusterDecision(request: SaveDecisionRequest): RpcResult<SavedDecision> {
      return runRpc(request, () =>
        saveClusterDecision(
          gateway,
          request.fallbackName
            ? { ...request.decision, fallbackReviewerName: request.fallbackName }
            : request.decision,
          config(),
        ),
      );
    },

    rpcGetBatchSummary(request: BatchRequest): RpcResult<BatchSummary> {
      return runRpc(request, () => getBatchSummary(gateway, request.batchId, config()));
    },

    rpcCreateApplyChallenge(request: BatchRequest): RpcResult<CreatedChallenge> {
      return runRpc(request, () =>
        createApplyChallenge(
          gateway,
          request.batchId,
          applicableDecisions(request.batchId, request.fallbackName),
          config(),
        ),
      );
    },

    rpcApplyBatch(request: ApplyRequest): RpcResult<ApplyResult> {
      return runRpc(request, () =>
        applyDecisions(
          gateway,
          request.batchId,
          applicableDecisions(request.batchId, request.fallbackName),
          {
            token: request.token,
            summaryHash: request.summaryHash,
            confirmed: request.confirmed === true,
          },
          config(),
        ),
      );
    },

    rpcGetAuditPage(request: AuditPageRpcRequest): RpcResult<HistoryPage> {
      return runRpc(request, () => getHistoryPage(gateway, request, config()));
    },

    rpcRepairDuplicateIds(request: RepairRequest): RpcResult<{ repaired: number }> {
      return runRpc(request, () => {
        const cfg = config();
        const schema = resolveSchema(gateway, sheetNameFor(request.sheetName), cfg);
        return repairDuplicateIds(gateway, schema, auditActor(gateway, request.fallbackName));
      });
    },

    /**
     * §21.7 Finds the participant's row as the sheet stands now — not where the
     * scan saw it — and puts the cursor on it. Read-only: a row that has since
     * been deleted or had its id cleared is reported as stale, never guessed at.
     */
    rpcFocusSourceRow(request: FocusRequest): RpcResult<FocusResult> {
      return runRpc(request, () => {
        const cfg = config();
        const sheetName = schemaOfBatch(request.batchId).sheetName;
        const live = resolveSchema(gateway, sheetName, cfg);
        if (live.dedupIdColumnIndex < 0) throw new DedupError("SCHEMA_CHANGED");

        const firstRow = live.headerRow + 1;
        const { rowCount } = gateway.getGridSize(sheetName);
        if (rowCount < firstRow) throw new DedupError("STALE_ROW");

        const letter = colLetters(live.dedupIdColumnIndex);
        const ids = gateway.readRange(sheetName, `${letter}${firstRow}:${letter}${rowCount}`);
        const offset = ids.findIndex((cells) => String(cells[0] ?? "") === request.dedupId);
        if (offset < 0) throw new DedupError("STALE_ROW");

        const row = firstRow + offset;
        gateway.activateCell(sheetName, row, 1);
        return { sheetName, row };
      });
    },
  };
}
