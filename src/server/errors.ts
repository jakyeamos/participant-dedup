export type DedupErrorCode =
  | "HEADER_AMBIGUOUS"
  | "MISSING_REQUIRED_HEADERS"
  | "DUPLICATE_HEADERS"
  | "DUPLICATE_DEDUP_ID"
  | "STALE_ROW"
  | "REVISION_CONFLICT"
  | "SUMMARY_HASH_CHANGED"
  | "LOCK_TIMEOUT"
  | "ATOMIC_REQUEST_TOO_LARGE"
  | "UNRESOLVED_CONFLICT"
  | "DUPLICATE_APPLY"
  | "BATCH_ALREADY_ACTIVE"
  | "BATCH_STATE_CONFLICT"
  | "BATCH_NOT_FOUND"
  | "CLUSTER_NOT_FOUND"
  | "MISSING_REVIEWER_IDENTITY"
  | "NOT_CONFIRMED"
  | "SCHEMA_CHANGED"
  | "INTERNAL";

const SAFE_MESSAGES: Record<DedupErrorCode, string> = {
  HEADER_AMBIGUOUS:
    "Could not determine a single header row. Please make the header row unambiguous.",
  MISSING_REQUIRED_HEADERS:
    "The sheet is missing required First and Last name headers.",
  DUPLICATE_HEADERS: "The header row contains duplicate column names.",
  DUPLICATE_DEDUP_ID:
    "Duplicate participant IDs were found. Repair IDs before scanning.",
  STALE_ROW:
    "A source row changed after the scan. Re-scan before applying changes.",
  REVISION_CONFLICT:
    "This item changed since you loaded it. Reload and try again.",
  SUMMARY_HASH_CHANGED:
    "The batch changed since the summary was generated. Review again.",
  LOCK_TIMEOUT: "Another operation is in progress. Please try again shortly.",
  ATOMIC_REQUEST_TOO_LARGE:
    "This apply operation is too large to complete atomically. Split it into smaller applies.",
  UNRESOLVED_CONFLICT:
    "This cluster has unresolved conflicts and cannot be applied.",
  DUPLICATE_APPLY: "These changes were already applied.",
  BATCH_ALREADY_ACTIVE:
    "Another scan is already active. Resume or cancel it first.",
  BATCH_STATE_CONFLICT:
    "The scan is not in a state that allows this step. Refresh and try again.",
  BATCH_NOT_FOUND: "The requested scan batch could not be found.",
  CLUSTER_NOT_FOUND: "The requested cluster could not be found.",
  MISSING_REVIEWER_IDENTITY:
    "A reviewer name is required because your account email is unavailable.",
  NOT_CONFIRMED: "The confirmation checkbox must be checked before applying.",
  SCHEMA_CHANGED:
    "The sheet structure changed since the scan. Re-scan before continuing.",
  INTERNAL: "An unexpected error occurred.",
};

/**
 * §6.2 Whether repeating the same call unchanged could succeed. Only contention
 * and unexpected failures qualify: every other code names a condition the
 * reviewer has to change first — a decision, a reload, a re-scan — so an
 * identical retry would fail identically and the sidebar should not offer one.
 *
 * INTERNAL is retryable because a transient Sheets or Apps Script failure
 * reaches us as an unknown throw, and every mutation is guarded by either the
 * document lock or a replay check (DUPLICATE_APPLY, the apply challenge token),
 * so repeating one cannot double-apply.
 */
const RETRYABLE: Record<DedupErrorCode, boolean> = {
  HEADER_AMBIGUOUS: false,
  MISSING_REQUIRED_HEADERS: false,
  DUPLICATE_HEADERS: false,
  DUPLICATE_DEDUP_ID: false,
  STALE_ROW: false,
  REVISION_CONFLICT: false,
  SUMMARY_HASH_CHANGED: false,
  LOCK_TIMEOUT: true,
  ATOMIC_REQUEST_TOO_LARGE: false,
  UNRESOLVED_CONFLICT: false,
  DUPLICATE_APPLY: false,
  BATCH_ALREADY_ACTIVE: false,
  BATCH_STATE_CONFLICT: false,
  BATCH_NOT_FOUND: false,
  CLUSTER_NOT_FOUND: false,
  MISSING_REVIEWER_IDENTITY: false,
  NOT_CONFIRMED: false,
  SCHEMA_CHANGED: false,
  INTERNAL: true,
};

export function isRetryable(code: DedupErrorCode): boolean {
  return RETRYABLE[code];
}

export function safeMessageFor(code: DedupErrorCode): string {
  return SAFE_MESSAGES[code];
}

export class DedupError extends Error {
  readonly code: DedupErrorCode;

  constructor(code: DedupErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "DedupError";
    this.code = code;
    Object.setPrototypeOf(this, DedupError.prototype);
  }

  get safeMessage(): string {
    return SAFE_MESSAGES[this.code];
  }
}

export function isDedupError(value: unknown): value is DedupError {
  return value instanceof DedupError;
}
