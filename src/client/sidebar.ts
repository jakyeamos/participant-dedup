import type { SidebarBoot } from "@/server/menu";
import type { BootstrapData, FocusResult } from "@/server/rpc/handlers";
import type { RpcError } from "@/server/rpc/envelope";
import type { ClusterDecision } from "@/server/types";
import type { ScanState } from "@/server/scan/scanStateMachine";
import type { QueuePage } from "@/server/review/queue";
import type { ClusterDetail } from "@/server/review/clusterDetail";
import type { BatchSummary } from "@/server/review/summary";
import type { CreatedChallenge } from "@/server/apply/preflight";
import type { ApplyResult } from "@/server/apply/applyDecisions";
import type { HistoryPage } from "@/server/history";
import type { BatchStatus } from "@/shared/constants";
import { clear } from "@/client/dom";
import {
  createRpcClient,
  googleScriptRunner,
  isRpcError,
  type RpcClient,
} from "@/client/rpc";
import { readFallbackName, writeFallbackName } from "@/client/session";
import {
  renderApplyConfirmation,
  renderApplyResult,
  renderBatchSummary,
} from "@/client/views/apply";
import { renderClusterReview } from "@/client/views/cluster";
import { renderHistory } from "@/client/views/history";
import { renderQueue, type QueueFilters } from "@/client/views/queue";
import {
  renderBootstrap,
  renderError,
  renderIdentityRequired,
  renderScanProgress,
} from "@/client/views/status";

/**
 * §21 The sidebar controller. Views stay pure; this module is the only place
 * that talks to the server, holds cross-screen state, and decides which view
 * to show next.
 */

const QUEUE_PAGE_SIZE = 25;

/** Statuses whose next action is another `rpcAdvanceScan` slice. */
const SCANNING = new Set<BatchStatus>([
  "INITIALIZING",
  "SNAPSHOTTING",
  "GENERATING_CANDIDATES",
  "SCORING",
  "CLUSTERING",
]);

interface SidebarState {
  boot: SidebarBoot;
  bootstrap: BootstrapData | null;
  batchId: string;
  filters: QueueFilters;
  queue: QueuePage | null;
  queueCursor: string | null;
  summary: BatchSummary | null;
  challenge: CreatedChallenge | null;
  history: HistoryPage | null;
  historyCursor: string | null;
  /** Set while a scan loop is driving itself; cleared on cancel or READY. */
  scanning: boolean;
  /** The action a retryable error should re-run. */
  retry: (() => void) | null;
}

function readBoot(): SidebarBoot {
  const raw = (globalThis as unknown as { __DEDUP_BOOT__?: unknown }).__DEDUP_BOOT__;
  if (raw && typeof raw === "object") {
    const candidate = raw as { view?: unknown; autoStart?: unknown };
    if (
      candidate.view === "BOOTSTRAP" ||
      candidate.view === "APPLY_CONFIRMATION" ||
      candidate.view === "AUDIT_HISTORY"
    ) {
      return { view: candidate.view, autoStart: candidate.autoStart === true };
    }
  }
  return { view: "BOOTSTRAP", autoStart: false };
}

/** §21.3 Every mutation carries the typed-in name when one is stored. */
function withIdentity(body: Record<string, unknown> = {}): Record<string, unknown> {
  const fallbackName = readFallbackName();
  return fallbackName === "" ? body : { ...body, fallbackName };
}

function asError(thrown: unknown): RpcError {
  if (isRpcError(thrown)) return thrown;
  return {
    code: "INTERNAL",
    message: "Something went wrong. Nothing was changed.",
    retryable: true,
  };
}

/** §21.7 Hand focus back to the spreadsheet after the server activates a cell. */
function focusSpreadsheet(): void {
  try {
    const host = (
      globalThis as unknown as {
        google?: { script?: { host?: { editor?: { focus?: () => void } } } };
      }
    ).google?.script?.host?.editor;
    host?.focus?.();
  } catch {
    // Focus is best-effort: a missing host must not leave the sidebar broken.
  }
}

function isScanning(state: ScanState): boolean {
  return SCANNING.has(state.status as BatchStatus);
}

/**
 * Mounts the sidebar into `root`. Tests and the bundled entry both call this;
 * only the real page has `__DEDUP_BOOT__` set by the Apps Script template.
 */
export function mountSidebar(
  root: HTMLElement,
  boot: SidebarBoot = readBoot(),
  rpc: RpcClient = createRpcClient(googleScriptRunner()),
): void {
  const state: SidebarState = {
    boot,
    bootstrap: null,
    batchId: "",
    filters: { confidence: ["HIGH", "MEDIUM"], statuses: ["UNREVIEWED", "IN_PROGRESS"] },
    queue: null,
    queueCursor: null,
    summary: null,
    challenge: null,
    history: null,
    historyCursor: null,
    scanning: false,
    retry: null,
  };

  function show(node: HTMLElement): void {
    clear(root);
    root.appendChild(node);
  }

  function fail(thrown: unknown, retry: (() => void) | null = null): void {
    state.scanning = false;
    state.retry = retry;
    const error = asError(thrown);
    if (error.code === "MISSING_REVIEWER_IDENTITY") {
      showIdentity();
      return;
    }
    show(
      renderError(error, {
        onRetry: () => {
          const again = state.retry;
          if (again) again();
        },
      }),
    );
  }

  function showIdentity(): void {
    show(
      renderIdentityRequired({
        onSubmit: (name) => {
          if (name === "") return;
          writeFallbackName(name);
          void start();
        },
      }),
    );
  }

  async function call<T>(name: string, request: Record<string, unknown> = {}): Promise<T> {
    return rpc.call<T>(name, withIdentity(request));
  }

  async function loadQueue(reset: boolean): Promise<void> {
    if (state.batchId === "") return;
    const page = await call<QueuePage>("rpcGetQueuePage", {
      batchId: state.batchId,
      confidence: state.filters.confidence,
      statuses: state.filters.statuses,
      cursor: reset ? null : state.queueCursor,
      pageSize: QUEUE_PAGE_SIZE,
    });
    if (reset || state.queue === null) {
      state.queue = page;
    } else {
      state.queue = {
        ...page,
        items: [...state.queue.items, ...page.items],
      };
    }
    state.queueCursor = page.nextCursor;
    show(
      renderQueue(state.queue, state.filters, {
        onFiltersChange: (filters) => {
          state.filters = filters;
          void run(() => loadQueue(true));
        },
        onOpenCluster: (clusterId) => {
          void run(() => openCluster(clusterId));
        },
        onLoadMore: () => {
          void run(() => loadQueue(false));
        },
        onReviewSummary: () => {
          void run(() => openSummary());
        },
      }),
    );
  }

  async function openCluster(clusterId: string): Promise<void> {
    const detail = await call<ClusterDetail>("rpcGetCluster", {
      batchId: state.batchId,
      clusterId,
    });
    show(
      renderClusterReview(detail, {
        onSave: (decision) => {
          void run(() => saveDecision(decision));
        },
        onFocusRow: (dedupId) => {
          void run(async () => {
            await call<FocusResult>("rpcFocusSourceRow", {
              batchId: state.batchId,
              dedupId,
            });
            focusSpreadsheet();
          });
        },
        onBack: () => {
          void run(() => loadQueue(true));
        },
      }),
    );
  }

  async function saveDecision(decision: ClusterDecision): Promise<void> {
    await call("rpcSaveClusterDecision", { decision });
    await loadQueue(true);
  }

  async function openSummary(): Promise<void> {
    const summary = await call<BatchSummary>("rpcGetBatchSummary", {
      batchId: state.batchId,
    });
    state.summary = summary;
    show(
      renderBatchSummary(summary, {
        onApply: () => {
          void run(() => openConfirmation());
        },
        onBack: () => {
          void run(() => loadQueue(true));
        },
      }),
    );
  }

  async function openConfirmation(): Promise<void> {
    if (state.batchId === "") return;
    const summary =
      state.summary ??
      (await call<BatchSummary>("rpcGetBatchSummary", { batchId: state.batchId }));
    state.summary = summary;
    const challenge = await call<CreatedChallenge>("rpcCreateApplyChallenge", {
      batchId: state.batchId,
    });
    state.challenge = challenge;
    const expected =
      state.bootstrap?.applyConfirmationText ?? challenge.warningText;
    show(
      renderApplyConfirmation(challenge, summary, expected, {
        onApply: (token) => {
          void run(() => applyBatch(token));
        },
        onBack: () => {
          void run(() => openSummary());
        },
      }),
    );
  }

  async function applyBatch(token: string): Promise<void> {
    const challenge = state.challenge;
    if (!challenge) throw asError(null);
    const result = await call<ApplyResult>("rpcApplyBatch", {
      batchId: state.batchId,
      token,
      summaryHash: challenge.summaryHash,
      confirmed: true,
    });
    state.challenge = null;
    show(
      renderApplyResult(result, {
        onDone: () => {
          void run(() => loadQueue(true));
        },
      }),
    );
  }

  async function openHistory(reset: boolean): Promise<void> {
    const request: Record<string, unknown> = {
      cursor: reset ? null : state.historyCursor,
      pageSize: QUEUE_PAGE_SIZE,
    };
    if (state.batchId !== "") request.batchId = state.batchId;
    const page = await call<HistoryPage>("rpcGetAuditPage", request);
    if (reset || state.history === null) {
      state.history = page;
    } else {
      state.history = {
        ...page,
        events: [...state.history.events, ...page.events],
      };
    }
    state.historyCursor = page.nextCursor;
    show(
      renderHistory(state.history, {
        onLoadMore: () => {
          void run(() => openHistory(false));
        },
      }),
    );
  }

  async function runScanLoop(initial: ScanState): Promise<void> {
    let current = initial;
    state.scanning = true;
    state.batchId = current.batchId;

    while (state.scanning && isScanning(current)) {
      show(
        renderScanProgress(current, {
          onCancel: () => {
            void run(async () => {
              state.scanning = false;
              await call<ScanState>("rpcCancelCurrentBatch", {});
              await start();
            });
          },
        }),
      );
      current = await call<ScanState>("rpcAdvanceScan", {});
      state.batchId = current.batchId;
    }

    state.scanning = false;

    if (current.status === "FAILED") {
      fail({
        code: current.errorCode ?? "INTERNAL",
        message: "The scan stopped before it finished. Nothing was deleted.",
        retryable: true,
      }, () => {
        void run(async () => {
          const started = await call<ScanState>("rpcStartScan", {});
          await runScanLoop(started);
        });
      });
      return;
    }

    if (current.status === "CANCELLED") {
      await start();
      return;
    }

    if (current.status === "READY" || current.status === "APPLIED" || current.status === "APPLYING") {
      await loadQueue(true);
      return;
    }

    await loadQueue(true);
  }

  function showLanding(): void {
    const data = state.bootstrap;
    show(
      renderBootstrap(
        {
          activeSheetName: data?.activeSheetName ?? null,
          identityDisplay: data?.identity.display ?? "",
        },
        {
          onStartScan: () => {
            void run(async () => {
              const started = await call<ScanState>("rpcStartScan", {});
              await runScanLoop(started);
            });
          },
          onOpenHistory: () => {
            void run(() => openHistory(true));
          },
        },
      ),
    );
  }

  async function start(): Promise<void> {
    const data = await call<BootstrapData>("rpcBootstrap", {});
    state.bootstrap = data;
    state.filters = {
      confidence: [...data.defaultFilters.confidence],
      statuses: [...data.defaultFilters.statuses],
    };

    if (data.identity.needsFallbackName && readFallbackName() === "") {
      showIdentity();
      return;
    }

    const active = data.activeBatch;
    if (active) state.batchId = active.batchId;

    if (state.boot.view === "AUDIT_HISTORY") {
      await openHistory(true);
      return;
    }

    if (state.boot.view === "APPLY_CONFIRMATION") {
      if (!active || state.batchId === "") {
        showLanding();
        return;
      }
      await openConfirmation();
      return;
    }

    // BOOTSTRAP
    if (state.boot.autoStart) {
      const started = await call<ScanState>("rpcStartScan", {});
      await runScanLoop(started);
      return;
    }

    if (active && isScanning(active)) {
      await runScanLoop(active);
      return;
    }

    if (active && (active.status === "READY" || active.status === "APPLIED" || active.status === "APPLYING" || active.status === "PAUSED")) {
      await loadQueue(true);
      return;
    }

    showLanding();
  }

  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (thrown) {
      fail(thrown, () => {
        void run(action);
      });
    }
  }

  void run(start);
}

const pageRoot = typeof document !== "undefined" ? document.getElementById("app") : null;
if (pageRoot && (globalThis as unknown as { __DEDUP_BOOT__?: unknown }).__DEDUP_BOOT__) {
  mountSidebar(pageRoot);
}
