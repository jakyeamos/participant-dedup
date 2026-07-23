import { jaroWinkler } from "./jaroWinkler";

export interface SoftTokenResult {
  precision: number;
  recall: number;
  f1: number;
  matches: Array<[string, string]>;
}

const FUZZY_THRESHOLD = 0.88;
const MIN_FUZZY_LENGTH = 3;

interface Candidate {
  i: number;
  j: number;
  sim: number;
}

/**
 * §15.2 Soft token similarity. Exact token matches score 1.0; non-exact tokens
 * longer than two characters may match via Jaro-Winkler at or above 0.88.
 * Matches are assigned greedily from highest similarity down, using each token
 * at most once, then precision / recall / F1 are computed from the accepted
 * (similarity-weighted) matches.
 */
export function softToken(a: string[], b: string[]): SoftTokenResult {
  if (a.length === 0 || b.length === 0) {
    return { precision: 0, recall: 0, f1: 0, matches: [] };
  }

  const candidates: Candidate[] = [];
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      const ai = a[i]!;
      const bj = b[j]!;
      if (ai === bj) {
        candidates.push({ i, j, sim: 1 });
        continue;
      }
      if (ai.length >= MIN_FUZZY_LENGTH && bj.length >= MIN_FUZZY_LENGTH) {
        const sim = jaroWinkler(ai, bj);
        if (sim >= FUZZY_THRESHOLD) candidates.push({ i, j, sim });
      }
    }
  }

  candidates.sort((x, y) => y.sim - x.sim);

  const usedA = new Array<boolean>(a.length).fill(false);
  const usedB = new Array<boolean>(b.length).fill(false);
  const matches: Array<[string, string]> = [];
  let weight = 0;

  for (const c of candidates) {
    if (usedA[c.i] || usedB[c.j]) continue;
    usedA[c.i] = true;
    usedB[c.j] = true;
    matches.push([a[c.i]!, b[c.j]!]);
    weight += c.sim;
  }

  const precision = weight / b.length;
  const recall = weight / a.length;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1, matches };
}
