import { describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { createHandlers, type Handlers } from "@/server/rpc/handlers";
import { runRpc, type RpcResult } from "@/server/rpc/envelope";
import { APPLY_CONFIRMATION_TEXT } from "@/server/apply/preflight";
import { DEDUP_ID_HEADER } from "@/shared/constants";
import { colLetters } from "@/server/systemSheets";
import { HEADER, PEOPLE, ROWS } from "../support/participantFixture";

function gatewayWithSheet(email: string | null = "r@x.com"): FakeSheetsGateway {
  const g = new FakeSheetsGateway({
    spreadsheetId: "SS1",
    activeUserEmail: email,
    activeSheetName: PEOPLE,
  });
  g.loadSheet(PEOPLE, { values: [HEADER, ...ROWS.map((r) => [...r])] });
  return g;
}

function data<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function failure<T>(result: RpcResult<T>): { code: string; message: string; retryable: boolean } {
  if (result.ok) throw new Error("expected a failed envelope");
  return result.error;
}

interface Scanned {
  g: FakeSheetsGateway;
  h: Handlers;
  batchId: string;
}

/** Drives a complete scan through the rpc surface, exactly as the sidebar does. */
function scanned(email: string | null = "r@x.com"): Scanned {
  const g = gatewayWithSheet(email);
  const h = createHandlers(g);
  const started = data(h.rpcStartScan({}));
  let state = started;
  let guard = 0;
  while (state.status !== "READY" && guard++ < 100) {
    state = data(h.rpcAdvanceScan({}));
  }
  expect(state.status).toBe("READY");
  return { g, h, batchId: started.batchId };
}

/** The two-member Bob cluster, whose only conflict resolves on its own. */
function bobCluster(s: Scanned): { clusterId: string; keep: string; drop: string } {
  const page = data(
    s.h.rpcGetQueuePage({ batchId: s.batchId, confidence: ["HIGH", "MEDIUM", "LOW"] }),
  );
  const item = page.items.find((i) => i.label === "Bob Kim");
  if (!item) throw new Error("no Bob cluster");
  const detail = data(s.h.rpcGetCluster({ batchId: s.batchId, clusterId: item.clusterId }));
  const byRow = new Map(detail.records.map((r) => [r.sourceRow, r.dedupId]));
  return { clusterId: item.clusterId, keep: byRow.get(6)!, drop: byRow.get(5)! };
}

describe("rpc envelope", () => {
  it("wraps a success with the request id the client sent", () => {
    const h = createHandlers(gatewayWithSheet());
    const result = h.rpcBootstrap({ requestId: "req-7" });

    expect(result.ok).toBe(true);
    expect(result.requestId).toBe("req-7");
    expect(data(result).identity.email).toBe("r@x.com");
  });

  it("mints a request id when the client omits one", () => {
    const h = createHandlers(gatewayWithSheet());
    const first = h.rpcBootstrap({});
    const second = h.rpcBootstrap({});

    expect(first.requestId).not.toBe("");
    expect(second.requestId).not.toBe(first.requestId);
  });

  it("returns a failed envelope with a safe code instead of throwing", () => {
    const h = createHandlers(gatewayWithSheet());
    const result = h.rpcGetBatchSummary({ batchId: "nope" });

    const error = failure(result);
    expect(error.code).toBe("BATCH_NOT_FOUND");
    expect(error.message).toBe("The requested scan batch could not be found.");
    expect(error.retryable).toBe(false);
  });

  it("never leaks a stack trace or an internal message", () => {
    // An unexpected failure from the sheet layer, not a DedupError.
    const result = runRpc({ requestId: "req-9" }, () => {
      throw new Error("Service Spreadsheets failed at row 42 of _Dedup_Batches");
    });

    const error = failure(result);
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("An unexpected error occurred.");
    expect(error.retryable).toBe(true);

    const json = JSON.stringify(result);
    expect(json).not.toContain("at ");
    expect(json).not.toContain("_Dedup_Batches");
  });

  it("returns only values that survive the trip to the browser", () => {
    const s = scanned();
    const payloads: unknown[] = [
      s.h.rpcBootstrap({}),
      s.h.rpcGetQueuePage({ batchId: s.batchId }),
      s.h.rpcGetBatchSummary({ batchId: s.batchId }),
      s.h.rpcGetAuditPage({ batchId: s.batchId }),
    ];
    for (const payload of payloads) {
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    }
  });
});

describe("rpcBootstrap", () => {
  it("reports the sheet, the active batch and the default filters", () => {
    const s = scanned();
    const boot = data(s.h.rpcBootstrap({}));

    expect(boot.activeSheetName).toBe(PEOPLE);
    expect(boot.activeBatch?.batchId).toBe(s.batchId);
    expect(boot.sourceSheetName).toBe(PEOPLE);
    expect(boot.counts?.total).toBeGreaterThan(0);
    expect(boot.queue?.counts.total).toBe(boot.counts?.total);
    expect(boot.queue?.items.length).toBeGreaterThan(0);
    // §21.4 High and Medium checked, Low unchecked, Unreviewed checked.
    expect(boot.defaultFilters.confidence).toEqual(["HIGH", "MEDIUM"]);
    expect(boot.defaultFilters.statuses).toEqual(["UNREVIEWED", "IN_PROGRESS"]);
    expect(boot.applyConfirmationText).toBe(APPLY_CONFIRMATION_TEXT);
  });

  it("asks for a reviewer name instead of failing when the email is unavailable", () => {
    const h = createHandlers(gatewayWithSheet(null));

    const anonymous = data(h.rpcBootstrap({}));
    expect(anonymous.identity.needsFallbackName).toBe(true);
    expect(anonymous.identity.email).toBeNull();
    expect(anonymous.identity.display).toBe("");
    expect(anonymous.activeBatch).toBeNull();

    const named = data(h.rpcBootstrap({ fallbackName: " Dana <Reviewer> " }));
    expect(named.identity.needsFallbackName).toBe(false);
    expect(named.identity.display).toBe("Dana Reviewer");
  });
});

describe("rpc review flow", () => {
  it("carries a decision from the queue through to a confirmed apply", () => {
    const s = scanned();
    const bob = bobCluster(s);

    const saved = data(
      s.h.rpcSaveClusterDecision({
        decision: {
          batchId: s.batchId,
          clusterId: bob.clusterId,
          expectedRevision: 1,
          mode: "SELECT_RECORDS",
          retainedIds: [bob.keep],
          deleteAssignments: { [bob.drop]: bob.keep },
          fieldChoices: {},
          notes: "same person",
        },
      }),
    );
    expect(saved.status).toBe("READY_TO_APPLY");

    const summary = data(s.h.rpcGetBatchSummary({ batchId: s.batchId }));
    expect(summary.readyToApplyClusters).toBe(1);
    expect(summary.rowsToDelete).toBe(1);

    const challenge = data(s.h.rpcCreateApplyChallenge({ batchId: s.batchId }));
    expect(challenge.summary.deletionRowCount).toBe(1);
    expect(challenge.token).not.toBe("");

    const unconfirmed = s.h.rpcApplyBatch({
      batchId: s.batchId,
      token: challenge.token,
      summaryHash: challenge.summaryHash,
      confirmed: false,
    });
    expect(failure(unconfirmed).code).toBe("NOT_CONFIRMED");
    expect(s.g.getGridSize(PEOPLE).rowCount).toBe(ROWS.length + 1);

    const applied = data(
      s.h.rpcApplyBatch({
        batchId: s.batchId,
        token: challenge.token,
        summaryHash: challenge.summaryHash,
        confirmed: true,
      }),
    );
    expect(applied.deletedRows).toBe(1);
    expect(applied.filledFields).toBe(1);

    const history = data(s.h.rpcGetAuditPage({ applyBatchId: applied.applyBatchId }));
    expect(history.events.length).toBeGreaterThan(0);
  });

  it("refuses an apply the reviewer never confirmed in this session", () => {
    const s = scanned();
    const bob = bobCluster(s);
    data(
      s.h.rpcSaveClusterDecision({
        decision: {
          batchId: s.batchId,
          clusterId: bob.clusterId,
          expectedRevision: 1,
          mode: "KEEP_ALL",
          retainedIds: [],
          deleteAssignments: {},
          fieldChoices: {},
          notes: "",
        },
      }),
    );

    const forged = s.h.rpcApplyBatch({
      batchId: s.batchId,
      token: "made-up",
      summaryHash: "made-up",
      confirmed: true,
    });
    expect(failure(forged).code).toBe("NOT_CONFIRMED");
  });
});

describe("rpcFocusSourceRow", () => {
  it("puts the cursor on the participant's current row", () => {
    const s = scanned();
    const bob = bobCluster(s);

    const focus = data(s.h.rpcFocusSourceRow({ batchId: s.batchId, dedupId: bob.keep }));
    expect(focus).toEqual({ sheetName: PEOPLE, row: 6 });
    expect(s.g.activatedCell()).toEqual({ sheetName: PEOPLE, row: 6, column: 1 });
  });

  it("reports a stale row when the participant is no longer on the sheet", () => {
    const s = scanned();
    const result = s.h.rpcFocusSourceRow({ batchId: s.batchId, dedupId: "missing-id" });
    expect(failure(result).code).toBe("STALE_ROW");
  });
});

describe("rpcCancelCurrentBatch", () => {
  it("ends the active batch and leaves the sidebar with none", () => {
    const s = scanned();
    const cancelled = data(s.h.rpcCancelCurrentBatch({}));
    expect(cancelled.status).toBe("CANCELLED");
    expect(data(s.h.rpcBootstrap({})).activeBatch).toBeNull();
  });
});

describe("rpcRepairDuplicateIds", () => {
  it("reports how many ids it had to replace", () => {
    const s = scanned();
    const before = data(s.h.rpcRepairDuplicateIds({}));
    expect(before.repaired).toBe(0);

    // Two rows now claim the same participant id (§9.4).
    const detail = data(
      s.h.rpcGetCluster({ batchId: s.batchId, clusterId: bobCluster(s).clusterId }),
    );
    const idCol = colLetters(detail.headers.indexOf(DEDUP_ID_HEADER));
    s.g.writeRange(PEOPLE, `${idCol}3`, s.g.readRange(PEOPLE, `${idCol}2`));

    const after = data(s.h.rpcRepairDuplicateIds({}));
    expect(after.repaired).toBe(1);
  });
});
