import { describe, expect, it } from "vitest";
import { ENTRY_POINTS, installEntryPoints } from "@/server/globals";

/**
 * §6 verbatim, in spec order. A name added to the bundle's global surface has to
 * be added here first, which is the point: this list is the review gate.
 */
const ALLOWLIST = [
  "onOpen",
  "menuScanActiveSheet",
  "menuOpenReviewSidebar",
  "menuApplyReviewedDecisions",
  "menuViewChangeHistory",
  "menuRefreshCurrentBatch",
  "rpcBootstrap",
  "rpcStartScan",
  "rpcAdvanceScan",
  "rpcGetQueuePage",
  "rpcGetCluster",
  "rpcSaveClusterDecision",
  "rpcGetBatchSummary",
  "rpcCreateApplyChallenge",
  "rpcApplyBatch",
  "rpcGetAuditPage",
  "rpcCancelCurrentBatch",
  "rpcRepairDuplicateIds",
  "rpcFocusSourceRow",
];

describe("global entry points", () => {
  it("exposes exactly the functions §6 allows", () => {
    expect(Object.keys(ENTRY_POINTS).sort()).toEqual([...ALLOWLIST].sort());
  });

  it("covers every menu item §6.1 defines", () => {
    // `Repair Duplicate IDs` binds to the RPC: §6 defines no menu wrapper for it.
    const menuTargets = [
      "menuScanActiveSheet",
      "menuOpenReviewSidebar",
      "menuRefreshCurrentBatch",
      "menuApplyReviewedDecisions",
      "menuViewChangeHistory",
      "rpcRepairDuplicateIds",
    ];
    for (const target of menuTargets) {
      expect(typeof ENTRY_POINTS[target]).toBe("function");
    }
  });

  it("installs the whole allowlist and nothing else", () => {
    const target: Record<string, unknown> = {};
    installEntryPoints(target);

    expect(Object.keys(target).sort()).toEqual([...ALLOWLIST].sort());
    for (const name of ALLOWLIST) {
      expect(typeof target[name]).toBe("function");
    }
  });

  it("builds no gateway until an entry point is called", () => {
    // No Apps Script global exists under vitest, so the fact that this module
    // imported at all proves nothing reached SpreadsheetApp at load time. The
    // gateway is constructed on first use, inside a real execution.
    expect(globalThis).not.toHaveProperty("SpreadsheetApp");
    expect(Object.keys(ENTRY_POINTS).length).toBe(ALLOWLIST.length);
  });
});
