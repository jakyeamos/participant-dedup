import type { DedupConfig } from "@/shared/config";
import type {
  NormalizedParticipant,
  PairScore,
  RecordSnapshot,
} from "@/server/types";
import type { Confidence, NameMatchMethod } from "@/shared/constants";
import { nameSimilarity } from "./nameSimilarity";
import { addressSimilarity } from "./addressSimilarity";
import { contextSimilarity } from "./contextSimilarity";

const STRONG_ADDRESS = 0.85;
const NAME_ONLY_ADDRESS_MAX = 0.5;

function sortDedupe(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function dobExactValid(a: NormalizedParticipant, b: NormalizedParticipant): boolean {
  return (
    a.dob.state === "VALID" &&
    b.dob.state === "VALID" &&
    a.dob.value !== null &&
    a.dob.value === b.dob.value
  );
}

function dobConflict(a: NormalizedParticipant, b: NormalizedParticipant): boolean {
  return (
    a.dob.state === "VALID" &&
    b.dob.state === "VALID" &&
    a.dob.value !== b.dob.value
  );
}

/** True when both middles are present and at least one is a single-character initial. */
function hasInitialMiddle(a: NormalizedParticipant, b: NormalizedParticipant): boolean {
  const am = a.name.middleTokens;
  const bm = b.name.middleTokens;
  if (am.length === 0 || bm.length === 0) return false;
  const aInit = am.length === 1 && am[0]!.length === 1;
  const bInit = bm.length === 1 && bm[0]!.length === 1;
  return aInit || bInit;
}

/**
 * §16 Pair scoring. Combines name, DOB, address, ZIP, and context evidence into
 * base points and penalties, decides eligibility (§16.2–§16.4), assigns a
 * confidence level (§16.5), and emits deterministically sorted, de-duplicated
 * reason and warning codes (§16.6). Pure: consumes only normalized snapshots.
 */
export function scorePair(
  a: RecordSnapshot,
  b: RecordSnapshot,
  cfg: DedupConfig,
): PairScore {
  const na = a.normalized;
  const nb = b.normalized;
  const { weights, penalties, thresholds } = cfg;

  const nameRes = nameSimilarity(na.name, nb.name, cfg);
  const addrRes = addressSimilarity(na.address, nb.address, cfg);
  const nameSim = nameRes.similarity;
  const addressSim = addrRes.similarity;
  const contextPtsRaw = contextSimilarity(na, nb);

  const dobExact = dobExactValid(na, nb);
  const dobConf = dobConflict(na, nb);
  const zipExact = na.zip !== null && na.zip === nb.zip;
  const zipConflict = na.zip !== null && nb.zip !== null && na.zip !== nb.zip;
  const bothAddresses = na.address !== null && nb.address !== null;
  const addressStrong = addressSim >= STRONG_ADDRESS;

  // §16.1 base points.
  const namePoints = Math.round(nameSim * weights.name);
  const dobPoints = dobExact ? weights.dob : 0;
  const addressPoints = Math.round(addressSim * weights.address);
  const zipPoints = zipExact ? weights.zip : zipConflict ? -penalties.zipConflict : 0;
  const contextPoints = Math.min(weights.context, Math.round(contextPtsRaw));

  const differentAddress =
    bothAddresses && addressSim < NAME_ONLY_ADDRESS_MAX && na.address!.full !== nb.address!.full;

  let penaltyTotal = 0;
  if (dobConf) penaltyTotal += penalties.dobConflict;
  if (addrRes.houseNumberConflict) penaltyTotal += penalties.houseNumberConflict;
  else if (differentAddress) penaltyTotal += penalties.addressConflict;

  const totalScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        namePoints + dobPoints + addressPoints + zipPoints + contextPoints - penaltyTotal,
      ),
    ),
  );

  // Meaningful contextual support: agreeing city+state (or richer).
  const meaningfulContext = contextPtsRaw >= 1;
  const exactNameRelationship = nameRes.exactDirect || nameRes.exactReversal;
  const reversal = nameRes.exactReversal || nameRes.likelyReversal;

  // DOB agreement is identity-level evidence; a shared address/ZIP is only a
  // household signal, so it demands a stronger name before a pair is eligible
  // (§16.2 — families share addresses, not identities).
  const identitySupport = dobExact;
  const householdSupport =
    (zipExact && addressSim >= 0.6) || addressSim >= STRONG_ADDRESS;
  const strongAlias = nameRes.method === "ALIAS" && nameSim >= thresholds.strongNameSimilarity;

  // §16.4 name-only: name is the sole evidence.
  const nameOnly =
    !dobExact &&
    !zipExact &&
    addressSim < NAME_ONLY_ADDRESS_MAX &&
    !meaningfulContext;

  // §16.2 eligibility, with the §16.3 DOB-conflict exception.
  let eligible: boolean;
  if (dobConf) {
    eligible =
      nameSim >= thresholds.veryStrongNameSimilarity + 0.04 &&
      (zipExact || addressSim >= 0.75);
  } else {
    eligible =
      nameSim >= thresholds.nameOnlySimilarity ||
      (nameSim >= thresholds.meaningfulNameSimilarity && identitySupport) ||
      (nameSim >= thresholds.strongNameSimilarity && householdSupport) ||
      (dobExact && nameSim >= 0.52) ||
      (reversal && nameSim >= thresholds.strongNameSimilarity) ||
      (strongAlias && (dobExact || zipExact || addressSim >= 0.5));
  }

  // §16.4: name-only pairs need very strong names.
  if (nameOnly && nameSim < thresholds.nameOnlySimilarity) {
    eligible = false;
  }

  // §16.5 confidence assignment.
  let confidence: Confidence;
  if (!eligible) {
    confidence = "EXCLUDED";
  } else if (dobConf || nameOnly) {
    confidence = "LOW";
  } else {
    const strongContext = contextPtsRaw >= weights.context;
    // Exact/reversed name plus household support is enough for High structurally —
    // placeholder/missing DOB must not block that band (flagged separately below).
    const highSupport =
      nameSim >= thresholds.strongNameSimilarity &&
      (dobExact ||
        (zipExact && addressSim >= 0.55) ||
        (exactNameRelationship && (zipExact || addressStrong || strongContext)));
    const dobNonEvidence = !dobExact && !dobConf;
    const meetsHighScore =
      totalScore >= thresholds.high ||
      (dobNonEvidence &&
        highSupport &&
        totalScore >= thresholds.medium &&
        totalScore + weights.dob >= thresholds.high);
    const highOk = highSupport && meetsHighScore;
    const mediumOk =
      totalScore >= thresholds.medium &&
      (nameSim >= 0.7 || dobExact || nameRes.exactReversal || nameRes.likelyReversal);
    if (highOk) confidence = "HIGH";
    else if (mediumOk) confidence = "MEDIUM";
    else if (totalScore >= thresholds.low) confidence = "LOW";
    else confidence = "EXCLUDED";
  }

  // §16.6 reason and warning codes.
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (nameRes.exactDirect) reasons.push("EXACT_NAME");
  if (dobExact) reasons.push("EXACT_DOB");
  if (nameRes.exactReversal) reasons.push("FIRST_LAST_REVERSED");
  else if (nameRes.likelyReversal) reasons.push("LIKELY_FIRST_LAST_REVERSED");
  if (
    !nameRes.exactDirect &&
    !nameRes.exactReversal &&
    nameSim >= thresholds.strongNameSimilarity &&
    nameSim < 1 &&
    (nameRes.method === "DIRECT" || nameRes.method === "TOKEN")
  ) {
    reasons.push("LIKELY_NAME_TYPO");
  }
  if (
    !nameRes.exactDirect &&
    !nameRes.exactReversal &&
    na.name.sortedTokenSignature.length > 0 &&
    na.name.sortedTokenSignature === nb.name.sortedTokenSignature &&
    na.name.orderedNoMiddle !== nb.name.orderedNoMiddle
  ) {
    reasons.push("NAME_TOKENS_REORDERED");
  }
  if (
    (na.name.aliasTokens.length > 0 || nb.name.aliasTokens.length > 0) &&
    nameRes.method === "ALIAS"
  ) {
    reasons.push("PARENTHETICAL_ALIAS");
  }
  if ((na.name.middleTokens.length > 0) !== (nb.name.middleTokens.length > 0)) {
    reasons.push("MIDDLE_NAME_MISSING");
  }
  if (!nameRes.middleConflict && hasInitialMiddle(na, nb)) {
    reasons.push("MIDDLE_INITIAL_MATCH");
  }
  if (zipExact) reasons.push("SAME_ZIP");
  if (bothAddresses && addressSim >= 0.6) reasons.push("SIMILAR_ADDRESS");
  if (na.city !== null && na.city === nb.city && na.state !== null && na.state === nb.state) {
    reasons.push("SAME_CITY_STATE");
  }
  for (const key of Object.keys(na.extras)) {
    const av = na.extras[key];
    if (av !== null && av !== undefined && av === nb.extras[key]) {
      reasons.push("EXTRA_FIELD_AGREEMENT");
      break;
    }
  }

  if (dobConf) warnings.push("CONFLICTING_VALID_DOB");
  if (eligible && nameOnly) warnings.push("NAME_ONLY_MATCH");
  if (zipConflict) warnings.push("DIFFERENT_ZIP");
  if (differentAddress) warnings.push("DIFFERENT_ADDRESS");
  if (addrRes.houseNumberConflict) warnings.push("HOUSE_NUMBER_CONFLICT");
  if (nameRes.middleConflict) warnings.push("MIDDLE_NAME_CONFLICT");
  if (
    (zipExact || addressStrong) &&
    nameSim < thresholds.meaningfulNameSimilarity
  ) {
    warnings.push("SAME_HOUSEHOLD_ONLY");
  }
  if (na.name.missingCoreComponent || nb.name.missingCoreComponent) {
    warnings.push("INCOMPLETE_SOURCE_DATA");
  }
  if (na.dob.state === "INVALID" || nb.dob.state === "INVALID") {
    warnings.push("INVALID_DOB");
  }
  if (na.dob.state === "PLACEHOLDER" || nb.dob.state === "PLACEHOLDER") {
    warnings.push("PLACEHOLDER_DOB");
  }

  const nameMethod: NameMatchMethod = nameRes.method;
  const pairKey = [a.dedupId, b.dedupId].sort().join("|");

  return {
    pairKey,
    leftId: a.dedupId,
    rightId: b.dedupId,
    eligible,
    totalScore,
    confidence,
    nameMethod,
    components: {
      nameSimilarity: nameSim,
      namePoints,
      dobPoints,
      addressSimilarity: addressSim,
      addressPoints,
      zipPoints,
      contextPoints,
      penalties: penaltyTotal,
    },
    flags: {
      exactDirectName: nameRes.exactDirect,
      exactReversal: nameRes.exactReversal,
      nameOnly,
      dobExact,
      dobConflict: dobConf,
      zipExact,
      addressStrong,
    },
    reasons: sortDedupe(reasons),
    warnings: sortDedupe(warnings),
  };
}
