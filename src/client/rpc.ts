import type { RpcError, RpcResult } from "@/server/rpc/envelope";

/**
 * §6.3 The browser side of the boundary. One call is in flight at a time, and
 * every answer is an envelope. Nothing else in the client knows that
 * `google.script.run` exists, which is what lets the views and the controller
 * run under jsdom.
 */

/** A transport. The real one wraps `google.script.run`; tests pass a fake. */
export interface ScriptRunner {
  call(name: string, request: unknown): Promise<unknown>;
}

export interface RpcClient {
  /** Resolves the envelope's `data`, or rejects with its `RpcError`. */
  call<T>(name: string, request?: unknown): Promise<T>;
  readonly busy: boolean;
}

const INTERNAL: RpcError = {
  code: "INTERNAL",
  message: "Something went wrong. Nothing was changed.",
  retryable: true,
};

export function isRpcError(value: unknown): value is RpcError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RpcError>;
  return typeof candidate.code === "string" && typeof candidate.retryable === "boolean";
}

/**
 * A response reduced to an envelope. Anything that is not one — a transport
 * error, a login page, a bug that returned a bare value — becomes `INTERNAL`
 * rather than being trusted: the sidebar renders what it is handed, and §21.8
 * forbids showing text nobody vetted.
 */
function asEnvelope<T>(value: unknown): RpcResult<T> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { ok?: unknown; requestId?: unknown };
  if (typeof candidate.ok !== "boolean" || typeof candidate.requestId !== "string") return null;
  return value as RpcResult<T>;
}

/**
 * The production transport. `google` is looked up inside the call, never at
 * module scope, so importing this file under jsdom does not need it to exist.
 */
export function googleScriptRunner(): ScriptRunner {
  return {
    call(name, request) {
      return new Promise((resolve, reject) => {
        type Runner = {
          withSuccessHandler(fn: (value: unknown) => void): Runner;
          withFailureHandler(fn: (error: unknown) => void): Record<string, (arg: unknown) => void>;
        };
        const runner = (
          globalThis as unknown as {
            google?: { script?: { run?: Runner } };
          }
        ).google?.script?.run;
        if (!runner) {
          reject(new Error("google.script.run is unavailable"));
          return;
        }
        const withHandlers = runner.withSuccessHandler(resolve).withFailureHandler(reject);
        const fn = withHandlers[name];
        if (typeof fn !== "function") {
          reject(new Error("unknown entry point"));
          return;
        }
        fn(request);
      });
    },
  };
}

/**
 * §6.3 Calls are queued rather than rejected when one is already running. A
 * dropped call would leave the sidebar showing state it never refreshed; a
 * queued one arrives late but arrives. Scan slices are the reason this matters:
 * two concurrent slices would advance the same batch twice.
 */
export function createRpcClient(runner: ScriptRunner): RpcClient {
  const queue: Array<() => void> = [];
  let running = false;

  /** Starts the next job unless one is already running. */
  function pump(): void {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    job();
  }

  function settle(): void {
    running = false;
    pump();
  }

  return {
    call<T>(name: string, request: unknown = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          invoke<T>(runner, name, request).then(
            (value) => {
              settle();
              resolve(value);
            },
            (error: unknown) => {
              // A failure ends this call, not the queue: the sidebar keeps
              // working after one RPC reports a lock timeout.
              settle();
              reject(error);
            },
          );
        });
        pump();
      });
    },
    get busy(): boolean {
      return running || queue.length > 0;
    },
  };
}

function invoke<T>(runner: ScriptRunner, name: string, request: unknown): Promise<T> {
  return runner.call(name, request).then(
    (raw) => {
      const envelope = asEnvelope<T>(raw);
      if (!envelope) throw INTERNAL;
      if (!envelope.ok) throw envelope.error;
      return envelope.data;
    },
    () => {
      // The transport's own error text can quote anything the server logged, so
      // it is discarded rather than surfaced.
      throw INTERNAL;
    },
  );
}
