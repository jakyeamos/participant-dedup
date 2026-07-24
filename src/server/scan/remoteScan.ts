import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { DedupConfig } from "@/shared/config";
import type { ScanState } from "@/server/scan/scanStateMachine";
import { DedupError } from "@/server/errors";
import { batchesRepository } from "@/server/batchesRepository";
import { stateFromBatch } from "@/server/scan/scanStateMachine";

/**
 * Apps Script → owned Railway scan API. The request body carries spreadsheet id
 * + sheet name only; the backend reads participant rows via a service account.
 * URL and API key come from Script Properties (never hardcoded in source).
 */

interface RemoteJobTimings {
  loadMs: number;
  scanMs: number;
  flushMs: number;
  sheetsLoaded: number;
  progressFlushes: number;
}

interface RemoteJobResponse {
  batchId: string;
  state: ScanState;
  running: boolean;
  error: string | null;
  timings?: RemoteJobTimings;
}

function scriptProperty(key: string): string | null {
  if (typeof PropertiesService === "undefined") return null;
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

export function hasAppsScriptProperties(): boolean {
  return typeof PropertiesService !== "undefined";
}

/**
 * - Outside Apps Script (vitest): local scan engine.
 * - `DEDUP_USE_LOCAL_SCAN=1`: emergency local path.
 * - Apps Script without URL/key: `BACKEND_NOT_CONFIGURED`.
 */
export function shouldUseRemoteScan(): boolean {
  if (!hasAppsScriptProperties()) return false;
  if (scriptProperty("DEDUP_USE_LOCAL_SCAN") === "1") return false;
  const url = scriptProperty("DEDUP_API_URL");
  const key = scriptProperty("DEDUP_API_KEY");
  if (!url || !key) throw new DedupError("BACKEND_NOT_CONFIGURED");
  return true;
}

function apiConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = scriptProperty("DEDUP_API_URL");
  const apiKey = scriptProperty("DEDUP_API_KEY");
  if (!baseUrl || !apiKey) throw new DedupError("BACKEND_NOT_CONFIGURED");
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

function fetchJson(method: string, path: string, body?: Record<string, unknown>): RemoteJobResponse {
  if (typeof UrlFetchApp === "undefined") throw new DedupError("BACKEND_NOT_CONFIGURED");
  const { baseUrl, apiKey } = apiConfig();
  const response = UrlFetchApp.fetch(`${baseUrl}${path}`, {
    method: method as GoogleAppsScript.URL_Fetch.HttpMethod,
    contentType: "application/json",
    headers: { "X-Api-Key": apiKey },
    payload: body === undefined ? undefined : JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new DedupError("INTERNAL");
  return JSON.parse(response.getContentText()) as RemoteJobResponse;
}

/**
 * While the backend job is still running, prefer its in-memory state (progress).
 * After it finishes, prefer the flushed sheet row.
 */
function preferState(gateway: SheetsGateway, remote: RemoteJobResponse): ScanState {
  if (remote.running) return remote.state;
  if (remote.batchId) {
    const batch = batchesRepository(gateway).get(remote.batchId);
    if (batch) return stateFromBatch(batch);
  }
  const active = batchesRepository(gateway).getActive();
  if (active) return stateFromBatch(active);
  return remote.state;
}

export function startRemoteScan(
  gateway: SheetsGateway,
  sheetName: string,
  _cfg: DedupConfig,
  fallbackName?: string,
): ScanState {
  void _cfg;
  const remote = fetchJson("post", "/v1/scans", {
    spreadsheetId: gateway.getSpreadsheetId(),
    sheetName,
    fallbackName,
  });
  if (remote.error && remote.state.status === "FAILED" && !remote.batchId) {
    throw new DedupError("INTERNAL");
  }
  return preferState(gateway, remote);
}

export function advanceRemoteScan(gateway: SheetsGateway, fallbackName?: string): ScanState {
  const active = batchesRepository(gateway).getActive();
  if (!active) throw new DedupError("BATCH_STATE_CONFLICT");

  const batchId = String(active.batchId);
  const qs = [
    `spreadsheetId=${encodeURIComponent(gateway.getSpreadsheetId())}`,
    fallbackName ? `fallbackName=${encodeURIComponent(fallbackName)}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const remote = fetchJson("get", `/v1/scans/${encodeURIComponent(batchId)}?${qs}`);
  return preferState(gateway, remote);
}

export function cancelRemoteScan(gateway: SheetsGateway, fallbackName?: string): ScanState {
  const active = batchesRepository(gateway).getActive();
  if (!active) throw new DedupError("BATCH_STATE_CONFLICT");
  const remote = fetchJson("post", `/v1/scans/${encodeURIComponent(String(active.batchId))}/cancel`, {
    spreadsheetId: gateway.getSpreadsheetId(),
    fallbackName,
  });
  return preferState(gateway, remote);
}
