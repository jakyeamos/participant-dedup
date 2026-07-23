import type { Handlers } from "@/server/rpc/handlers";
import type { RpcRequest } from "@/server/rpc/envelope";
import type {
  ApplyRequest,
  AuditPageRpcRequest,
  BatchRequest,
  ClusterRequest,
  FocusRequest,
  QueuePageRpcRequest,
  RepairRequest,
  SaveDecisionRequest,
  StartScanRequest,
} from "@/server/rpc/handlers";
import { createHandlers } from "@/server/rpc/handlers";
import { AppsScriptSheetsGateway } from "@/server/sheets/AppsScriptSheetsGateway";
import {
  menuApplyReviewedDecisions,
  menuOpenReviewSidebar,
  menuRefreshCurrentBatch,
  menuScanActiveSheet,
  menuViewChangeHistory,
  onOpen,
  reportRepair,
} from "@/server/menu";

/**
 * §6 The bundle's only public surface. Everything else stays private inside the
 * IIFE, so a name that is not in `ENTRY_POINTS` cannot be reached from a menu
 * item, a trigger, or `google.script.run`.
 */

/**
 * Any entry point, whatever request it takes. `never` in the parameter position
 * accepts every concrete request type while refusing to let a caller invent one
 * — this table is a registry, not a way to call the handlers.
 */
type EntryPoint = (request: never) => unknown;

let cachedHandlers: Handlers | null = null;

/**
 * One handler set per execution. An Apps Script execution gets a fresh script
 * context, so this caches the gateway and the config read within a single call
 * chain and never across users or invocations.
 */
function handlers(): Handlers {
  if (!cachedHandlers) cachedHandlers = createHandlers(new AppsScriptSheetsGateway());
  return cachedHandlers;
}

/**
 * §6 The allowlist, verbatim and in spec order. Adding a name here makes it
 * callable from the browser, so nothing belongs in this table that has not been
 * written to answer an untrusted caller.
 */
export const ENTRY_POINTS: Record<string, EntryPoint> = {
  onOpen,
  menuScanActiveSheet,
  menuOpenReviewSidebar,
  menuApplyReviewedDecisions,
  menuViewChangeHistory,
  menuRefreshCurrentBatch,

  rpcBootstrap: (request?: RpcRequest) => handlers().rpcBootstrap(request ?? {}),
  rpcStartScan: (request: StartScanRequest) => handlers().rpcStartScan(request ?? {}),
  rpcAdvanceScan: (request?: RpcRequest) => handlers().rpcAdvanceScan(request ?? {}),
  rpcGetQueuePage: (request: QueuePageRpcRequest) => handlers().rpcGetQueuePage(request),
  rpcGetCluster: (request: ClusterRequest) => handlers().rpcGetCluster(request),
  rpcSaveClusterDecision: (request: SaveDecisionRequest) =>
    handlers().rpcSaveClusterDecision(request),
  rpcGetBatchSummary: (request: BatchRequest) => handlers().rpcGetBatchSummary(request),
  rpcCreateApplyChallenge: (request: BatchRequest) => handlers().rpcCreateApplyChallenge(request),
  rpcApplyBatch: (request: ApplyRequest) => handlers().rpcApplyBatch(request),
  rpcGetAuditPage: (request: AuditPageRpcRequest) => handlers().rpcGetAuditPage(request),
  rpcCancelCurrentBatch: (request?: RpcRequest) => handlers().rpcCancelCurrentBatch(request ?? {}),

  /**
   * §6.1 Reached from the menu as well as the sidebar. A menu click arrives
   * with no request at all, and has no sidebar to render the envelope, so that
   * case — and only that case — reports itself as a toast.
   */
  rpcRepairDuplicateIds: (request?: RepairRequest) => {
    const result = handlers().rpcRepairDuplicateIds(request ?? {});
    if (request === undefined) reportRepair(result);
    return result;
  },

  rpcFocusSourceRow: (request: FocusRequest) => handlers().rpcFocusSourceRow(request),
};

/**
 * Apps Script resolves menu items, simple triggers and `google.script.run`
 * targets by looking the name up on the global object at call time, so the
 * registry is installed at load.
 */
export function installEntryPoints(target: Record<string, unknown>): void {
  for (const name of Object.keys(ENTRY_POINTS)) {
    target[name] = ENTRY_POINTS[name];
  }
}

installEntryPoints(globalThis as unknown as Record<string, unknown>);
