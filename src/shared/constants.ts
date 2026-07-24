export const SYSTEM_SHEET_PREFIX = "_Dedup_";

export const SYSTEM_SHEETS = {
  config: "_Dedup_Config",
  batches: "_Dedup_Batches",
  records: "_Dedup_Records",
  pairs: "_Dedup_Pairs",
  clusters: "_Dedup_Clusters",
  state: "_Dedup_State",
  audit: "_Dedup_Audit",
} as const;

export const DEDUP_ID_HEADER = "_Dedup_ID";

export const CANONICAL_FIELDS = [
  "first",
  "middle",
  "last",
  "dob",
  "address1",
  "city",
  "state",
  "county",
  "zip",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export const REQUIRED_CANONICAL_FIELDS = ["first", "last"] as const;

export const POSITIVE_REASONS = [
  "EXACT_NAME",
  "EXACT_DOB",
  "FIRST_LAST_REVERSED",
  "LIKELY_FIRST_LAST_REVERSED",
  "LIKELY_NAME_TYPO",
  "NAME_TOKENS_REORDERED",
  "PARENTHETICAL_ALIAS",
  "MIDDLE_NAME_MISSING",
  "MIDDLE_INITIAL_MATCH",
  "SAME_ZIP",
  "SIMILAR_ADDRESS",
  "SAME_CITY_STATE",
  "EXTRA_FIELD_AGREEMENT",
] as const;

export type PositiveReason = (typeof POSITIVE_REASONS)[number];

export const WARNINGS = [
  "CONFLICTING_VALID_DOB",
  "NAME_ONLY_MATCH",
  "DIFFERENT_ZIP",
  "DIFFERENT_ADDRESS",
  "HOUSE_NUMBER_CONFLICT",
  "MIDDLE_NAME_CONFLICT",
  "SAME_HOUSEHOLD_ONLY",
  "INCOMPLETE_SOURCE_DATA",
  "INVALID_DOB",
  "PLACEHOLDER_DOB",
  "POSSIBLE_CHAIN_CLUSTER",
  "CANDIDATE_TRUNCATION",
  "FORMULA_FIELD_SKIPPED",
] as const;

export type Warning = (typeof WARNINGS)[number];

export const BATCH_STATUSES = [
  "INITIALIZING",
  "SNAPSHOTTING",
  "GENERATING_CANDIDATES",
  "SCORING",
  "CLUSTERING",
  "READY",
  "PAUSED",
  "APPLYING",
  "APPLIED",
  "CANCELLED",
  "FAILED",
  "SUPERSEDED",
] as const;

export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const NONTERMINAL_BATCH_STATUSES: readonly BatchStatus[] = [
  "INITIALIZING",
  "SNAPSHOTTING",
  "GENERATING_CANDIDATES",
  "SCORING",
  "CLUSTERING",
  "READY",
  "PAUSED",
  "APPLYING",
];

export const CLUSTER_STATUSES = [
  "UNREVIEWED",
  "IN_PROGRESS",
  "READY_TO_APPLY",
  "KEEP_ALL",
  "UNRESOLVED",
  "STALE",
  "APPLIED",
  "APPLY_ERROR",
] as const;

export type ClusterStatus = (typeof CLUSTER_STATUSES)[number];

export const CLUSTER_TYPES = ["CORE", "CORE_WITH_SUGGESTIONS", "LOW_PAIR"] as const;

export type ClusterType = (typeof CLUSTER_TYPES)[number];

export const AUDIT_EVENT_TYPES = [
  "SCAN_STARTED",
  "SCAN_COMPLETED",
  "SCAN_FAILED",
  // §20.6 A cancel is not a failure: the batch ends by request, not by error.
  "SCAN_CANCELLED",
  "ID_ASSIGNED",
  "ID_REPAIRED",
  "CLUSTER_REVIEWED",
  "KEEP_ALL_SAVED",
  "DECISION_CHANGED",
  "APPLY_ATTEMPTED",
  "FIELD_FILLED",
  "ROW_DELETED",
  "CLUSTER_APPLIED",
  "APPLY_COMPLETED",
  "APPLY_FAILED",
  "APPLY_SKIPPED",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW", "EXCLUDED"] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const NAME_MATCH_METHODS = ["DIRECT", "SWAPPED", "TOKEN", "ALIAS"] as const;

export type NameMatchMethod = (typeof NAME_MATCH_METHODS)[number];

export const TITLE_TOKENS = ["mr", "mrs", "ms", "dr", "mx"] as const;

export const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  street: "st",
  avenue: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  place: "pl",
  parkway: "pkwy",
  highway: "hwy",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  apartment: "unit",
  apt: "unit",
  "#": "unit",
};

export const US_STATES: Record<string, string> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  "district of columbia": "dc",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
};
