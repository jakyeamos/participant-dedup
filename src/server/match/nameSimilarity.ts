import type { DedupConfig } from "@/shared/config";
import type { NormalizedName } from "@/server/types";
import type { NameMatchMethod } from "@/shared/constants";
import { jaroWinkler } from "./jaroWinkler";
import { softToken } from "./softToken";

export interface NameSimilarityResult {
  similarity: number;
  method: NameMatchMethod;
  exactDirect: boolean;
  exactReversal: boolean;
  likelyReversal: boolean;
  middleConflict: boolean;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function arraysEqual(x: string[], y: string[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Similarity between two token lists, or null when either side is empty. */
function componentSim(x: string[], y: string[]): number | null {
  if (x.length === 0 || y.length === 0) return null;
  return jaroWinkler(x.join(" "), y.join(" "));
}

/** Average of the present (first, last) component similarities. */
function weightedCore(
  aFirst: string[],
  aLast: string[],
  bFirst: string[],
  bLast: string[],
): number {
  const parts = [componentSim(aFirst, bFirst), componentSim(aLast, bLast)].filter(
    (v): v is number => v !== null,
  );
  if (parts.length === 0) return 0;
  return parts.reduce((s, v) => s + v, 0) / parts.length;
}

function aliasSimilarity(a: NormalizedName, b: NormalizedName): number {
  let best = 0;
  if (a.aliasTokens.length > 0) {
    best = Math.max(
      best,
      softToken([...a.aliasTokens, ...a.lastTokens], b.coreTokens).f1,
    );
  }
  if (b.aliasTokens.length > 0) {
    best = Math.max(
      best,
      softToken([...b.aliasTokens, ...b.lastTokens], a.coreTokens).f1,
    );
  }
  return best;
}

function middlesCompatible(am: string[], bm: string[]): boolean {
  if (arraysEqual(am, bm)) return true;
  const a0 = am[0]!;
  const b0 = bm[0]!;
  if (am.length === 1 && a0.length === 1 && b0[0] === a0) return true;
  if (bm.length === 1 && b0.length === 1 && a0[0] === b0) return true;
  return false;
}

function middleAdjustment(
  a: NormalizedName,
  b: NormalizedName,
): { adjustment: number; conflict: boolean } {
  if (a.middleTokens.length === 0 || b.middleTokens.length === 0) {
    return { adjustment: 0, conflict: false };
  }
  if (middlesCompatible(a.middleTokens, b.middleTokens)) {
    return { adjustment: 0.02, conflict: false };
  }
  return { adjustment: -0.03, conflict: true };
}

/**
 * §15.3 Name-component comparison. Blends direct, swapped, full-token, and
 * alias evidence, applies a bounded middle-name adjustment, caps at 0.88 when a
 * core component is missing (absent an exact full-token relationship), and
 * reports exact/likely reversal flags.
 */
export function nameSimilarity(
  a: NormalizedName,
  b: NormalizedName,
  _cfg: DedupConfig,
): NameSimilarityResult {
  const direct = weightedCore(a.firstTokens, a.lastTokens, b.firstTokens, b.lastTokens);
  const swapped = weightedCore(a.firstTokens, a.lastTokens, b.lastTokens, b.firstTokens);
  const tokenBlend =
    0.7 * softToken(a.coreTokens, b.coreTokens).f1 +
    0.3 *
      Math.max(
        jaroWinkler(a.orderedNoMiddle, b.orderedNoMiddle),
        jaroWinkler(a.orderedNoMiddle, b.reversedNoMiddle),
      );
  const alias = aliasSimilarity(a, b);

  const candidates: Array<{ method: NameMatchMethod; value: number }> = [
    { method: "DIRECT", value: direct },
    { method: "SWAPPED", value: swapped },
    { method: "TOKEN", value: tokenBlend },
    { method: "ALIAS", value: alias },
  ];
  let best = candidates[0]!;
  for (const c of candidates) {
    if (c.value > best.value) best = c;
  }

  const exactDirect =
    a.coreTokens.length > 0 &&
    arraysEqual(a.firstTokens, b.firstTokens) &&
    arraysEqual(a.lastTokens, b.lastTokens);
  const exactReversal =
    a.firstTokens.length > 0 &&
    a.lastTokens.length > 0 &&
    arraysEqual(a.firstTokens, b.lastTokens) &&
    arraysEqual(a.lastTokens, b.firstTokens);
  const likelyReversal = swapped >= 0.92 && swapped - direct >= 0.05;

  const middle = middleAdjustment(a, b);

  let similarity = best.value + middle.adjustment;
  similarity = clamp01(similarity);

  const missingCore = a.missingCoreComponent || b.missingCoreComponent;
  if (missingCore && !exactDirect && !exactReversal) {
    similarity = Math.min(similarity, 0.88);
  }

  const method: NameMatchMethod = exactReversal ? "SWAPPED" : best.method;

  return {
    similarity,
    method,
    exactDirect,
    exactReversal,
    likelyReversal,
    middleConflict: middle.conflict,
  };
}
