/**
 * Dogfood precision/recall harness (Task C2).
 *
 * Runs the pure matching engine — candidate generation → pair scoring →
 * cluster formation — over a synthetic fixture and scores the results against
 * the fixture's ground truth. No Apps Script, no OAuth, no real data. Runs
 * under vitest and as a `tsx` script for a printed report.
 */
import type { DedupConfig } from "@/shared/config";
import type { RecordSnapshot } from "@/server/types";
import { normalizeName } from "@/server/match/normalizeName";
import { normalizeDob } from "@/server/match/normalizeDob";
import { normalizeZip } from "@/server/match/normalizeZip";
import { normalizeAddress } from "@/server/match/normalizeAddress";
import {
  normalizeCity,
  normalizeCounty,
  normalizeState,
} from "@/server/match/normalizeLocation";
import { generateCandidates } from "@/server/match/candidateGenerator";
import { scorePair } from "@/server/match/scorePair";
import { formCluster } from "@/server/match/cluster";

import {
  generateFixture,
  POSITIVE_KINDS,
  type GroundTruthGroup,
} from "./generateFixture";

type Band = "HIGH" | "MEDIUM" | "LOW";

export interface BandStats {
  precision: number;
  recall: number;
  f1: number;
}

export interface DogfoodReport {
  candidateCount: number;
  truncated: boolean;
  byBand: Record<Band, BandStats>;
  recallAllSeeded: number;
  householdFalsePositives: number;
  clusterCount: number;
}

const TZ = "America/New_York";

function key(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** All unordered intra-group pairs of a ground-truth group. */
function groupPairs(group: GroundTruthGroup): string[] {
  const out: string[] = [];
  for (let i = 0; i < group.ids.length; i++) {
    for (let j = i + 1; j < group.ids.length; j++) {
      out.push(key(group.ids[i]!, group.ids[j]!));
    }
  }
  return out;
}

function toSnapshot(row: Record<string, string>, cfg: DedupConfig): RecordSnapshot {
  const g = (h: string): string => row[h] ?? "";
  return {
    batchId: "dogfood",
    dedupId: g("_Dedup_ID"),
    sourceRowAtScan: 0,
    rowFingerprint: "",
    relevantHash: "",
    rawValues: [],
    displayValues: [],
    formulas: [],
    valuesByHeader: {},
    displayByHeader: {},
    normalized: {
      name: normalizeName(g("First Name"), g("Middle"), g("Last Name"), cfg),
      dob: normalizeDob(g("DOB") || null, TZ, cfg),
      zip: normalizeZip(g("ZIP")),
      address: normalizeAddress(g("Address") || null, cfg),
      city: normalizeCity(g("City") || null, cfg),
      state: normalizeState(g("State") || null, cfg),
      county: normalizeCounty(null, cfg),
      extras: {},
    },
  };
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function runDogfood(
  rows: Array<Record<string, string>>,
  groundTruth: GroundTruthGroup[],
  cfg: DedupConfig,
): DogfoodReport {
  const records = rows.map((r) => toSnapshot(r, cfg));
  const byId = new Map<string, RecordSnapshot>();
  for (const r of records) byId.set(r.dedupId, r);

  // Truth sets: positive kinds are genuine duplicate pairs; households are known
  // negatives whose pairs must never reach eligible.
  const truthDupPairs = new Set<string>();
  const householdPairs = new Set<string>();
  for (const group of groundTruth) {
    if (POSITIVE_KINDS.has(group.kind)) {
      for (const k of groupPairs(group)) truthDupPairs.add(k);
    } else if (group.kind === "HOUSEHOLD") {
      for (const k of groupPairs(group)) householdPairs.add(k);
    }
  }

  const candidates = generateCandidates(records, cfg);
  const candidateKeys = new Set<string>();
  for (const p of candidates.pairs) candidateKeys.add(key(p.leftId, p.rightId));

  const covered = [...truthDupPairs].filter((k) => candidateKeys.has(k)).length;
  const recallAllSeeded = truthDupPairs.size === 0 ? 1 : covered / truthDupPairs.size;

  const eligibleKeys = new Set<string>();
  const predictedByBand: Record<Band, string[]> = { HIGH: [], MEDIUM: [], LOW: [] };
  const scored = [];
  for (const p of candidates.pairs) {
    const left = byId.get(p.leftId);
    const right = byId.get(p.rightId);
    if (!left || !right) continue;
    const s = scorePair(left, right, cfg);
    scored.push(s);
    if (!s.eligible || s.confidence === "EXCLUDED") continue;
    const k = key(s.leftId, s.rightId);
    eligibleKeys.add(k);
    predictedByBand[s.confidence as Band].push(k);
  }

  const householdFalsePositives = [...householdPairs].filter((k) => eligibleKeys.has(k)).length;

  const bands: Band[] = ["HIGH", "MEDIUM", "LOW"];
  const byBand = {} as Record<Band, BandStats>;
  for (const band of bands) {
    const predicted = predictedByBand[band];
    const tp = predicted.filter((k) => truthDupPairs.has(k)).length;
    const precision = predicted.length === 0 ? 1 : tp / predicted.length;
    const recall = truthDupPairs.size === 0 ? 0 : tp / truthDupPairs.size;
    byBand[band] = { precision, recall, f1: f1(precision, recall) };
  }

  const clusters = formCluster(scored, cfg);

  return {
    candidateCount: candidates.pairs.length,
    truncated: candidates.truncated,
    byBand,
    recallAllSeeded,
    householdFalsePositives,
    clusterCount: clusters.length,
  };
}

async function main(): Promise<void> {
  const seed = Number(process.argv[2] ?? 1);
  const count = Number(process.argv[3] ?? 5000);
  const { cloneDefaultConfig } = await import("@/shared/config");
  const cfg = cloneDefaultConfig();
  const { rows, groundTruth } = generateFixture(seed, count);
  const r = runDogfood(rows, groundTruth, cfg);
  const pct = (n: number): string => (n * 100).toFixed(2) + "%";
  const lines = [
    `Dogfood report — seed=${seed}, rows=${count}`,
    `  candidateCount:          ${r.candidateCount} (cap ${cfg.blocking.maxTotalCandidates})`,
    `  truncated:               ${r.truncated}`,
    `  recallAllSeeded:         ${pct(r.recallAllSeeded)}`,
    `  householdFalsePositives: ${r.householdFalsePositives}`,
    `  clusters:                ${r.clusterCount}`,
    `  band   precision recall  f1`,
    ...(["HIGH", "MEDIUM", "LOW"] as Band[]).map(
      (b) =>
        `  ${b.padEnd(6)} ${pct(r.byBand[b].precision).padStart(8)} ${pct(
          r.byBand[b].recall,
        ).padStart(7)} ${pct(r.byBand[b].f1).padStart(7)}`,
    ),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("dogfoodReport.ts") || invokedPath.endsWith("dogfoodReport.js")) {
  void main();
}
