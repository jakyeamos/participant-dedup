import type { DedupConfig } from "@/shared/config";
import type { ClusterType } from "@/shared/constants";
import type { Cluster, PairScore } from "@/server/types";

/** §18.3 displayed-member ceiling. */
export const MAX_CLUSTER_MEMBERS = 50;

const CONFIDENCE_RANK: Record<"HIGH" | "MEDIUM" | "LOW", number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    let parent = this.parent.get(root) ?? root;
    while (root !== parent) {
      root = parent;
      parent = this.parent.get(root) ?? root;
    }
    // Point x directly at the root (path compression).
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function pushEdge(map: Map<string, PairScore[]>, key: string, edge: PairScore): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function dedupeSortEdges(edges: PairScore[]): PairScore[] {
  const byKey = new Map<string, PairScore>();
  for (const e of edges) if (!byKey.has(e.pairKey)) byKey.set(e.pairKey, e);
  return [...byKey.values()].sort((a, b) => a.pairKey.localeCompare(b.pairKey));
}

/**
 * §18 Cluster formation. Runs union-find over High and Medium edges to build
 * core clusters (§18.1), then folds Low edges in per §18.2 without ever letting
 * them merge components: same-cluster Low edges are kept as evidence, an outside
 * record joins its strongest-Low core cluster as a suggestion, an outside pair
 * becomes an independent `LOW_PAIR`, and a Low edge bridging two cores raises a
 * chain warning instead of merging. Oversized clusters are flagged (§18.3) and
 * the queue is ordered by confidence, score, then member id (§18.4). Pure.
 */
export function formCluster(scores: PairScore[], _cfg: DedupConfig): Cluster[] {
  const edges = scores.filter((s) => s.eligible && s.confidence !== "EXCLUDED");
  const coreEdges = edges.filter((e) => e.confidence === "HIGH" || e.confidence === "MEDIUM");
  const lowEdges = edges.filter((e) => e.confidence === "LOW");

  // §18.1 union-find over High + Medium edges.
  const uf = new UnionFind();
  const coreMembers = new Set<string>();
  for (const e of coreEdges) {
    uf.union(e.leftId, e.rightId);
    coreMembers.add(e.leftId);
    coreMembers.add(e.rightId);
  }

  const membersByRoot = new Map<string, Set<string>>();
  for (const id of coreMembers) {
    const root = uf.find(id);
    const set = membersByRoot.get(root);
    if (set) set.add(id);
    else membersByRoot.set(root, new Set([id]));
  }

  const evidenceByRoot = new Map<string, PairScore[]>();
  for (const e of coreEdges) pushEdge(evidenceByRoot, uf.find(e.leftId), e);

  const chainRoots = new Set<string>();
  const suggestedByRoot = new Map<string, Set<string>>();
  // Best Low edge attaching each outside record to a core cluster (§18.2 rule 2).
  const attachByOutside = new Map<string, { root: string; edge: PairScore }>();
  const lowPairs: PairScore[] = [];

  for (const e of lowEdges) {
    const lCore = coreMembers.has(e.leftId);
    const rCore = coreMembers.has(e.rightId);

    if (lCore && rCore) {
      const rootL = uf.find(e.leftId);
      const rootR = uf.find(e.rightId);
      if (rootL === rootR) {
        pushEdge(evidenceByRoot, rootL, e); // rule 1: explanatory evidence
      } else {
        // rule 4: bridges two cores — warn, do not merge.
        chainRoots.add(rootL);
        chainRoots.add(rootR);
        pushEdge(evidenceByRoot, rootL, e);
        pushEdge(evidenceByRoot, rootR, e);
      }
    } else if (lCore || rCore) {
      // rule 2: one endpoint outside — attach it to its strongest-Low core.
      const outside = lCore ? e.rightId : e.leftId;
      const root = uf.find(lCore ? e.leftId : e.rightId);
      const current = attachByOutside.get(outside);
      if (
        current === undefined ||
        e.totalScore > current.edge.totalScore ||
        (e.totalScore === current.edge.totalScore && root < current.root)
      ) {
        attachByOutside.set(outside, { root, edge: e });
      }
    } else {
      lowPairs.push(e); // rule 3: independent LOW_PAIR
    }
  }

  for (const [outside, { root, edge }] of attachByOutside) {
    const set = suggestedByRoot.get(root);
    if (set) set.add(outside);
    else suggestedByRoot.set(root, new Set([outside]));
    pushEdge(evidenceByRoot, root, edge);
  }

  const clusters: Cluster[] = [];

  for (const [root, memberSet] of membersByRoot) {
    const memberIds = [...memberSet].sort();
    const suggestedMemberIds = [...(suggestedByRoot.get(root) ?? [])].sort();
    const clusterEdges = dedupeSortEdges(evidenceByRoot.get(root) ?? []);
    const rankedEdges = clusterEdges.filter(
      (e) => e.confidence === "HIGH" || e.confidence === "MEDIUM",
    );
    const topConfidence: "HIGH" | "MEDIUM" = rankedEdges.some((e) => e.confidence === "HIGH")
      ? "HIGH"
      : "MEDIUM";
    const topScore = rankedEdges.reduce((max, e) => Math.max(max, e.totalScore), 0);
    const clusterType: ClusterType =
      suggestedMemberIds.length > 0 ? "CORE_WITH_SUGGESTIONS" : "CORE";
    const displayedCount = memberIds.length + suggestedMemberIds.length;

    clusters.push({
      clusterId: `CORE:${memberIds.join("|")}`,
      clusterType,
      memberIds,
      suggestedMemberIds,
      edges: clusterEdges,
      topConfidence,
      topScore,
      hasLowOnlyEdges: false,
      chainWarning: chainRoots.has(root),
      oversized: displayedCount > MAX_CLUSTER_MEMBERS,
    });
  }

  for (const edge of dedupeSortEdges(lowPairs)) {
    const memberIds = [edge.leftId, edge.rightId].sort();
    clusters.push({
      clusterId: `LOW:${memberIds.join("|")}`,
      clusterType: "LOW_PAIR",
      memberIds,
      suggestedMemberIds: [],
      edges: [edge],
      topConfidence: "LOW",
      topScore: edge.totalScore,
      hasLowOnlyEdges: true,
      chainWarning: false,
      oversized: false,
    });
  }

  // §18.4 queue ordering: confidence, then score desc, then smallest member id.
  clusters.sort((a, b) => {
    const rank = CONFIDENCE_RANK[a.topConfidence] - CONFIDENCE_RANK[b.topConfidence];
    if (rank !== 0) return rank;
    if (b.topScore !== a.topScore) return b.topScore - a.topScore;
    return a.memberIds[0]!.localeCompare(b.memberIds[0]!);
  });

  return clusters;
}
