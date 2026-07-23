import { describe, expect, it } from "vitest";
import { saveClusterDecision } from "@/server/review/decisions";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { auditRepository } from "@/server/auditRepository";
import { batchesRepository } from "@/server/batchesRepository";
import { isSuppressed, type SuppressionMember } from "@/server/review/suppression";
import { decisionHash } from "@/server/hashing";
import { isDedupError } from "@/server/errors";
import type { ClusterDecision } from "@/server/types";
import { harness, type Harness } from "../../support/participantFixture";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return isDedupError(err) ? err.code : `unexpected: ${String(err)}`;
  }
  return "no-throw";
}

/** The Bobs merge cleanly: one has a note, the other is blank. */
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

/** The Anns collide: two different notes want the same blank cell. */
function annDecision(h: Harness, patch: Partial<ClusterDecision> = {}): ClusterDecision {
  const keep = h.idByRow.get(2)!;
  return {
    batchId: h.batchId,
    clusterId: h.annClusterId,
    expectedRevision: 1,
    mode: "SELECT_RECORDS",
    retainedIds: [keep],
    deleteAssignments: { [h.idByRow.get(3)!]: keep, [h.idByRow.get(4)!]: keep },
    fieldChoices: {},
    notes: "",
    ...patch,
  };
}

function suppressionMembersOf(h: Harness, clusterId: string): SuppressionMember[] {
  const hashById = new Map(
    recordsRepository(h.g)
      .readByBatch(h.batchId, h.schema.headers)
      .map((r) => [r.dedupId, r.relevantHash]),
  );
  const row = clustersRepository(h.g).get(clusterId)!;
  return (row.memberIds as unknown as string[]).map((id) => ({
    dedupId: id,
    relevantHash: hashById.get(id)!,
  }));
}

function auditTypes(h: Harness): string[] {
  return auditRepository(h.g)
    .readAll()
    .map((r) => String(r.eventType));
}

/** Actor types of the review events only — the scan's own events have no reviewer. */
function reviewActorTypes(h: Harness): string[] {
  return auditRepository(h.g)
    .readAll()
    .filter((r) => String(r.clusterId) !== "")
    .map((r) => String(r.actorType));
}

describe("saveClusterDecision", () => {
  it("marks a complete merge ready to apply and returns its plan", () => {
    const h = harness();
    const saved = saveClusterDecision(h.g, bobDecision(h), h.cfg);

    expect(saved.status).toBe("READY_TO_APPLY");
    expect(saved.plan?.ok).toBe(true);
    expect(saved.plan?.deletions).toHaveLength(1);
    expect(saved.plan?.fills).toEqual([
      expect.objectContaining({ header: "Notes", value: "solo" }),
    ]);
  });

  it("stores the decision at the revision the row now holds", () => {
    const h = harness();
    const saved = saveClusterDecision(h.g, bobDecision(h), h.cfg);
    const row = clustersRepository(h.g).get(h.bobClusterId)!;

    // Apply preflight matches a stored decision against the row's revision and
    // its stored hash. Both must survive the round trip or no apply can start.
    expect(Number(row.revision)).toBe(2);
    expect(saved.revision).toBe(2);
    expect(saved.decision.expectedRevision).toBe(2);
    expect(String(row.decisionHash)).toBe(decisionHash(saved.decision));
    expect(String(row.reviewerId)).toBe("r@x.com");
    expect(String(row.reviewedAt)).not.toBe("");
  });

  it("rejects a second save that still claims the old revision", () => {
    const h = harness();
    saveClusterDecision(h.g, bobDecision(h), h.cfg);

    expect(codeOf(() => saveClusterDecision(h.g, bobDecision(h), h.cfg))).toBe(
      "REVISION_CONFLICT",
    );
  });

  it("leaves a conflicting merge unresolved and reports what is missing", () => {
    const h = harness();
    const saved = saveClusterDecision(h.g, annDecision(h), h.cfg);

    expect(saved.status).toBe("UNRESOLVED");
    expect(saved.plan?.ok).toBe(false);
    expect(saved.plan?.issues).toContain("UNRESOLVED_CONFLICT");
    expect(saved.plan?.conflicts[0]?.options.sort()).toEqual(["alpha", "beta"]);
  });

  it("becomes ready once the reviewer picks a value for the conflict", () => {
    const h = harness();
    const keep = h.idByRow.get(2)!;
    const decision = annDecision(h, {
      fieldChoices: { [keep]: { Notes: { mode: "SOURCE", sourceId: h.idByRow.get(3)! } } },
    });
    const saved = saveClusterDecision(h.g, decision, h.cfg);

    expect(saved.status).toBe("READY_TO_APPLY");
    expect(saved.plan?.fills).toEqual([
      expect.objectContaining({ header: "Notes", value: "alpha" }),
    ]);
  });

  it("suppresses a cluster the reviewer keeps whole", () => {
    const h = harness();
    const members = suppressionMembersOf(h, h.bobClusterId);
    const saved = saveClusterDecision(
      h.g,
      bobDecision(h, { mode: "KEEP_ALL", retainedIds: [], deleteAssignments: {} }),
      h.cfg,
    );

    expect(saved.status).toBe("KEEP_ALL");
    expect(saved.plan?.deletions).toEqual([]);
    const configHash = String(batchesRepository(h.g).get(h.batchId)!.configHash);
    expect(isSuppressed(h.g, members, configHash)).toBe(true);
    expect(auditTypes(h)).toContain("KEEP_ALL_SAVED");
  });

  it("drops the suppression when a kept cluster is decided differently", () => {
    const h = harness();
    const members = suppressionMembersOf(h, h.bobClusterId);
    saveClusterDecision(
      h.g,
      bobDecision(h, { mode: "KEEP_ALL", retainedIds: [], deleteAssignments: {} }),
      h.cfg,
    );
    saveClusterDecision(h.g, bobDecision(h, { expectedRevision: 2 }), h.cfg);

    const configHash = String(batchesRepository(h.g).get(h.batchId)!.configHash);
    expect(isSuppressed(h.g, members, configHash)).toBe(false);
    expect(auditTypes(h)).toContain("DECISION_CHANGED");
  });

  it("marks the cluster stale when a member row changed since the scan", () => {
    const h = harness();
    h.g.writeRange("Participants", "H6", [["edited"]]);

    expect(codeOf(() => saveClusterDecision(h.g, bobDecision(h), h.cfg))).toBe("STALE_ROW");
    const row = clustersRepository(h.g).get(h.bobClusterId)!;
    expect(String(row.status)).toBe("STALE");
    expect(String(row.staleReason)).not.toBe("");
    // Nothing was recorded: a rejected save must not look like a review.
    expect(Number(row.revision)).toBe(1);
    expect(String(row.reviewedAt)).toBe("");
  });

  it("refuses to save against a cluster from another batch", () => {
    const h = harness();
    expect(codeOf(() => saveClusterDecision(h.g, bobDecision(h, { batchId: "b_other" }), h.cfg)))
      .toBe("BATCH_NOT_FOUND");
    expect(codeOf(() => saveClusterDecision(h.g, bobDecision(h, { clusterId: "nope" }), h.cfg)))
      .toBe("CLUSTER_NOT_FOUND");
  });

  it("requires an identity before it will record a review", () => {
    const h = harness(null);
    expect(codeOf(() => saveClusterDecision(h.g, bobDecision(h), h.cfg))).toBe(
      "MISSING_REVIEWER_IDENTITY",
    );

    const named = saveClusterDecision(
      h.g,
      bobDecision(h, { fallbackReviewerName: "Dana <script>" }),
      h.cfg,
    );
    expect(named.reviewerId).toBe("Dana script");
  });

  it("records whether the actor was verified or self-declared (§8.7)", () => {
    const signedIn = harness();
    saveClusterDecision(signedIn.g, bobDecision(signedIn), signedIn.cfg);
    expect(reviewActorTypes(signedIn)).toEqual(["EMAIL"]);

    const anonymous = harness(null);
    saveClusterDecision(
      anonymous.g,
      bobDecision(anonymous, { fallbackReviewerName: "Dana" }),
      anonymous.cfg,
    );
    expect(reviewActorTypes(anonymous)).toEqual(["FALLBACK_NAME"]);
  });

  it("records the first review and later edits as different events", () => {
    const h = harness();
    saveClusterDecision(h.g, bobDecision(h), h.cfg);
    expect(auditTypes(h).filter((t) => t === "CLUSTER_REVIEWED")).toHaveLength(1);

    saveClusterDecision(h.g, bobDecision(h, { expectedRevision: 2 }), h.cfg);
    expect(auditTypes(h).filter((t) => t === "CLUSTER_REVIEWED")).toHaveLength(1);
    expect(auditTypes(h).filter((t) => t === "DECISION_CHANGED")).toHaveLength(1);
  });
});
