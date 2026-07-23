import { describe, expect, it } from "vitest";
import { getHistoryPage, type HistoryEvent } from "@/server/history";
import { auditRepository, type DeletedRowSnapshot } from "@/server/auditRepository";
import { saveClusterDecision } from "@/server/review/decisions";
import { createApplyChallenge } from "@/server/apply/preflight";
import { applyDecisions } from "@/server/apply/applyDecisions";
import type { ClusterDecision } from "@/server/types";
import { harness, type Harness } from "../support/participantFixture";

/** Merge the two Bobs onto the row whose Notes cell is blank. */
function bobDecision(h: Harness): ClusterDecision {
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
  };
}

/** A harness carried all the way through a confirmed apply. */
function applied(): Harness {
  const h = harness();
  const saved = saveClusterDecision(h.g, bobDecision(h), h.cfg);
  const decisions = [saved.decision];
  const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);
  applyDecisions(
    h.g,
    h.batchId,
    decisions,
    { token: challenge.token, summaryHash: challenge.summaryHash, confirmed: true },
    h.cfg,
  );
  return h;
}

function walk(h: Harness, request: Parameters<typeof getHistoryPage>[1]): HistoryEvent[] {
  const seen: HistoryEvent[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = getHistoryPage(h.g, { ...request, cursor }, h.cfg);
    seen.push(...page.events);
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("getHistoryPage", () => {
  it("returns the audit newest first", () => {
    const h = harness();
    const onSheet = auditRepository(h.g).readAll();
    const page = getHistoryPage(h.g, { pageSize: 3 }, h.cfg);

    expect(page.events).toHaveLength(3);
    expect(page.totalCount).toBe(onSheet.length);
    expect(page.filteredCount).toBe(onSheet.length);
    expect(page.events.map((e) => e.eventId)).toEqual(
      onSheet
        .slice(-3)
        .reverse()
        .map((r) => String(r.eventId)),
    );
    // A scan's last word comes first.
    expect(page.events[0]!.eventType).toBe("SCAN_COMPLETED");
  });

  it("walks every event exactly once and then stops", () => {
    const h = applied();
    const total = auditRepository(h.g).readAll().length;
    expect(total).toBeGreaterThan(10);

    const seen = walk(h, { pageSize: 4 });
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((e) => e.eventId)).size).toBe(total);
    expect(getHistoryPage(h.g, { pageSize: 4 }, h.cfg).nextCursor).not.toBeNull();
  });

  it("restarts at the newest event when the cursor no longer resolves", () => {
    const h = harness();
    const newest = getHistoryPage(h.g, { pageSize: 2 }, h.cfg);
    const stale = getHistoryPage(h.g, { pageSize: 2, cursor: "evt_gone" }, h.cfg);

    expect(stale.events).toEqual(newest.events);
  });

  it("filters to one cluster, and to one participant however it was named", () => {
    const h = applied();
    const retained = h.idByRow.get(6)!;
    const deleted = h.idByRow.get(5)!;

    const byCluster = walk(h, { clusterId: h.bobClusterId });
    expect(byCluster.length).toBeGreaterThan(0);
    expect(byCluster.every((e) => e.clusterId === h.bobClusterId)).toBe(true);
    expect(byCluster.map((e) => e.eventType)).toContain("CLUSTER_REVIEWED");
    expect(byCluster.map((e) => e.eventType)).toContain("CLUSTER_APPLIED");

    // The retained row is named as the merge target; the deleted one only ever
    // appears in relatedIds. Both must be findable by the id the reviewer sees.
    const byRetained = walk(h, { dedupId: retained });
    const byDeleted = walk(h, { dedupId: deleted });
    expect(byRetained.map((e) => e.eventType)).toContain("ROW_DELETED");
    expect(byDeleted.map((e) => e.eventType)).toContain("ROW_DELETED");
    expect(byDeleted.every((e) => e.targetDedupId === deleted || e.relatedIds.includes(deleted)))
      .toBe(true);
  });

  it("filters by event type and by actor, and combines filters", () => {
    const h = applied();
    const all = auditRepository(h.g).readAll().length;

    const scans = walk(h, { eventTypes: ["SCAN_STARTED", "SCAN_COMPLETED"] });
    expect(scans.map((e) => e.eventType).sort()).toEqual(["SCAN_COMPLETED", "SCAN_STARTED"]);

    // Everything here was done by the one signed-in account, so filtering to it
    // returns the whole trail and filtering to anyone else returns none of it.
    expect(walk(h, { actorId: "r@x.com" })).toHaveLength(all);
    expect(walk(h, { actorId: "someone.else@x.com" })).toHaveLength(0);

    const combined = getHistoryPage(
      h.g,
      { batchId: h.batchId, clusterId: h.bobClusterId, eventTypes: ["CLUSTER_REVIEWED"] },
      h.cfg,
    );
    expect(combined.events).toHaveLength(1);
    expect(combined.filteredCount).toBe(1);
    expect(combined.totalCount).toBe(all);
    expect(combined.nextCursor).toBeNull();
  });

  it("carries what a change was without shipping the deleted row", () => {
    const h = applied();
    const events = walk(h, { eventTypes: ["ROW_DELETED"] });
    expect(events).toHaveLength(1);
    const deletion = events[0]!;

    // The snapshot stays on the audit sheet, where a recovery can find it; the
    // page the sidebar renders does not carry a whole participant row.
    expect(deletion).not.toHaveProperty("rowSnapshot");
    const onSheet = auditRepository(h.g)
      .readAll()
      .find((r) => String(r.eventId) === deletion.eventId)!;
    const snapshot = onSheet.rowSnapshot as unknown as DeletedRowSnapshot;
    expect(snapshot.dedupId).toBe(h.idByRow.get(5));
    expect(snapshot.values).toContain("solo");

    expect(deletion.applyBatchId).not.toBe("");
    expect(deletion.result).toBe("SUCCESS");
    expect(deletion.actorId).toBe("r@x.com");
  });

  it("returns only values that survive the trip to the browser", () => {
    const h = applied();
    for (const event of walk(h, {})) {
      // §6.2 nothing but primitives and arrays of them may cross the boundary.
      const round = JSON.parse(JSON.stringify(event)) as HistoryEvent;
      expect(round).toEqual(event);
      for (const [key, value] of Object.entries(event)) {
        const ok =
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          (Array.isArray(value) && value.every((v) => typeof v === "string"));
        expect(ok, `${key} is not serializable`).toBe(true);
      }
    }
  });

  it("reports an empty audit and an unmatched filter without failing", () => {
    const h = harness();
    const none = getHistoryPage(h.g, { batchId: "batch_missing" }, h.cfg);

    expect(none.events).toEqual([]);
    expect(none.nextCursor).toBeNull();
    expect(none.filteredCount).toBe(0);
    expect(none.totalCount).toBeGreaterThan(0);
  });

  it("caps the page at the configured size", () => {
    const h = applied();
    h.cfg.execution.queuePageSize = 5;

    expect(getHistoryPage(h.g, { pageSize: 500 }, h.cfg).events).toHaveLength(5);
    expect(getHistoryPage(h.g, { pageSize: 0 }, h.cfg).events).toHaveLength(5);
    expect(getHistoryPage(h.g, {}, h.cfg).events).toHaveLength(5);
    expect(getHistoryPage(h.g, { pageSize: 2 }, h.cfg).events).toHaveLength(2);
  });
});
