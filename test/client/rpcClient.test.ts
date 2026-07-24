import { describe, expect, it } from "vitest";
import { createRpcClient, isRpcError, type ScriptRunner } from "@/client/rpc";

interface Deferred {
  name: string;
  request: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** A stand-in for `google.script.run` that never settles on its own. */
function deferredRunner(): { runner: ScriptRunner; calls: Deferred[] } {
  const calls: Deferred[] = [];
  const runner: ScriptRunner = {
    call(name, request) {
      return new Promise((resolve, reject) => {
        calls.push({ name, request, resolve, reject });
      });
    },
  };
  return { runner, calls };
}

describe("§6.3 one call at a time", () => {
  it("does not start a second call while one is in flight", async () => {
    const { runner, calls } = deferredRunner();
    const client = createRpcClient(runner);

    const first = client.call("rpcBootstrap");
    const second = client.call("rpcGetQueuePage", { batchId: "b1" });

    expect(calls.length).toBe(1);
    expect(client.busy).toBe(true);

    calls[0]!.resolve({ ok: true, requestId: "r1", data: { identity: null } });
    await first;

    expect(calls.length).toBe(2);
    expect(calls[1]!.name).toBe("rpcGetQueuePage");

    calls[1]!.resolve({ ok: true, requestId: "r2", data: { items: [] } });
    await expect(second).resolves.toEqual({ items: [] });
    expect(client.busy).toBe(false);
  });

  it("keeps draining the queue after a failed call", async () => {
    const { runner, calls } = deferredRunner();
    const client = createRpcClient(runner);

    const first = client.call("rpcStartScan", {});
    const second = client.call("rpcAdvanceScan", {});

    calls[0]!.resolve({
      ok: false,
      requestId: "r1",
      error: { code: "LOCK_TIMEOUT", message: "busy", retryable: true },
    });
    await expect(first).rejects.toMatchObject({ code: "LOCK_TIMEOUT", retryable: true });

    expect(calls.length).toBe(2);
    calls[1]!.resolve({ ok: true, requestId: "r2", data: null });
    await expect(second).resolves.toBeNull();
  });
});

describe("envelope handling", () => {
  it("unwraps a success envelope to its data", async () => {
    const { runner, calls } = deferredRunner();
    const client = createRpcClient(runner);

    const call = client.call<{ repaired: number }>("rpcRepairDuplicateIds");
    calls[0]!.resolve({ ok: true, requestId: "r1", data: { repaired: 3 } });

    await expect(call).resolves.toEqual({ repaired: 3 });
  });

  it("rejects with the envelope's error, not an exception object", async () => {
    const { runner, calls } = deferredRunner();
    const client = createRpcClient(runner);

    const call = client.call("rpcApplyBatch", { batchId: "b1" });
    calls[0]!.resolve({
      ok: false,
      requestId: "r1",
      error: { code: "STALE_SUMMARY", message: "The summary changed.", retryable: false },
    });

    await expect(call).rejects.toEqual({
      code: "STALE_SUMMARY",
      message: "The summary changed.",
      retryable: false,
    });
  });

  it("turns a transport failure into a retryable internal error", async () => {
    const { runner, calls } = deferredRunner();
    const client = createRpcClient(runner);

    const call = client.call("rpcBootstrap");
    // What `google.script.run`'s failure handler passes back: an Error whose
    // message can quote anything the server logged. It is never displayed.
    calls[0]!.reject(new Error("ScriptError: row 42 of Ada Placeholder"));

    const rejection = await call.catch((error: unknown) => error);
    expect(isRpcError(rejection)).toBe(true);
    expect(rejection).toMatchObject({ code: "INTERNAL", retryable: true });
    expect(JSON.stringify(rejection)).not.toContain("Ada Placeholder");
  });

  it("treats a malformed response as an internal error", async () => {
    const { runner, calls } = deferredRunner();
    const client = createRpcClient(runner);

    const call = client.call("rpcBootstrap");
    calls[0]!.resolve("not an envelope");

    await expect(call).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
