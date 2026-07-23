import type { DedupConfig } from "@/shared/config";
import type { NormalizedAddress } from "@/server/types";
import { softToken } from "./softToken";

export interface AddressSimilarityResult {
  similarity: number;
  houseNumberConflict: boolean;
}

const STRONG_STREET = 0.85;

function streetSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  return softToken(a, b).f1;
}

/** Unit compatibility: neutral (1) when either side is blank; 0 when both differ. */
function unitCompatibility(a: string | null, b: string | null): number {
  if (a === null || b === null) return 1;
  return a === b ? 1 : 0;
}

/**
 * §15.4 Address similarity. Exact normalized addresses score 1; same house
 * number plus similar street uses the additive band; a different house number
 * caps the score and, with strong street similarity, raises a house-number
 * conflict. A missing address on either side is a neutral zero.
 */
export function addressSimilarity(
  a: NormalizedAddress | null,
  b: NormalizedAddress | null,
  _cfg: DedupConfig,
): AddressSimilarityResult {
  if (a === null || b === null) {
    return { similarity: 0, houseNumberConflict: false };
  }
  if (a.full === b.full) {
    return { similarity: 1, houseNumberConflict: false };
  }

  const streetSim = streetSimilarity(a.streetTokens, b.streetTokens);
  const bothHouses = a.houseNumber !== null && b.houseNumber !== null;
  const sameHouse = bothHouses && a.houseNumber === b.houseNumber;
  const diffHouse = bothHouses && a.houseNumber !== b.houseNumber;

  let similarity: number;
  let houseNumberConflict = false;

  if (sameHouse) {
    const unit = unitCompatibility(a.unit, b.unit);
    similarity = 0.35 + 0.55 * streetSim + 0.1 * unit;
  } else if (diffHouse) {
    similarity = 0.4 * streetSim;
    houseNumberConflict = streetSim >= STRONG_STREET;
  } else {
    // House number missing on one side: treat as weak street-only evidence.
    similarity = 0.4 * streetSim;
  }

  return { similarity: Math.max(0, Math.min(1, similarity)), houseNumberConflict };
}
