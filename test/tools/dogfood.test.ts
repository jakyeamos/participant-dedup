import { describe, expect, it } from "vitest";
import { generateFixture } from "../../tools/generateFixture";
import { runDogfood } from "../../tools/dogfoodReport";
import { cloneDefaultConfig } from "@/shared/config";

// The dogfood gate: run the pure engine over 5,000 seeded rows and hold it to
// the precision/recall bar from the plan (Task C2). Tune only DEFAULT_CONFIG on
// failure — never special-case the fixture.
describe("runDogfood engine gate (5,000 rows)", () => {
  const cfg = cloneDefaultConfig();
  const { rows, groundTruth } = generateFixture(1, 5000);
  const report = runDogfood(rows, groundTruth, cfg);

  it("keeps candidate generation under the global cap and un-truncated", () => {
    expect(report.candidateCount).toBeLessThan(cfg.blocking.maxTotalCandidates);
    expect(report.truncated).toBe(false);
  });

  it("recalls every seeded duplicate pair as a candidate", () => {
    expect(report.recallAllSeeded).toBe(1);
  });

  it("produces zero household false positives", () => {
    expect(report.householdFalsePositives).toBe(0);
  });

  it("achieves at least 0.98 precision in the HIGH band", () => {
    expect(report.byBand.HIGH.precision).toBeGreaterThanOrEqual(0.98);
  });
});
