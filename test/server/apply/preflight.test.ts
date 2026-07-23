import { beforeEach, describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets, nowIso } from "@/server/systemSheets";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { auditRepository } from "@/server/auditRepository";
import { stateRepository } from "@/server/stateRepository";
import { advanceScan, startScan } from "@/server/scan/scanStateMachine";
import { decisionHash, makeClusterId } from "@/server/hashing";
import { isDedupError } from "@/server/errors";
import type { ClusterDecision, SourceSchema } from "@/server/types";
import { cloneDefaultConfig, type DedupConfig } from "@/shared/config";
import {
  APPLY_CHALLENGE_STATE_TYPE,
  APPLY_CONFIRMATION_TEXT,
  createApplyChallenge,
  preflight,
  type ApplyChallenge,
} from "@/server/apply/preflight";

const PEOPLE = "Participants";

const HEADER = ["First Name", "Last Name", "DOB", "ZIP", "Address", "City", "State", "Notes"];

// Three identical Anns (a three-member core cluster whose Notes column is blank
// on the first row and different on the other two — an auto-fill conflict), two
// identical Bobs, and four distinct singletons.
const ROWS: string[][] = [
  ["Ann", "Lee", "1/1/1980", "01234", "10 Oak St", "Boston", "MA", ""],
  ["Ann", "Lee", "1/1/1980", "01234", "10 Oak St", "Boston", "MA", "alpha"],
  ["Ann", "Lee", "1/1/1980", "01234", "10 Oak St", "Boston", "MA", "beta"],
  ["Bob", "Kim", "5/5/1975", "02345", "22 Elm St", "Salem", "MA", "solo"],
  ["Bob", "Kim", "5/5/1975", "02345", "22 Elm St", "Salem", "MA", ""],
  ["Carol", "Adams", "3/3/1970", "03301", "1 A St", "Concord", "NH", ""],
  ["Dave", "Brown", "4/4/1971", "04401", "2 B St", "Bangor", "ME", ""],
  ["Eve", "Clark", "6/6/1972", "05401", "3 C St", "Burlington", "VT", ""],
  ["Frank", "Davis", "7/7/1973", "06010", "4 D St", "Bristol", "CT", ""],
];

interface Harness {
  g: FakeSheetsGateway;
  cfg: DedupConfig;
  batchId: string;
  schema: SourceSchema;
  /** Participant ids keyed by their 1-based sheet row. */
  idByRow: Map<number, string>;
  annClusterId: string;
  bobClusterId: string;
}

function runToEnd(g: FakeSheetsGateway, cfg: DedupConfig): void {
  let state = advanceScan(g, cfg);
  let guard = 0;
  while (state.status !== "READY" && state.status !== "FAILED" && guard++ < 10_000) {
    state = advanceScan(g, cfg);
  }
  if (state.status !== "READY") throw new Error(`scan ended ${state.status}`);
}

function harness(email: string | null = "r@x.com"): Harness {
  const cfg = cloneDefaultConfig();
  const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: email });
  ensureSystemSheets(g, cfg);
  g.loadSheet(PEOPLE, { values: [HEADER, ...ROWS.map((r) => [...r])] });

  const start = startScan(g, PEOPLE, cfg);
  runToEnd(g, cfg);

  const batch = batchesRepository(g).get(start.batchId)!;
  const schema = batch.schema as unknown as SourceSchema;

  const idByRow = new Map<number, string>();
  for (const rec of recordsRepository(g).readByBatch(start.batchId, schema.headers)) {
    idByRow.set(rec.sourceRowAtScan, rec.dedupId);
  }

  const clusters = clustersRepository(g).listByBatch(start.batchId);
  const annId = idByRow.get(2)!;
  const bobId = idByRow.get(5)!;
  const find = (member: string): string => {
    const hit = clusters.find((c) => (c.memberIds as unknown as string[]).includes(member));
    if (!hit) throw new Error(`no cluster for ${member}`);
    return String(hit.clusterId);
  };

  return {
    g,
    cfg,
    batchId: start.batchId,
    schema,
    idByRow,
    annClusterId: find(annId),
    bobClusterId: find(bobId),
  };
}

/**
 * Writes a reviewed decision onto its cluster row the way the review layer will.
 * Kept local to this test: Phase F owns the production save path.
 */
function saveDecision(g: FakeSheetsGateway, decision: ClusterDecision): ClusterDecision {
  clustersRepository(g).update(decision.clusterId, {
    decision,
    decisionHash: decisionHash(decision),
    status: "READY_TO_APPLY",
    reviewerId: "r@x.com",
    reviewedAt: nowIso(g),
  });
  return decision;
}

function decisionFor(
  h: Harness,
  clusterId: string,
  retainedRow: number,
  deletedRows: number[],
  patch: Partial<ClusterDecision> = {},
): ClusterDecision {
  const retained = h.idByRow.get(retainedRow)!;
  const deleteAssignments: Record<string, string> = {};
  for (const row of deletedRows) deleteAssignments[h.idByRow.get(row)!] = retained;
  return {
    batchId: h.batchId,
    clusterId,
    expectedRevision: 1,
    mode: "SELECT_RECORDS",
    retainedIds: [retained],
    deleteAssignments,
    fieldChoices: {},
    notes: "",
    ...patch,
  };
}

/** Ann keeps row 2 and takes "alpha" from row 3; Bob keeps row 5. */
function resolvedDecisions(h: Harness): ClusterDecision[] {
  const ann = decisionFor(h, h.annClusterId, 2, [3, 4], {
    fieldChoices: {
      [h.idByRow.get(2)!]: {
        Notes: { mode: "SOURCE", sourceId: h.idByRow.get(3)! },
      },
    },
  });
  const bob = decisionFor(h, h.bobClusterId, 5, [6]);
  return [saveDecision(h.g, ann), saveDecision(h.g, bob)];
}

function confirm(challenge: { token: string; summaryHash: string }): ApplyChallenge {
  return { token: challenge.token, summaryHash: challenge.summaryHash, confirmed: true };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (isDedupError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a DedupError");
}

describe("apply preflight", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("creates a challenge whose summary matches the plans it will validate", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    expect(challenge.token).not.toBe("");
    expect(challenge.warningText).toBe(APPLY_CONFIRMATION_TEXT);
    expect(challenge.summary).toEqual({
      clusterCount: 2,
      retainedCount: 2,
      deletionRowCount: 3,
      fillCount: 1,
    });

    // The challenge is durable: apply runs in a later execution.
    const stored = stateRepository(h.g).get(APPLY_CHALLENGE_STATE_TYPE, h.batchId);
    expect(stored).not.toBeNull();
  });

  it("returns one recomputed plan per cluster for a confirmed challenge", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    const result = preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg);

    expect(result.summaryHash).toBe(challenge.summaryHash);
    expect(result.deletionRowCount).toBe(3);
    expect(result.plans).toHaveLength(2);
    expect(result.plans.every((p) => p.ok)).toBe(true);

    const ann = result.plans.find((p) => p.clusterId === h.annClusterId)!;
    expect(ann.deletions).toHaveLength(2);
    expect(ann.fills).toEqual([
      {
        retainedId: h.idByRow.get(2)!,
        header: "Notes",
        value: "alpha",
        sourceId: h.idByRow.get(3)!,
      },
    ]);
  });

  it("records APPLY_ATTEMPTED once a preflight passes (§24 step 17)", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);
    preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg);

    const attempts = auditRepository(h.g)
      .readAll()
      .filter((e) => e.eventType === "APPLY_ATTEMPTED");
    expect(attempts).toHaveLength(1);
    expect(String(attempts[0]!.batchId)).toBe(h.batchId);
  });

  it("AT-18 rejects an unconfirmed challenge and writes no audit attempt", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    const code = codeOf(() =>
      preflight(
        h.g,
        h.batchId,
        decisions,
        { ...confirm(challenge), confirmed: false },
        h.cfg,
      ),
    );
    expect(code).toBe("NOT_CONFIRMED");
    expect(
      auditRepository(h.g)
        .readAll()
        .filter((e) => e.eventType === "APPLY_ATTEMPTED"),
    ).toHaveLength(0);
  });

  it("AT-18 rejects an unknown token", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    const code = codeOf(() =>
      preflight(h.g, h.batchId, decisions, { ...confirm(challenge), token: "nope" }, h.cfg),
    );
    expect(code).toBe("NOT_CONFIRMED");
  });

  it("AT-18 rejects an expired challenge", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    const state = stateRepository(h.g);
    const stored = state.get(APPLY_CHALLENGE_STATE_TYPE, h.batchId)!;
    state.put(APPLY_CHALLENGE_STATE_TYPE, h.batchId, {
      ...(stored.valueJson as Record<string, unknown>),
      expiresAtMs: 1,
    });

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "NOT_CONFIRMED",
    );
  });

  it("AT-22 fails closed with STALE_ROW when a reviewed row was edited afterwards", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    // Row 3 is one of Ann's deletions; someone changes its ZIP after review.
    h.g.writeRange(PEOPLE, "D3", [["09999"]]);

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "STALE_ROW",
    );
  });

  it("AT-22 ignores edits to rows no decision touches", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    // Row 9 is an untouched singleton.
    h.g.writeRange(PEOPLE, "H9", [["edited"]]);

    const result = preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg);
    expect(result.deletionRowCount).toBe(3);
  });

  it("fails with SUMMARY_HASH_CHANGED when a decision changes after the challenge", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    // The reviewer reopens Ann and drops one deletion; the confirmed summary no
    // longer describes what would be applied.
    const changed = saveDecision(h.g, decisionFor(h, h.annClusterId, 2, [3]));
    const next = [changed, decisions[1]!];

    expect(codeOf(() => preflight(h.g, h.batchId, next, confirm(challenge), h.cfg))).toBe(
      "SUMMARY_HASH_CHANGED",
    );
  });

  it("fails with REVISION_CONFLICT when the cluster moved on (§27.2)", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    clustersRepository(h.g).update(h.annClusterId, { revision: 2 });

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "REVISION_CONFLICT",
    );
  });

  it("fails with REVISION_CONFLICT when the submitted decision is not the saved one", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    // Same cluster row and revision, but the client submits a decision that
    // keeps the other Bob — a decision no reviewer ever saved.
    const tampered = decisionFor(h, h.bobClusterId, 6, [5]);

    expect(
      codeOf(() =>
        preflight(h.g, h.batchId, [decisions[0]!, tampered], confirm(challenge), h.cfg),
      ),
    ).toBe("REVISION_CONFLICT");
  });

  it("fails with UNRESOLVED_CONFLICT when a field choice is still missing", () => {
    const ann = saveDecision(h.g, decisionFor(h, h.annClusterId, 2, [3, 4]));
    const bob = saveDecision(h.g, decisionFor(h, h.bobClusterId, 5, [6]));
    const decisions = [ann, bob];
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "UNRESOLVED_CONFLICT",
    );
  });

  it("fails with BATCH_STATE_CONFLICT when a member is left unassigned", () => {
    const ann = saveDecision(h.g, decisionFor(h, h.annClusterId, 2, [3]));
    const decisions = [ann];
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "BATCH_STATE_CONFLICT",
    );
  });

  it("fails with SCHEMA_CHANGED when a header was renamed after the scan", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    h.g.writeRange(PEOPLE, "H1", [["Remarks"]]);

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "SCHEMA_CHANGED",
    );
  });

  it("fails with DUPLICATE_DEDUP_ID when an affected id appears twice in the sheet", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    // Copy Ann's retained id onto an untouched singleton row.
    const idCol = String.fromCharCode(65 + h.schema.dedupIdColumnIndex);
    h.g.writeRange(PEOPLE, `${idCol}9`, [[h.idByRow.get(2)!]]);

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "DUPLICATE_DEDUP_ID",
    );
  });

  it("fails with STALE_ROW when an affected row has vanished", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    // Blank every mapped column of row 4 — the snapshot's row is no longer a
    // participant row, so its id cannot be located.
    h.g.writeRange(PEOPLE, "A4:H4", [["", "", "", "", "", "", "", ""]]);

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "STALE_ROW",
    );
  });

  it("fails the whole preflight when clusters share a member (§24 last rule)", () => {
    const decisions = resolvedDecisions(h);
    const annRetained = h.idByRow.get(2)!;
    const soloId = h.idByRow.get(7)!;

    // A low pair that overlaps Ann's core cluster: the same id would be both
    // retained there and deleted here.
    const overlapId = makeClusterId(h.batchId, [annRetained, soloId]);
    clustersRepository(h.g).append([
      {
        batchId: h.batchId,
        clusterId: overlapId,
        clusterType: "LOW_PAIR",
        memberIds: [annRetained, soloId],
        coreMemberIds: [annRetained, soloId],
        suggestedMemberIds: [],
        edgeKeys: [],
        highestConfidence: "LOW",
        maxScore: 0,
        warnings: [],
        status: "UNREVIEWED",
        revision: 1,
      },
    ]);
    const overlap = saveDecision(h.g, decisionFor(h, overlapId, 7, [2]));

    const all = [...decisions, overlap];
    const challenge = createApplyChallenge(h.g, h.batchId, all, h.cfg);

    expect(codeOf(() => preflight(h.g, h.batchId, all, confirm(challenge), h.cfg))).toBe(
      "BATCH_STATE_CONFLICT",
    );
  });

  it("AT-26 replays an already-applied decision as a no-op", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    // The first apply completed: both clusters are marked applied and their rows
    // are gone from the sheet.
    for (const id of [h.annClusterId, h.bobClusterId]) {
      clustersRepository(h.g).update(id, {
        status: "APPLIED",
        appliedAt: nowIso(h.g),
        applyBatchId: "apply-1",
      });
    }
    h.g.writeRange(PEOPLE, "A3:H4", [
      ["", "", "", "", "", "", "", ""],
      ["", "", "", "", "", "", "", ""],
    ]);

    const result = preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg);
    expect(result.plans).toHaveLength(0);
    expect(result.deletionRowCount).toBe(0);
    // The confirmed summary still describes the same work, so the hash holds.
    expect(result.summaryHash).toBe(challenge.summaryHash);
  });

  it("AT-26 skips only the clusters that were already applied", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    clustersRepository(h.g).update(h.bobClusterId, {
      status: "APPLIED",
      appliedAt: nowIso(h.g),
      applyBatchId: "apply-1",
    });
    h.g.writeRange(PEOPLE, "A6:H6", [["", "", "", "", "", "", "", ""]]);

    const result = preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg);
    expect(result.plans.map((p) => p.clusterId)).toEqual([h.annClusterId]);
    expect(result.deletionRowCount).toBe(2);
  });

  it("fails with DUPLICATE_APPLY once the batch itself is applied", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);
    batchesRepository(h.g).update(h.batchId, { status: "APPLIED" });

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "DUPLICATE_APPLY",
    );
  });

  it("fails with BATCH_NOT_FOUND for an unknown batch", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    expect(codeOf(() => preflight(h.g, "no-such-batch", decisions, confirm(challenge), h.cfg))).toBe(
      "BATCH_NOT_FOUND",
    );
  });

  it("fails with CLUSTER_NOT_FOUND for a decision on an unknown cluster", () => {
    const decisions = resolvedDecisions(h);
    const stray: ClusterDecision = { ...decisions[0]!, clusterId: "ghost" };

    expect(codeOf(() => createApplyChallenge(h.g, h.batchId, [stray], h.cfg))).toBe(
      "CLUSTER_NOT_FOUND",
    );
  });

  it("fails with BATCH_STATE_CONFLICT when a decision names a different batch", () => {
    const decisions = resolvedDecisions(h);
    const stray: ClusterDecision = { ...decisions[0]!, batchId: "other" };

    expect(codeOf(() => createApplyChallenge(h.g, h.batchId, [stray], h.cfg))).toBe(
      "BATCH_STATE_CONFLICT",
    );
  });

  it("requires a reviewer identity before a challenge exists (§24 step 1)", () => {
    const anon = harness(null);
    const decisions = resolvedDecisions(anon);

    expect(codeOf(() => createApplyChallenge(anon.g, anon.batchId, decisions, anon.cfg))).toBe(
      "MISSING_REVIEWER_IDENTITY",
    );
  });

  it("accepts a fallback reviewer name when Apps Script has no email", () => {
    const anon = harness(null);
    const decisions = resolvedDecisions(anon).map((d) => ({
      ...d,
      fallbackReviewerName: "Dana R.",
    }));

    const challenge = createApplyChallenge(anon.g, anon.batchId, decisions, anon.cfg);
    const result = preflight(anon.g, anon.batchId, decisions, confirm(challenge), anon.cfg);
    expect(result.deletionRowCount).toBe(3);
  });

  it("binds a challenge to its reviewer", () => {
    const decisions = resolvedDecisions(h);
    const challenge = createApplyChallenge(h.g, h.batchId, decisions, h.cfg);

    const state = stateRepository(h.g);
    const stored = state.get(APPLY_CHALLENGE_STATE_TYPE, h.batchId)!;
    state.put(APPLY_CHALLENGE_STATE_TYPE, h.batchId, {
      ...(stored.valueJson as Record<string, unknown>),
      reviewerKey: "someone-else@x.com",
    });

    expect(codeOf(() => preflight(h.g, h.batchId, decisions, confirm(challenge), h.cfg))).toBe(
      "NOT_CONFIRMED",
    );
  });
});
