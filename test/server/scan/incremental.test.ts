import { describe, expect, it } from "vitest";
import type { ClusterRecord } from "@/server/clustersRepository";
import type { RecordSnapshot } from "@/server/types";
import {
  carriedReadyClusters,
  classifyRecordDelta,
  dirtyIds,
} from "@/server/scan/incremental";

function rec(dedupId: string, relevantHash: string): RecordSnapshot {
  return {
    batchId: "b",
    dedupId,
    sourceRowAtScan: 1,
    rowFingerprint: `${relevantHash}:row`,
    relevantHash,
    rawValues: [],
    displayValues: [],
    formulas: [],
    valuesByHeader: {},
    displayByHeader: {},
    normalized: {
      name: {
        firstTokens: [],
        middleTokens: [],
        lastTokens: [],
        aliasTokens: [],
        coreTokens: [],
        orderedNoMiddle: "",
        reversedNoMiddle: "",
        sortedTokenSignature: "",
        initials: [],
        missingCoreComponent: false,
      },
      dob: { state: "MISSING", value: null },
      zip: null,
      address: null,
      city: null,
      state: null,
      county: null,
      extras: {},
    },
  };
}

function cluster(
  clusterId: string,
  status: string,
  memberIds: string[],
  suggestedMemberIds: string[] = [],
): ClusterRecord {
  return { clusterId, status, memberIds, suggestedMemberIds } as unknown as ClusterRecord;
}

describe("incremental scan helpers", () => {
  it("classifies added, changed, removed, and unchanged records by dedup id", () => {
    const delta = classifyRecordDelta(
      [rec("changed", "old"), rec("removed", "gone"), rec("same", "same")],
      [rec("added", "new"), rec("changed", "new"), rec("same", "same")],
    );

    expect(delta).toEqual({
      addedIds: ["added"],
      changedIds: ["changed"],
      removedIds: ["removed"],
      unchangedIds: ["same"],
    });
  });

  it("marks added/changed rows and unfinished clusters dirty", () => {
    const delta = {
      addedIds: ["added"],
      changedIds: ["changed"],
      removedIds: [],
      unchangedIds: ["ready", "unresolved"],
    };

    expect(
      dirtyIds(delta, [
        cluster("done", "READY_TO_APPLY", ["ready"]),
        cluster("todo", "UNRESOLVED", ["unresolved"], ["suggested"]),
      ]),
    ).toEqual(["added", "changed", "suggested", "unresolved"]);
  });

  it("carries only unchanged ready-to-apply clusters", () => {
    const rows = [
      cluster("carry", "READY_TO_APPLY", ["a", "b"]),
      cluster("changed", "READY_TO_APPLY", ["a", "c"]),
      cluster("unfinished", "UNRESOLVED", ["a", "b"]),
    ];

    expect(carriedReadyClusters(rows, ["a", "b"]).map((row) => row.clusterId)).toEqual([
      "carry",
    ]);
  });
});

