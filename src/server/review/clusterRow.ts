import type { ClusterRecord } from "@/server/clustersRepository";
import type { Cluster } from "@/server/types";
import type { ClusterType, Warning } from "@/shared/constants";
import { MAX_CLUSTER_MEMBERS } from "@/server/match/cluster";

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/**
 * Rebuilds the in-memory cluster from its stored row. `oversized` is recomputed
 * rather than stored: it is a function of the member counts on the row.
 */
export function clusterFromRow(row: ClusterRecord): Cluster {
  const memberIds = asStrings(row.memberIds);
  const suggestedMemberIds = asStrings(row.suggestedMemberIds);
  const clusterType = String(row.clusterType) as ClusterType;
  return {
    clusterId: String(row.clusterId),
    clusterType,
    memberIds,
    suggestedMemberIds,
    edges: [],
    topConfidence: String(row.highestConfidence ?? "LOW") as Cluster["topConfidence"],
    topScore: Number(row.maxScore ?? 0),
    hasLowOnlyEdges: clusterType === "LOW_PAIR",
    chainWarning: (asStrings(row.warnings) as Warning[]).includes("POSSIBLE_CHAIN_CLUSTER"),
    oversized: memberIds.length + suggestedMemberIds.length > MAX_CLUSTER_MEMBERS,
  };
}
