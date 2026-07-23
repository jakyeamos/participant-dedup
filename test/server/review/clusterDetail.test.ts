import { describe, expect, it } from "vitest";
import { getClusterDetail } from "@/server/review/clusterDetail";
import { saveClusterDecision } from "@/server/review/decisions";
import { isDedupError } from "@/server/errors";
import { harness, HEADER, type Harness } from "../../support/participantFixture";

function bobKeepAll(h: Harness): void {
  saveClusterDecision(
    h.g,
    {
      batchId: h.batchId,
      clusterId: h.bobClusterId,
      expectedRevision: 1,
      mode: "KEEP_ALL",
      retainedIds: [],
      deleteAssignments: {},
      fieldChoices: {},
      notes: "twins",
    },
    h.cfg,
  );
}

describe("getClusterDetail", () => {
  it("returns every displayed member with its values aligned to the headers", () => {
    const h = harness();
    const detail = getClusterDetail(h.g, h.batchId, h.annClusterId, h.cfg);

    expect(detail.clusterId).toBe(h.annClusterId);
    expect(detail.status).toBe("UNREVIEWED");
    expect(detail.revision).toBe(1);
    expect(detail.confidence).toBe("HIGH");
    expect(detail.headers.slice(0, HEADER.length)).toEqual(HEADER);

    expect(detail.records).toHaveLength(3);
    expect(detail.records.map((r) => r.sourceRow)).toEqual([2, 3, 4]);
    expect(detail.records.map((r) => r.dedupId)).toEqual([
      h.idByRow.get(2),
      h.idByRow.get(3),
      h.idByRow.get(4),
    ]);
    expect(detail.records.every((r) => r.label === "Ann Lee")).toBe(true);
    expect(detail.records.every((r) => r.role === "CORE")).toBe(true);
    for (const record of detail.records) {
      expect(record.values).toHaveLength(detail.headers.length);
      expect(record.values[0]).toBe("Ann");
    }
  });

  it("names only the headers whose values disagree, and never the id column", () => {
    const h = harness();
    const detail = getClusterDetail(h.g, h.batchId, h.annClusterId, h.cfg);

    // The three Anns are identical apart from Notes ("", "alpha", "beta").
    expect(detail.differingHeaders).toEqual(["Notes"]);
    expect(detail.differingHeaders).not.toContain(h.schema.headers[h.schema.dedupIdColumnIndex]);
  });

  it("carries no decision or plan until one is saved", () => {
    const h = harness();
    const before = getClusterDetail(h.g, h.batchId, h.bobClusterId, h.cfg);

    // §21.6 opening a cluster cannot make it ready to apply.
    expect(before.decision).toBeNull();
    expect(before.plan).toBeNull();
    expect(before.notes).toBe("");
    expect(before.reviewerId).toBe("");

    bobKeepAll(h);
    const after = getClusterDetail(h.g, h.batchId, h.bobClusterId, h.cfg);
    expect(after.status).toBe("KEEP_ALL");
    expect(after.revision).toBe(2);
    expect(after.decision?.mode).toBe("KEEP_ALL");
    expect(after.notes).toBe("twins");
    expect(after.reviewerId).toBe("r@x.com");
    // KEEP_ALL deletes nothing, so its plan is empty rather than absent.
    expect(after.plan?.deletions).toEqual([]);
  });

  it("recomputes the merge plan a saved decision implies", () => {
    const h = harness();
    const keep = h.idByRow.get(6)!;
    const drop = h.idByRow.get(5)!;
    saveClusterDecision(
      h.g,
      {
        batchId: h.batchId,
        clusterId: h.bobClusterId,
        expectedRevision: 1,
        mode: "SELECT_RECORDS",
        retainedIds: [keep],
        deleteAssignments: { [drop]: keep },
        fieldChoices: {},
        notes: "",
      },
      h.cfg,
    );

    const detail = getClusterDetail(h.g, h.batchId, h.bobClusterId, h.cfg);
    expect(detail.status).toBe("READY_TO_APPLY");
    expect(detail.plan?.ok).toBe(true);
    expect(detail.plan?.deletions).toEqual([{ deletedId: drop, retainedId: keep }]);
    expect(detail.plan?.fills.map((f) => f.header)).toContain("Notes");
  });

  it("rejects an unknown batch or cluster", () => {
    const h = harness();
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        expect(isDedupError(e)).toBe(true);
        return (e as { code: string }).code;
      }
      throw new Error("expected a throw");
    };

    expect(codeOf(() => getClusterDetail(h.g, "batch_missing", h.annClusterId, h.cfg))).toBe(
      "BATCH_NOT_FOUND",
    );
    expect(codeOf(() => getClusterDetail(h.g, h.batchId, "cl_missing", h.cfg))).toBe(
      "CLUSTER_NOT_FOUND",
    );
  });

  it("returns only values that survive the trip to the browser", () => {
    const h = harness();
    bobKeepAll(h);
    const detail = getClusterDetail(h.g, h.batchId, h.bobClusterId, h.cfg);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });
});
