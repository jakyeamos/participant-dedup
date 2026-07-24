import { describe, expect, it } from "vitest";

/**
 * §33 Acceptance matrix map (AT-01…AT-30).
 *
 * Automatable items are covered by existing focused tests — this file is the
 * coverage map the plan asks for, not a second copy of those assertions. Live-
 * only items are explicitly skipped with the owner-UAT reason.
 *
 * When adding behavior, prefer extending the referenced suite and keep this
 * table as the index.
 */

type Coverage =
  | { kind: "automated"; via: string }
  | { kind: "live-uat"; reason: string };

const MATRIX: Record<string, Coverage> = {
  "AT-01": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-02": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-03": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-04": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-05": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-06": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-07": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-08": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-09": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-10": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-11": { kind: "automated", via: "test/server/match/scorePair.test.ts" },
  "AT-12": { kind: "automated", via: "test/server/match/cluster.test.ts" },
  "AT-13": { kind: "automated", via: "test/server/review/mergePlan.test.ts" },
  "AT-14": { kind: "automated", via: "test/server/review/mergePlan.test.ts" },
  "AT-15": { kind: "automated", via: "test/server/review/mergePlan.test.ts" },
  "AT-16": { kind: "automated", via: "test/server/review/mergePlan.test.ts" },
  "AT-17": { kind: "automated", via: "test/server/apply/applyDecisions.test.ts" },
  "AT-18": { kind: "automated", via: "test/server/apply/preflight.test.ts" },
  "AT-19": {
    kind: "automated",
    via: "test/server/apply/applyDecisions.test.ts (FakeSheetsGateway)",
  },
  "AT-20": {
    kind: "automated",
    via: "test/server/dedupId.test.ts + identity paths in scan/apply",
  },
  "AT-21": {
    kind: "automated",
    via: "test/client/sidebar.render.test.ts + MISSING_REVIEWER_IDENTITY tests",
  },
  "AT-22": { kind: "automated", via: "test/server/apply/preflight.test.ts" },
  "AT-23": { kind: "automated", via: "test/server/review/suppression.test.ts" },
  "AT-24": { kind: "automated", via: "test/server/review/suppression.test.ts" },
  "AT-25": { kind: "automated", via: "test/client/sidebar.render.test.ts" },
  "AT-26": {
    kind: "automated",
    via: "test/server/apply/preflight.test.ts + applyDecisions.test.ts",
  },
  "AT-27": {
    kind: "automated",
    via: "test/server/scan/scanStateMachine.test.ts + test/tools/dogfood.test.ts",
  },
  "AT-28": {
    kind: "automated",
    via: "test/static/noExternalCalls.test.ts + test/build/dist.test.ts",
  },
  "AT-29": {
    kind: "automated",
    via: "test/server/apply/atomicRequest.test.ts + applyDecisions.test.ts",
  },
  "AT-30": { kind: "automated", via: "test/server/scan/scanStateMachine.test.ts" },
};

/** Truly live checks that FakeSheetsGateway cannot stand in for. */
const LIVE_ONLY: Array<{ id: string; reason: string }> = [
  {
    id: "AT-LIVE-AUTH",
    reason: "OAuth consent + Advanced Sheets enablement require a real Google account",
  },
  {
    id: "AT-LIVE-SLICE",
    reason: "Six-minute Apps Script execution slicing / resume under quota needs a live project",
  },
  {
    id: "AT-LIVE-UI",
    reason: "Sidebar chrome inside the Sheets host (focus handoff, toast) needs a bound copy",
  },
];

describe("acceptance matrix (§33)", () => {
  it("indexes every AT-01…AT-30", () => {
    const expected = Array.from({ length: 30 }, (_, i) => `AT-${String(i + 1).padStart(2, "0")}`);
    expect(Object.keys(MATRIX).sort()).toEqual(expected);
  });

  for (const [id, coverage] of Object.entries(MATRIX)) {
    it(`${id} is mapped to automated coverage (${coverage.via})`, () => {
      expect(coverage.kind).toBe("automated");
      expect(coverage.via.length).toBeGreaterThan(0);
    });
  }

  for (const item of LIVE_ONLY) {
    it.skip(`${item.id}: ${item.reason}`, () => {
      // Owner UAT on a workbook copy — see README.md hand-off checklist.
      expect(true).toBe(true);
    });
  }
});
