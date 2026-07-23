import { describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { cloneDefaultConfig } from "@/shared/config";
import { configHash } from "@/server/hashing";
import {
  clearKeepAll,
  filterSuppressed,
  isSuppressed,
  memberContentHash,
  recordKeepAll,
  suppressionKey,
  type SuppressionMember,
} from "@/server/review/suppression";
import type { Cluster } from "@/server/types";

function newGateway(): FakeSheetsGateway {
  const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: "r@x.com" });
  ensureSystemSheets(g, cloneDefaultConfig());
  return g;
}

const MEMBERS: SuppressionMember[] = [
  { dedupId: "id-b", relevantHash: "hash-b" },
  { dedupId: "id-a", relevantHash: "hash-a" },
];

function cluster(memberIds: string[]): Cluster {
  return {
    clusterId: `C:${memberIds.join("|")}`,
    clusterType: "CORE",
    memberIds: [...memberIds].sort(),
    suggestedMemberIds: [],
    edges: [],
    topConfidence: "HIGH",
    topScore: 100,
    hasLowOnlyEdges: false,
    chainWarning: false,
    oversized: false,
  };
}

describe("keep-all suppression", () => {
  it("keys are order-independent over member ids", () => {
    const cfg = configHash(cloneDefaultConfig());
    expect(suppressionKey(["id-b", "id-a"], cfg)).toBe(suppressionKey(["id-a", "id-b"], cfg));
    expect(memberContentHash(MEMBERS)).toBe(memberContentHash([...MEMBERS].reverse()));
  });

  it("distinguishes different member sets and different configs", () => {
    const cfgA = configHash(cloneDefaultConfig());
    const changed = cloneDefaultConfig();
    changed.thresholds.high += 1;
    const cfgB = configHash(changed);

    expect(suppressionKey(["id-a", "id-b"], cfgA)).not.toBe(
      suppressionKey(["id-a", "id-c"], cfgA),
    );
    expect(suppressionKey(["id-a", "id-b"], cfgA)).not.toBe(
      suppressionKey(["id-a", "id-b"], cfgB),
    );
  });

  it("AT-23: an unchanged Keep All cluster is suppressed on the next scan", () => {
    const g = newGateway();
    const cfg = configHash(cloneDefaultConfig());

    expect(isSuppressed(g, MEMBERS, cfg)).toBe(false);
    recordKeepAll(g, MEMBERS, cfg);
    expect(isSuppressed(g, MEMBERS, cfg)).toBe(true);
  });

  it("AT-24: a changed member relevant hash makes the cluster eligible again", () => {
    const g = newGateway();
    const cfg = configHash(cloneDefaultConfig());
    recordKeepAll(g, MEMBERS, cfg);

    const edited: SuppressionMember[] = [
      { dedupId: "id-a", relevantHash: "hash-a" },
      { dedupId: "id-b", relevantHash: "hash-b-EDITED" },
    ];
    expect(isSuppressed(g, edited, cfg)).toBe(false);
  });

  it("a membership change makes the cluster eligible again", () => {
    const g = newGateway();
    const cfg = configHash(cloneDefaultConfig());
    recordKeepAll(g, MEMBERS, cfg);

    const grown: SuppressionMember[] = [...MEMBERS, { dedupId: "id-c", relevantHash: "hash-c" }];
    expect(isSuppressed(g, grown, cfg)).toBe(false);
  });

  it("a config change makes the cluster eligible again", () => {
    const g = newGateway();
    const cfg = configHash(cloneDefaultConfig());
    recordKeepAll(g, MEMBERS, cfg);

    const changed = cloneDefaultConfig();
    changed.thresholds.high += 1;
    expect(isSuppressed(g, MEMBERS, configHash(changed))).toBe(false);
  });

  it("clearing a Keep All decision removes suppression", () => {
    const g = newGateway();
    const cfg = configHash(cloneDefaultConfig());
    recordKeepAll(g, MEMBERS, cfg);
    clearKeepAll(g, ["id-a", "id-b"], cfg);
    expect(isSuppressed(g, MEMBERS, cfg)).toBe(false);
  });

  it("re-recording the same key updates rather than duplicating state rows", () => {
    const g = newGateway();
    const cfg = configHash(cloneDefaultConfig());
    recordKeepAll(g, MEMBERS, cfg);
    recordKeepAll(g, MEMBERS, cfg);
    expect(isSuppressed(g, MEMBERS, cfg)).toBe(true);
  });

  it("filterSuppressed drops only clusters whose members are unchanged", () => {
    const g = newGateway();
    const cfg = configHash(cloneDefaultConfig());
    recordKeepAll(g, MEMBERS, cfg);

    const hashes = new Map<string, string>([
      ["id-a", "hash-a"],
      ["id-b", "hash-b"],
      ["id-c", "hash-c"],
      ["id-d", "hash-d"],
    ]);

    const kept = filterSuppressed(
      g,
      [cluster(["id-a", "id-b"]), cluster(["id-c", "id-d"])],
      (id) => hashes.get(id) ?? "",
      cfg,
    );
    expect(kept.map((c) => c.memberIds)).toEqual([["id-c", "id-d"]]);

    hashes.set("id-b", "hash-b-EDITED");
    const keptAfterEdit = filterSuppressed(
      g,
      [cluster(["id-a", "id-b"]), cluster(["id-c", "id-d"])],
      (id) => hashes.get(id) ?? "",
      cfg,
    );
    expect(keptAfterEdit).toHaveLength(2);
  });
});
