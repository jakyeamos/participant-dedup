import type { CanonicalField } from "./constants";

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  headerSearchRows: 25,
  placeholderDates: ["1900-01-01"],
  missingLabels: ["", "unknown", "n/a", "na", "none", "null", "not available"],
  thresholds: {
    high: 80,
    medium: 60,
    low: 45,
    nameOnlySimilarity: 0.88,
    meaningfulNameSimilarity: 0.62,
    strongNameSimilarity: 0.82,
    veryStrongNameSimilarity: 0.88,
  },
  weights: {
    name: 60,
    dob: 25,
    address: 8,
    zip: 5,
    context: 2,
  },
  penalties: {
    dobConflict: 35,
    zipConflict: 2,
    addressConflict: 2,
    houseNumberConflict: 4,
  },
  blocking: {
    commonTokenBlockMax: 150,
    trigramPostingMax: 200,
    fuzzyOnlyCandidatesPerRecord: 100,
    maxTotalCandidates: 200000,
  },
  execution: {
    sliceBudgetMs: 25000,
    pairScoreChunkSize: 750,
    recordWriteChunkSize: 500,
    queuePageSize: 20,
    maxAtomicApplyRequests: 900,
  },
  retention: {
    terminalWorkingDataDays: 7,
  },
} as const;

export type DedupConfig = {
  -readonly [K in keyof typeof DEFAULT_CONFIG]: MutableDeep<(typeof DEFAULT_CONFIG)[K]>;
};

type Widen<T> = T extends number
  ? number
  : T extends string
    ? string
    : T extends boolean
      ? boolean
      : T;

type MutableDeep<T> = T extends readonly (infer U)[]
  ? MutableDeep<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: MutableDeep<T[K]> }
    : Widen<T>;

export function cloneDefaultConfig(): DedupConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as DedupConfig;
}

export const HEADER_ALIASES: Record<CanonicalField, string[]> = {
  first: ["first", "first name", "firstname", "given name", "given"],
  middle: ["middle", "middle name", "middlename", "middle initial"],
  last: ["last", "last name", "lastname", "surname", "family name"],
  dob: ["date of birth", "dob", "birth date", "birthdate"],
  address1: ["line1", "line 1", "address", "address 1", "street", "street address"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  county: ["county"],
  zip: ["zip", "zip code", "zipcode", "postal code", "postal"],
};
