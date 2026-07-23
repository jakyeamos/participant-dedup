import type { DedupConfig } from "@/shared/config";
import type { RecordSnapshot } from "@/server/types";

export interface CandidatePair {
  leftId: string;
  rightId: string;
}

export interface CandidateResult {
  pairs: CandidatePair[];
  truncated: boolean;
}

const TRIGRAM_PAD = "##";
const MIN_TRIGRAM_TOKEN_LENGTH = 3;
const MIN_SHARED_TRIGRAMS = 2;
const MIN_TRIGRAM_RATIO = 0.3;

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/** §14.2 Padded three-character grams for a token (short tokens still gram via padding). */
function trigrams(token: string): string[] {
  if (token.length < MIN_TRIGRAM_TOKEN_LENGTH) return [];
  const padded = TRIGRAM_PAD + token + TRIGRAM_PAD;
  const grams: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i++) grams.push(padded.slice(i, i + 3));
  return uniq(grams);
}

function pushIndex(index: Map<string, number[]>, key: string, i: number): void {
  const list = index.get(key);
  if (list) list.push(i);
  else index.set(key, [i]);
}

interface Support {
  exact: boolean;
  sharedTrigrams: number;
  minGramCount: number;
}

/**
 * §14 Candidate generation. Blocks records over exact DOB, sorted full-name
 * signature, name tokens, ZIP-plus-initial, house-number-plus-initial, and name
 * trigrams, gathering only forward pairs (j > i). Oversized exact-token blocks
 * are retained only when another signal co-occurs (§14.4); fuzzy-only trigram
 * candidates are capped per record (§14.5); the global cap flips a never-silent
 * `truncated` flag (§14.5). Pure over normalized snapshots.
 */
export function generateCandidates(
  records: RecordSnapshot[],
  cfg: DedupConfig,
): CandidateResult {
  const { commonTokenBlockMax, trigramPostingMax, fuzzyOnlyCandidatesPerRecord, maxTotalCandidates } =
    cfg.blocking;

  const dobIndex = new Map<string, number[]>();
  const sortedNameIndex = new Map<string, number[]>();
  const tokenIndex = new Map<string, number[]>();
  const zipInitialIndex = new Map<string, number[]>();
  const houseInitialIndex = new Map<string, number[]>();
  const trigramIndex = new Map<string, number[]>();
  const recordTrigrams: string[][] = [];

  records.forEach((record, i) => {
    const n = record.normalized;
    const name = n.name;

    if (n.dob.state === "VALID" && n.dob.value !== null) {
      pushIndex(dobIndex, n.dob.value, i);
    }
    if (name.sortedTokenSignature.length > 0) {
      pushIndex(sortedNameIndex, name.sortedTokenSignature, i);
    }
    for (const token of uniq(name.coreTokens)) {
      pushIndex(tokenIndex, token, i);
    }
    for (const initial of name.initials) {
      if (n.zip !== null) pushIndex(zipInitialIndex, `${n.zip}|${initial}`, i);
      if (n.address?.houseNumber != null) {
        pushIndex(houseInitialIndex, `${n.address.houseNumber}|${initial}`, i);
      }
    }
    const grams = uniq(name.coreTokens.flatMap(trigrams));
    recordTrigrams.push(grams);
    for (const gram of grams) pushIndex(trigramIndex, gram, i);
  });

  const pairs: CandidatePair[] = [];
  let truncated = false;

  // Exact blocks contribute strong-support pairs; oversized token blocks are
  // deferred so they only survive when another signal co-occurs (§14.4).
  const addExact = (support: Map<number, Support>, j: number): void => {
    const existing = support.get(j);
    if (existing) existing.exact = true;
    else support.set(j, { exact: true, sharedTrigrams: 0, minGramCount: 0 });
  };

  for (let i = 0; i < records.length && !truncated; i++) {
    const n = records[i]!.normalized;
    const name = n.name;
    const support = new Map<number, Support>();
    // Weak co-occurrence from oversized token blocks: only promoted when the
    // pair also shares another signal.
    const weakToken = new Set<number>();

    const consumeExactBlock = (index: Map<string, number[]>, key: string): void => {
      const list = index.get(key);
      if (!list) return;
      for (const j of list) if (j > i) addExact(support, j);
    };

    if (n.dob.state === "VALID" && n.dob.value !== null) {
      consumeExactBlock(dobIndex, n.dob.value);
    }
    if (name.sortedTokenSignature.length > 0) {
      consumeExactBlock(sortedNameIndex, name.sortedTokenSignature);
    }
    for (const token of uniq(name.coreTokens)) {
      const list = tokenIndex.get(token);
      if (!list) continue;
      if (list.length > commonTokenBlockMax) {
        for (const j of list) if (j > i) weakToken.add(j);
      } else {
        for (const j of list) if (j > i) addExact(support, j);
      }
    }
    for (const initial of name.initials) {
      if (n.zip !== null) consumeExactBlock(zipInitialIndex, `${n.zip}|${initial}`);
      if (n.address?.houseNumber != null) {
        consumeExactBlock(houseInitialIndex, `${n.address.houseNumber}|${initial}`);
      }
    }

    // Trigram overlap (§14.2): count shared grams, skipping over-posted grams.
    const gramCounts = new Map<number, number>();
    for (const gram of recordTrigrams[i]!) {
      const posting = trigramIndex.get(gram);
      if (!posting || posting.length > trigramPostingMax) continue;
      for (const j of posting) {
        if (j > i) gramCounts.set(j, (gramCounts.get(j) ?? 0) + 1);
      }
    }
    for (const [j, shared] of gramCounts) {
      if (shared < MIN_SHARED_TRIGRAMS) continue;
      const minGrams = Math.min(recordTrigrams[i]!.length, recordTrigrams[j]!.length);
      if (minGrams === 0 || shared / minGrams < MIN_TRIGRAM_RATIO) continue;
      const existing = support.get(j);
      if (existing) {
        existing.sharedTrigrams = shared;
        existing.minGramCount = minGrams;
      } else {
        support.set(j, { exact: false, sharedTrigrams: shared, minGramCount: minGrams });
      }
    }

    // Promote weak-token pairs only when another signal co-occurs.
    for (const j of weakToken) {
      if (support.has(j)) support.get(j)!.exact = true;
    }

    // Split into strong-support (kept) and fuzzy-only (capped).
    const strong: number[] = [];
    const fuzzy: number[] = [];
    for (const [j, s] of support) {
      if (s.exact) strong.push(j);
      else if (s.sharedTrigrams >= MIN_SHARED_TRIGRAMS) fuzzy.push(j);
    }
    // §14.5 fuzzy-only cap, ranked by shared-gram ratio (cheap pre-score).
    fuzzy.sort((x, y) => {
      const sx = support.get(x)!;
      const sy = support.get(y)!;
      return sy.sharedTrigrams / sy.minGramCount - sx.sharedTrigrams / sx.minGramCount;
    });
    const keptFuzzy = fuzzy.slice(0, fuzzyOnlyCandidatesPerRecord);

    for (const j of [...strong, ...keptFuzzy]) {
      if (pairs.length >= maxTotalCandidates) {
        truncated = true;
        break;
      }
      pairs.push({ leftId: records[i]!.dedupId, rightId: records[j]!.dedupId });
    }
    if (truncated) break;
  }

  return { pairs, truncated };
}
