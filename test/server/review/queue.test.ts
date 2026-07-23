import { describe, expect, it } from "vitest";
import { getQueuePage } from "@/server/review/queue";
import { clustersRepository } from "@/server/clustersRepository";
import { isDedupError } from "@/server/errors";
import type { Confidence } from "@/shared/constants";
import { harness, type Harness } from "../../support/participantFixture";

/**
 * Appends a cluster row directly so ordering and paging can be exercised over
 * confidences the nine-row fixture does not itself produce. Members are real
 * ids from the scan, so labels and source rows resolve normally.
 */
function seedCluster(
  h: Harness,
  clusterId: string,
  confidence: Confidence,
  maxScore: number,
  memberRows: number[],
  patch: Record<string, unknown> = {},
): void {
  clustersRepository(h.g).append([
    {
      batchId: h.batchId,
      clusterId,
      clusterType: "CORE",
      memberIds: memberRows.map((r) => h.idByRow.get(r)!),
      coreMemberIds: memberRows.map((r) => h.idByRow.get(r)!),
      suggestedMemberIds: [],
      edgeKeys: [],
      highestConfidence: confidence,
      maxScore,
      warnings: [],
      status: "UNREVIEWED",
      revision: 1,
      decision: null,
      reviewerId: "",
      reviewedAt: "",
      notes: "",
      decisionHash: "",
      staleReason: "",
      applyBatchId: "",
      appliedAt: "",
      ...patch,
    } as never,
  ]);
}

function idsOf(h: Harness, req: Parameters<typeof getQueuePage>[1] = { batchId: "" }): string[] {
  return getQueuePage(h.g, { ...req, batchId: req.batchId || h.batchId }, h.cfg).items.map(
    (i) => i.clusterId,
  );
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return isDedupError(err) ? err.code : `unexpected: ${String(err)}`;
  }
  return "no-throw";
}

describe("getQueuePage", () => {
  it("returns the clusters the scan produced", () => {
    const h = harness();
    const page = getQueuePage(h.g, { batchId: h.batchId }, h.cfg);

    expect(page.items.map((i) => i.clusterId).sort()).toEqual(
      [h.annClusterId, h.bobClusterId].sort(),
    );
    expect(page.nextCursor).toBeNull();
  });

  it("describes each cluster well enough to render a queue row", () => {
    const h = harness();
    const item = getQueuePage(h.g, { batchId: h.batchId }, h.cfg).items.find(
      (i) => i.clusterId === h.annClusterId,
    )!;

    expect(item.memberCount).toBe(3);
    expect(item.status).toBe("UNREVIEWED");
    // The label comes from the earliest member, so the queue reads in sheet order.
    expect(item.label).toBe("Ann Lee");
    expect(item.firstSourceRow).toBe(2);
  });

  it("orders by confidence, then score, then earliest row", () => {
    const h = harness();
    seedCluster(h, "c_low", "LOW", 99, [7]);
    seedCluster(h, "c_med_hi", "MEDIUM", 80, [8]);
    seedCluster(h, "c_med_lo", "MEDIUM", 40, [9]);
    seedCluster(h, "c_high_late", "HIGH", 100, [10]);
    seedCluster(h, "c_high_early", "HIGH", 100, [7]);

    const ids = idsOf(h);
    const seeded = ids.filter((id) => id.startsWith("c_"));
    expect(seeded).toEqual(["c_high_early", "c_high_late", "c_med_hi", "c_med_lo", "c_low"]);
  });

  it("filters by confidence and by status", () => {
    const h = harness();
    seedCluster(h, "c_low", "LOW", 50, [7]);
    seedCluster(h, "c_done", "HIGH", 50, [8], { status: "KEEP_ALL" });

    expect(idsOf(h, { batchId: h.batchId, confidence: ["LOW"] })).toEqual(["c_low"]);
    expect(idsOf(h, { batchId: h.batchId, statuses: ["KEEP_ALL"] })).toEqual(["c_done"]);
    expect(idsOf(h, { batchId: h.batchId, confidence: ["LOW"], statuses: ["KEEP_ALL"] })).toEqual(
      [],
    );
  });

  it("walks the whole queue one page at a time without repeating a cluster", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) seedCluster(h, `c_${i}`, "HIGH", 100 - i, [7]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: ReturnType<typeof getQueuePage> = getQueuePage(
        h.g,
        { batchId: h.batchId, cursor, pageSize: 2 },
        h.cfg,
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.clusterId));
      cursor = page.nextCursor;
    } while (cursor !== null && guard++ < 20);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("counts the whole batch even while a filter is narrowing the page", () => {
    const h = harness();
    seedCluster(h, "c_low", "LOW", 50, [7]);
    seedCluster(h, "c_done", "HIGH", 50, [8], { status: "READY_TO_APPLY" });

    const page = getQueuePage(h.g, { batchId: h.batchId, confidence: ["LOW"] }, h.cfg);

    expect(page.items).toHaveLength(1);
    expect(page.filteredCount).toBe(1);
    expect(page.counts.total).toBe(4);
    expect(page.counts.byConfidence.LOW).toBe(1);
    expect(page.counts.byStatus.UNREVIEWED).toBe(3);
    expect(page.counts.readyToApply).toBe(1);
  });

  it("ignores clusters belonging to another batch", () => {
    const h = harness();
    seedCluster(h, "c_other", "HIGH", 100, [7], { batchId: "b_other" });

    expect(idsOf(h)).not.toContain("c_other");
  });

  it("refuses to page an unknown batch", () => {
    const h = harness();
    expect(codeOf(() => getQueuePage(h.g, { batchId: "b_missing" }, h.cfg))).toBe(
      "BATCH_NOT_FOUND",
    );
  });

  it("keeps the page size within the configured bound", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) seedCluster(h, `c_${i}`, "HIGH", 100, [7]);
    h.cfg.execution.queuePageSize = 3;

    expect(getQueuePage(h.g, { batchId: h.batchId }, h.cfg).items).toHaveLength(3);
    expect(getQueuePage(h.g, { batchId: h.batchId, pageSize: 999 }, h.cfg).items).toHaveLength(3);
    expect(getQueuePage(h.g, { batchId: h.batchId, pageSize: 0 }, h.cfg).items).toHaveLength(3);
  });

  it("starts from the beginning when the cursor no longer exists", () => {
    const h = harness();
    const page = getQueuePage(h.g, { batchId: h.batchId, cursor: "c_deleted" }, h.cfg);

    expect(page.items).toHaveLength(2);
  });
});
