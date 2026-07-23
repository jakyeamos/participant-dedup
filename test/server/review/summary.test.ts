import { describe, expect, it } from "vitest";
import { getBatchSummary } from "@/server/review/summary";
import { saveClusterDecision } from "@/server/review/decisions";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { isDedupError } from "@/server/errors";
import type { ClusterDecision } from "@/server/types";
import { harness, type Harness } from "../../support/participantFixture";

function bobDecision(h: Harness, patch: Partial<ClusterDecision> = {}): ClusterDecision {
  const withNote = h.idByRow.get(5)!;
  const blank = h.idByRow.get(6)!;
  return {
    batchId: h.batchId,
    clusterId: h.bobClusterId,
    expectedRevision: 1,
    mode: "SELECT_RECORDS",
    retainedIds: [blank],
    deleteAssignments: { [withNote]: blank },
    fieldChoices: {},
    notes: "",
    ...patch,
  };
}

/** The Anns need a manual choice: two different notes want one blank cell. */
function annDecision(h: Harness, patch: Partial<ClusterDecision> = {}): ClusterDecision {
  const keep = h.idByRow.get(2)!;
  return {
    batchId: h.batchId,
    clusterId: h.annClusterId,
    expectedRevision: 1,
    mode: "SELECT_RECORDS",
    retainedIds: [keep],
    deleteAssignments: { [h.idByRow.get(3)!]: keep, [h.idByRow.get(4)!]: keep },
    fieldChoices: { [keep]: { Notes: { mode: "SOURCE", sourceId: h.idByRow.get(3)! } } },
    notes: "",
    ...patch,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return isDedupError(err) ? err.code : `unexpected: ${String(err)}`;
  }
  return "no-throw";
}

describe("getBatchSummary", () => {
  it("reports an untouched batch as nothing to apply", () => {
    const h = harness();
    const s = getBatchSummary(h.g, h.batchId, h.cfg);

    expect(s.totalClusters).toBe(2);
    expect(s.readyToApplyClusters).toBe(0);
    expect(s.rowsToDelete).toBe(0);
    expect(s.rowsToRetain).toBe(0);
    expect(s.blankFieldsToFill).toBe(0);
    expect(s.reviewerIds).toEqual([]);
  });

  it("counts the rows a confirmed apply would delete, keep, and fill", () => {
    const h = harness();
    saveClusterDecision(h.g, bobDecision(h), h.cfg);
    saveClusterDecision(h.g, annDecision(h), h.cfg);

    const s = getBatchSummary(h.g, h.batchId, h.cfg);

    expect(s.readyToApplyClusters).toBe(2);
    expect(s.rowsToRetain).toBe(2);
    expect(s.rowsToDelete).toBe(3);
    expect(s.blankFieldsToFill).toBe(2);
    // One of those fills was a conflict the reviewer resolved by hand.
    expect(s.manualConflictChoices).toBe(1);
  });

  it("keeps kept, unresolved, and stale clusters out of the apply counts", () => {
    const h = harness();
    saveClusterDecision(
      h.g,
      bobDecision(h, { mode: "KEEP_ALL", retainedIds: [], deleteAssignments: {} }),
      h.cfg,
    );
    saveClusterDecision(h.g, annDecision(h, { fieldChoices: {} }), h.cfg);

    const s = getBatchSummary(h.g, h.batchId, h.cfg);

    expect(s.keepAllClusters).toBe(1);
    expect(s.unresolvedClusters).toBe(1);
    expect(s.readyToApplyClusters).toBe(0);
    expect(s.rowsToDelete).toBe(0);
  });

  it("counts stale clusters separately", () => {
    const h = harness();
    clustersRepository(h.g).update(h.bobClusterId, { status: "STALE", staleReason: "ROW_EDITED" });

    expect(getBatchSummary(h.g, h.batchId, h.cfg).staleClusters).toBe(1);
  });

  it("names the source sheet and everyone who reviewed in it", () => {
    const h = harness();
    saveClusterDecision(h.g, bobDecision(h), h.cfg);
    saveClusterDecision(h.g, annDecision(h, { fallbackReviewerName: "Dana" }), h.cfg);

    const s = getBatchSummary(h.g, h.batchId, h.cfg);

    expect(s.sourceSheetName).toBe("Participants");
    // The signed-in email wins over any fallback name, so both saves are one reviewer.
    expect(s.reviewerIds).toEqual(["r@x.com"]);
  });

  it("surfaces candidate truncation from the scan", () => {
    const h = harness();
    expect(getBatchSummary(h.g, h.batchId, h.cfg).candidateTruncation).toBe(false);

    batchesRepository(h.g).update(h.batchId, { candidateTruncationCount: 12 });
    const s = getBatchSummary(h.g, h.batchId, h.cfg);

    expect(s.candidateTruncation).toBe(true);
    expect(s.candidateTruncationCount).toBe(12);
  });

  it("refuses to summarize an unknown batch", () => {
    const h = harness();
    expect(codeOf(() => getBatchSummary(h.g, "b_missing", h.cfg))).toBe("BATCH_NOT_FOUND");
  });

  it("stops counting a cluster once it has been applied", () => {
    const h = harness();
    saveClusterDecision(h.g, bobDecision(h), h.cfg);
    clustersRepository(h.g).update(h.bobClusterId, { status: "APPLIED" });

    const s = getBatchSummary(h.g, h.batchId, h.cfg);

    expect(s.readyToApplyClusters).toBe(0);
    expect(s.appliedClusters).toBe(1);
    expect(s.rowsToDelete).toBe(0);
  });
});
