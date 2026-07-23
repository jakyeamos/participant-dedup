import { isDedupError, isRetryable, safeMessageFor, type DedupErrorCode } from "@/server/errors";

/**
 * §6.2 The one shape every `google.script.run` call returns. Nothing else
 * crosses the boundary: a thrown Apps Script error reaches the browser as an
 * opaque failure the sidebar cannot classify, so every handler answers with an
 * envelope instead — success or failure, always with the request it answers.
 */
export interface RpcError {
  code: DedupErrorCode;
  message: string;
  /** Whether repeating the same call unchanged could succeed. */
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type RpcResult<T> =
  | { ok: true; requestId: string; data: T }
  | { ok: false; requestId: string; error: RpcError };

/** What every request body carries, whatever else it adds. */
export interface RpcRequest {
  /** Correlates the answer with the call; minted here when absent. */
  requestId?: string;
  /** §21.3 The typed-in reviewer name, sent when the account email is blank. */
  fallbackName?: string;
}

let requestSeq = 0;

/**
 * A request id for calls that arrive without one. Apps Script executions are
 * single-threaded, so a counter plus the clock is enough to keep the ids of one
 * session distinct — this is a correlation handle, not a secret.
 */
export function newRequestId(): string {
  requestSeq += 1;
  return `req_${Date.now().toString(36)}_${requestSeq}`;
}

/**
 * The id is echoed back to the browser, so it is reduced to characters that
 * cannot escape a text node or grow a payload without bound.
 */
function requestIdOf(request: RpcRequest | undefined): string {
  const raw = (request?.requestId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return raw === "" ? newRequestId() : raw;
}

/**
 * §6.2 Runs one handler body and reports it as an envelope. A `DedupError`
 * keeps its code and its safe message; anything else — a Sheets failure, a bug —
 * becomes `INTERNAL`, because an unexpected message can quote a cell and §21.8
 * forbids sending participant values anywhere they were not asked for. No stack
 * ever leaves this function.
 */
export function runRpc<T>(request: RpcRequest | undefined, fn: () => T): RpcResult<T> {
  const requestId = requestIdOf(request);
  try {
    return { ok: true, requestId, data: fn() };
  } catch (thrown) {
    const code: DedupErrorCode = isDedupError(thrown) ? thrown.code : "INTERNAL";
    return {
      ok: false,
      requestId,
      error: { code, message: safeMessageFor(code), retryable: isRetryable(code) },
    };
  }
}
