import { performance } from "node:perf_hooks";
import type { DedupConfig } from "@/shared/config";
import type { ScanState } from "@/server/scan/scanStateMachine";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { batchesRepository } from "@/server/batchesRepository";
import { cloneDefaultConfig } from "@/shared/config";
import { advanceScan, cancelScan, startScan, stateFromBatch } from "@/server/scan/scanStateMachine";
import type { GoogleWorkbookBridge } from "./googleWorkbookBridge";

export interface StartScanJobRequest {
  spreadsheetId: string;
  sheetName: string;
  fallbackName?: string;
}

export interface BatchScanJobRequest {
  spreadsheetId: string;
  batchId: string;
  fallbackName?: string;
}

export interface ScanJobTimings {
  loadMs: number;
  scanMs: number;
  flushMs: number;
  sheetsLoaded: number;
  progressFlushes: number;
}

export interface ScanJobResponse {
  batchId: string;
  state: ScanState;
  running: boolean;
  error: string | null;
  timings: ScanJobTimings;
}

interface JobRecord {
  spreadsheetId: string;
  sheetName: string;
  batchId: string;
  state: ScanState;
  running: boolean;
  cancelled: boolean;
  error: string | null;
  gateway: FakeSheetsGateway;
  timings: ScanJobTimings;
  fallbackName?: string;
}

/** Units of advanceScan between progress flushes to Sheets. */
const PROGRESS_EVERY_UNITS = 8;

function remoteConfig(base: DedupConfig = cloneDefaultConfig()): DedupConfig {
  const cfg = JSON.parse(JSON.stringify(base)) as DedupConfig;
  cfg.execution.sliceBudgetMs = 0;
  cfg.execution.maxParticipantRows = Math.max(cfg.execution.maxParticipantRows, 15000);
  cfg.execution.inMemoryPairScoreMax = Math.max(cfg.execution.inMemoryPairScoreMax, 200000);
  cfg.execution.sheetWriteChunkSize = Math.max(cfg.execution.sheetWriteChunkSize, 500);
  cfg.execution.recordWriteChunkSize = Math.max(cfg.execution.recordWriteChunkSize, 500);
  cfg.execution.pairScoreChunkSize = Math.max(cfg.execution.pairScoreChunkSize, 5000);
  // Keep remote matching under a tighter candidate ceiling than the legacy 200k default.
  cfg.blocking.maxTotalCandidates = Math.min(cfg.blocking.maxTotalCandidates, 300000);
  cfg.blocking.fuzzyOnlyCandidatesPerRecord = Math.min(
    cfg.blocking.fuzzyOnlyCandidatesPerRecord,
    50,
  );
  cfg.blocking.commonTokenBlockMax = Math.min(cfg.blocking.commonTokenBlockMax, 100);
  cfg.blocking.trigramPostingMax = Math.min(cfg.blocking.trigramPostingMax, 150);
  return cfg;
}

function terminal(state: ScanState): boolean {
  return (
    state.status === "READY" ||
    state.status === "FAILED" ||
    state.status === "CANCELLED" ||
    state.status === "APPLIED" ||
    state.status === "SUPERSEDED"
  );
}

function emptyTimings(): ScanJobTimings {
  return { loadMs: 0, scanMs: 0, flushMs: 0, sheetsLoaded: 0, progressFlushes: 0 };
}

function responseFor(job: JobRecord): ScanJobResponse {
  return {
    batchId: job.batchId,
    state: job.state,
    running: job.running,
    error: job.error,
    timings: { ...job.timings },
  };
}

/**
 * Async scan jobs with pollable progress:
 * load needed sheets → start → flush batches → continue in background with
 * periodic progress flushes → final output flush.
 */
export class ScanJobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly cfg: DedupConfig;

  constructor(
    private readonly bridge: GoogleWorkbookBridge,
    cfg: DedupConfig = remoteConfig(),
  ) {
    this.cfg = cfg;
  }

  async start(request: StartScanJobRequest): Promise<ScanJobResponse> {
    const loadStarted = performance.now();
    const loaded = await this.bridge.load(request.spreadsheetId, request.sheetName, "scan");
    const loadMs = performance.now() - loadStarted;

    const scanStarted = performance.now();
    let state = startScan(loaded.gateway, request.sheetName, this.cfg, request.fallbackName);
    const scanMs = performance.now() - scanStarted;

    const flushStarted = performance.now();
    await this.bridge.flushProgress(request.spreadsheetId, loaded.gateway);
    const flushMs = performance.now() - flushStarted;

    const job: JobRecord = {
      spreadsheetId: request.spreadsheetId,
      sheetName: request.sheetName,
      batchId: state.batchId,
      state,
      running: !terminal(state),
      cancelled: false,
      error: null,
      gateway: loaded.gateway,
      fallbackName: request.fallbackName,
      timings: {
        loadMs: Math.round(loadMs),
        scanMs: Math.round(scanMs),
        flushMs: Math.round(flushMs),
        sheetsLoaded: loaded.sheetsLoaded,
        progressFlushes: 1,
      },
    };
    this.jobs.set(job.batchId, job);

    if (job.running) {
      this.continueInBackground(job);
    } else {
      const finalFlushStarted = performance.now();
      await this.bridge.flushScanOutputs(request.spreadsheetId, loaded.gateway, request.sheetName);
      job.timings.flushMs += Math.round(performance.now() - finalFlushStarted);
    }
    return responseFor(job);
  }

  async get(request: BatchScanJobRequest): Promise<ScanJobResponse> {
    const existing = this.jobs.get(request.batchId);
    if (existing) return responseFor(existing);

    const loaded = await this.bridge.load(request.spreadsheetId, null, "status");
    const batch = batchesRepository(loaded.gateway).get(request.batchId);
    if (!batch) throw new Error("Batch not found");
    const state = stateFromBatch(batch);
    return {
      batchId: request.batchId,
      state,
      running: !terminal(state),
      error: null,
      timings: { ...emptyTimings(), sheetsLoaded: loaded.sheetsLoaded },
    };
  }

  async cancel(request: BatchScanJobRequest): Promise<ScanJobResponse> {
    const existing = this.jobs.get(request.batchId);
    if (existing) {
      existing.cancelled = true;
      existing.running = false;
      existing.state = cancelScan(existing.gateway, this.cfg, request.fallbackName);
      const flushStarted = performance.now();
      await this.bridge.flushScanOutputs(
        request.spreadsheetId,
        existing.gateway,
        existing.sheetName,
      );
      existing.timings.flushMs += Math.round(performance.now() - flushStarted);
      return responseFor(existing);
    }

    const loaded = await this.bridge.load(request.spreadsheetId, null, "scan");
    const state = cancelScan(loaded.gateway, this.cfg, request.fallbackName);
    const sheetName = String(
      batchesRepository(loaded.gateway).get(request.batchId)?.sourceSheetName ?? "",
    );
    await this.bridge.flushScanOutputs(request.spreadsheetId, loaded.gateway, sheetName);
    return {
      batchId: request.batchId,
      state,
      running: false,
      error: null,
      timings: { ...emptyTimings(), sheetsLoaded: loaded.sheetsLoaded },
    };
  }

  private continueInBackground(job: JobRecord): void {
    void Promise.resolve().then(() => this.runToCompletion(job));
  }

  private async runToCompletion(job: JobRecord): Promise<void> {
    try {
      let units = 0;
      let lastPhase = job.state.phase;
      const scanStarted = performance.now();
      while (!terminal(job.state) && !job.cancelled) {
        job.state = advanceScan(job.gateway, this.cfg, job.fallbackName);
        units += 1;
        const phaseChanged = job.state.phase !== lastPhase;
        if (phaseChanged || units % PROGRESS_EVERY_UNITS === 0) {
          lastPhase = job.state.phase;
          const flushStarted = performance.now();
          await this.bridge.flushProgress(job.spreadsheetId, job.gateway);
          job.timings.flushMs += Math.round(performance.now() - flushStarted);
          job.timings.progressFlushes += 1;
        }
        if (units > 100000) throw new Error("scan guard exceeded");
      }
      job.timings.scanMs += Math.round(performance.now() - scanStarted);

      if (!job.cancelled) {
        const flushStarted = performance.now();
        await this.bridge.flushScanOutputs(job.spreadsheetId, job.gateway, job.sheetName);
        job.timings.flushMs += Math.round(performance.now() - flushStarted);
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      try {
        await this.bridge.flushScanOutputs(job.spreadsheetId, job.gateway, job.sheetName);
      } catch {
        // Keep original error.
      }
    } finally {
      job.running = false;
    }
  }
}

/** Test helper: run a scan against an already-loaded fake gateway (no Google I/O). */
export function runScanOnGateway(
  gateway: FakeSheetsGateway,
  sheetName: string,
  cfg: DedupConfig = remoteConfig(),
  fallbackName?: string,
): ScanState {
  let state = startScan(gateway, sheetName, cfg, fallbackName);
  let guard = 0;
  while (!terminal(state) && guard++ < 100000) {
    state = advanceScan(gateway, cfg, fallbackName);
  }
  if (guard >= 100000) throw new Error("scan guard exceeded");
  return state;
}

export { remoteConfig };
