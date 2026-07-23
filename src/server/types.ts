import type {
  CanonicalField,
  Confidence,
  NameMatchMethod,
} from "@/shared/constants";

export type CellValue = string | number | boolean | null;

export interface SourceSchema {
  spreadsheetId: string;
  sheetId: number;
  sheetName: string;
  headerRow: number;
  headers: string[];
  normalizedHeaders: string[];
  columnByCanonicalField: Partial<Record<CanonicalField, number>>;
  extraColumns: Array<{ header: string; columnIndex: number }>;
  dedupIdColumnIndex: number;
  schemaHash: string;
}

export interface NormalizedName {
  firstTokens: string[];
  middleTokens: string[];
  lastTokens: string[];
  aliasTokens: string[];
  coreTokens: string[];
  orderedNoMiddle: string;
  reversedNoMiddle: string;
  sortedTokenSignature: string;
  initials: string[];
  missingCoreComponent: boolean;
}

export interface NormalizedAddress {
  full: string;
  houseNumber: string | null;
  streetTokens: string[];
  unit: string | null;
}

export type DobState = "VALID" | "MISSING" | "PLACEHOLDER" | "INVALID";

export interface NormalizedDob {
  value: string | null; // yyyy-MM-dd
  state: DobState;
}

export interface NormalizedParticipant {
  name: NormalizedName;
  dob: NormalizedDob;
  zip: string | null;
  address: NormalizedAddress | null;
  city: string | null;
  state: string | null;
  county: string | null;
  extras: Record<string, string | null>;
}

export interface RecordSnapshot {
  batchId: string;
  dedupId: string;
  sourceRowAtScan: number;
  rowFingerprint: string;
  relevantHash: string;
  rawValues: CellValue[];
  displayValues: string[];
  formulas: string[];
  valuesByHeader: Record<string, CellValue>;
  displayByHeader: Record<string, string>;
  normalized: NormalizedParticipant;
}

export interface PairScoreComponents {
  nameSimilarity: number;
  namePoints: number;
  dobPoints: number;
  addressSimilarity: number;
  addressPoints: number;
  zipPoints: number;
  contextPoints: number;
  penalties: number;
}

export interface PairScoreFlags {
  exactDirectName: boolean;
  exactReversal: boolean;
  nameOnly: boolean;
  dobExact: boolean;
  dobConflict: boolean;
  zipExact: boolean;
  addressStrong: boolean;
}

export interface PairScore {
  pairKey: string;
  leftId: string;
  rightId: string;
  eligible: boolean;
  totalScore: number;
  confidence: Confidence;
  nameMethod: NameMatchMethod;
  components: PairScoreComponents;
  flags: PairScoreFlags;
  reasons: string[];
  warnings: string[];
}

export type FieldChoice =
  | { mode: "AUTO"; sourceId: string }
  | { mode: "SOURCE"; sourceId: string }
  | { mode: "LEAVE_BLANK" };

export interface ClusterDecision {
  batchId: string;
  clusterId: string;
  expectedRevision: number;
  mode: "KEEP_ALL" | "SELECT_RECORDS" | "UNRESOLVED";
  retainedIds: string[];
  deleteAssignments: Record<string, string>; // deletedId -> retainedId
  fieldChoices: Record<string, Record<string, FieldChoice>>; // retainedId -> header -> choice
  notes: string;
  fallbackReviewerName?: string;
}
