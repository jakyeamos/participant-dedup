import { describe, expect, it } from "vitest";
import { formCluster } from "@/server/match/cluster";
import { cloneDefaultConfig } from "@/shared/config";
import type { Confidence } from "@/shared/constants";
import type { PairScore } from "@/server/types";

const cfg = cloneDefaultConfig();

function edge(
  left: string,
  right: string,
  confidence: Confidence,
  totalScore = 90,
): PairScore {
  return {
    pairKey: [left, right].sort().join("|"),
    leftId: left,
    rightId: right,
    eligible: confidence !== "EXCLUDED",
    totalScore,
    confidence,
    nameMethod: "DIRECT",
    components: {
      nameSimilarity: 1,
      namePoints: 60,
      dobPoints: 25,
      addressSimilarity: 0,
      addressPoints: 0,
      zipPoints: 5,
      contextPoints: 0,
      penalties: 0,
    },
    flags: {
      exactDirectName: true,
      exactReversal: false,
      nameOnly: false,
      dobExact: true,
      dobConflict: false,
      zipExact: true,
      addressStrong: false,
    },
    reasons: [],
    warnings: [],
  };
}

function clusterContaining(clusters: ReturnType<typeof formCluster>, id: string) {
  return clusters.find((c) => c.memberIds.includes(id));
}

describe("formCluster", () => {
  it("AT-12 merges transitively related HIGH edges into one cluster", () => {
    const clusters = formCluster([edge("A", "B", "HIGH"), edge("B", "C", "HIGH")], cfg);
    expect(clusters).toHaveLength(1);
    expect([...clusters[0]!.memberIds].sort()).toEqual(["A", "B", "C"]);
    expect(clusters[0]!.topConfidence).toBe("HIGH");
  });

  it("does not merge two HIGH clusters connected only by a LOW edge; flags chainWarning", () => {
    const clusters = formCluster(
      [
        edge("A", "B", "HIGH"),
        edge("C", "D", "HIGH"),
        edge("B", "C", "LOW", 50),
      ],
      cfg,
    );
    const ab = clusterContaining(clusters, "A")!;
    const cd = clusterContaining(clusters, "C")!;
    expect(ab.memberIds).not.toContain("C");
    expect(cd.memberIds).not.toContain("A");
    expect(ab.chainWarning).toBe(true);
    expect(cd.chainWarning).toBe(true);
  });

  it("creates an independent LOW_PAIR cluster when both endpoints are outside every core cluster", () => {
    const clusters = formCluster([edge("X", "Y", "LOW", 50)], cfg);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.clusterType).toBe("LOW_PAIR");
    expect(clusters[0]!.topConfidence).toBe("LOW");
    expect(clusters[0]!.hasLowOnlyEdges).toBe(true);
    expect([...clusters[0]!.memberIds].sort()).toEqual(["X", "Y"]);
  });

  it("attaches an outside record as a suggested member (not a core member) via its strongest LOW edge", () => {
    const clusters = formCluster(
      [edge("A", "B", "HIGH"), edge("B", "S", "LOW", 40), edge("A", "S", "LOW", 50)],
      cfg,
    );
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect([...c.memberIds].sort()).toEqual(["A", "B"]);
    expect(c.suggestedMemberIds).toEqual(["S"]);
    expect(c.clusterType).toBe("CORE_WITH_SUGGESTIONS");
    expect(c.topConfidence).toBe("HIGH");
  });

  it("flags OVERSIZED clusters and blocks deletion when members exceed the ceiling", () => {
    const scores: PairScore[] = [];
    for (let i = 1; i <= 51; i++) scores.push(edge("R0", `R${i}`, "HIGH"));
    const clusters = formCluster(scores, cfg);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memberIds.length).toBe(52);
    expect(clusters[0]!.oversized).toBe(true);
  });

  it("assigns deterministic clusterIds and stable ordering", () => {
    const input = [edge("B", "C", "HIGH"), edge("A", "B", "HIGH"), edge("X", "Y", "MEDIUM", 65)];
    const first = formCluster(input, cfg);
    const second = formCluster([...input].reverse(), cfg);
    expect(first.map((c) => c.clusterId)).toEqual(second.map((c) => c.clusterId));
    // HIGH cluster ranks before MEDIUM cluster.
    expect(first[0]!.topConfidence).toBe("HIGH");
    expect(first[first.length - 1]!.topConfidence).toBe("MEDIUM");
  });
});
