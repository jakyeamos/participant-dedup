# Technical Design Specification
## Fuzzy Participant Deduplication for Google Sheets

**Version:** 1.0  
**Status:** Ready for implementation  
**Target:** Container-bound Google Apps Script attached to the participant workbook  
**Primary implementation language:** TypeScript compiled to Apps Script-compatible JavaScript  
**Review interface:** Google Sheets sidebar  
**Source scope:** One selected sheet per scan  
**Target scale:** Fewer than 5,000 participant rows  
**Deletion policy:** Human-approved, batch-applied, permanent removal from the participant sheet  

---

## 1. Purpose

This document translates the approved product requirements into an implementation-ready design for Codex or another engineer. It defines:

- The project and module structure.
- Google Apps Script entry points.
- Internal data models and hidden-sheet schemas.
- Header discovery and stable-record identification.
- Normalization, candidate generation, fuzzy scoring, and clustering.
- The sidebar review workflow and server RPC contracts.
- Blank-field merge behavior.
- Stale-data, concurrency, and idempotency controls.
- Atomic application of field fills, row deletions, queue updates, and audit events.
- Testing, deployment, and completion criteria.

The implementation must not use real participant data in source control, test fixtures, console logs, or error messages.

---

## 2. Approved Requirements That Must Not Be Changed

1. Scan only the active, user-selected source sheet.
2. Match using all available participant fields, with names as the principal identity signal.
3. Support misspellings, missing middle names, parenthetical aliases, reordered name tokens, and swapped first/last fields.
4. Treat `01/01/1900` as an unknown birthdate.
5. Use High, Medium, and Low confidence labels.
6. Use balanced matching sensitivity.
7. Include sufficiently strong name-only matches only as Low confidence.
8. Allow conflicting valid birthdates only as Low confidence and show a prominent warning.
9. Form duplicate clusters; reviewers may retain one or more records.
10. Do not change source participant data during scanning or review, except to add or repair `_Dedup_ID` values.
11. Automatically fill only blank, non-conflicting, non-protected fields.
12. Never automatically fill or overwrite first name, middle name, last name, or date of birth.
13. Require manual selection when proposed values conflict.
14. Review through an Apps Script sidebar.
15. Show High and Medium candidates by default; Low is opt-in.
16. Launch scans from a custom Google Sheets menu.
17. Queue decisions and apply them in a separate batch flow.
18. Never automatically delete a row.
19. Permanently remove approved discarded rows from the participant sheet after confirmation.
20. Do not create a full-sheet backup or archive sheet before deletion.
21. Record reviewer and applying-user identity in change history.
22. Anyone with edit access may scan, review, and apply.
23. Suppress unchanged Keep All decisions until an involved record changes.
24. Support fewer than 5,000 participant rows.
25. Do not send participant data to third-party or external matching services.

### Important audit implication

The approved audit requirement stores a snapshot of each deleted row in `_Dedup_Audit`. Therefore, “permanent deletion” means removal from the participant source sheet, not complete erasure of the participant’s data from the workbook. There is no restore button or archive workflow in Version 1, but deleted-row snapshots remain in the hidden audit table for accountability.

---

## 3. Architecture Decision

### 3.1 Runtime architecture

Use a container-bound Google Apps Script project attached to the spreadsheet. It provides:

- A custom `Deduplication` menu.
- An HTML Service sidebar.
- Server-side Apps Script functions called asynchronously from the sidebar.
- Hidden system sheets for durable state.
- The Advanced Sheets service for atomic source changes and audit writes.

### 3.2 Source architecture

Use TypeScript locally for maintainability and unit testing. Bundle it into Apps Script-compatible JavaScript before pushing the project.

Production output should contain only:

- `Code.js`
- `Sidebar.html`
- `appsscript.json`

No third-party runtime library may execute inside Apps Script. Development dependencies are allowed for compilation, type checking, testing, and deployment.

### 3.3 Why the Advanced Sheets service is required

The production apply path must combine all approved changes into one `spreadsheets.batchUpdate` request whenever the request remains within the configured safety limit. That request should contain:

1. Approved blank-field value copies.
2. Source-row deletions in descending row order.
3. Audit rows.
4. Cluster status updates.
5. Batch status updates.

The Sheets API validates the requests before applying them and applies a valid batch atomically. This is the strongest practical way to satisfy “no partially applied cluster” while permanently deleting rows and not creating a backup.

This design requires the broader `spreadsheets` OAuth scope rather than `spreadsheets.currentonly`. The code must still use only `SpreadsheetApp.getActive().getId()` and must never accept an arbitrary spreadsheet ID from the browser client.

### 3.4 No background scan trigger

Do not create time-driven continuation triggers. Instead, the sidebar calls a resumable server function sequentially:

- `rpcStartScan()` creates the scan batch.
- `rpcAdvanceScan()` performs one bounded work slice.
- The client calls `rpcAdvanceScan()` again until the batch reaches `READY`, `FAILED`, or `PAUSED`.
- If the sidebar closes, the menu item `Refresh Current Batch` reopens it and continues from the saved cursor.

This avoids trigger ownership problems, avoids an additional trigger scope, and ensures scans remain explicitly user initiated.

---

## 4. Repository Layout

```text
participant-dedup/
├── package.json
├── tsconfig.json
├── esbuild.mjs
├── appsscript.json
├── .clasp.json.example
├── .claspignore
├── .gitignore
├── README.md
├── src/
│   ├── server/
│   │   ├── globals.ts
│   │   ├── menu.ts
│   │   ├── rpc.ts
│   │   ├── config.ts
│   │   ├── errors.ts
│   │   ├── types.ts
│   │   ├── identity.ts
│   │   ├── hashing.ts
│   │   ├── systemSheets.ts
│   │   ├── schemaResolver.ts
│   │   ├── sourceRepository.ts
│   │   ├── batchRepository.ts
│   │   ├── recordRepository.ts
│   │   ├── pairRepository.ts
│   │   ├── clusterRepository.ts
│   │   ├── stateRepository.ts
│   │   ├── auditRepository.ts
│   │   ├── scan/
│   │   │   ├── scanOrchestrator.ts
│   │   │   ├── snapshotPhase.ts
│   │   │   ├── candidatePhase.ts
│   │   │   ├── scoringPhase.ts
│   │   │   ├── clusterPhase.ts
│   │   │   └── executionBudget.ts
│   │   ├── match/
│   │   │   ├── textNormalization.ts
│   │   │   ├── nameNormalization.ts
│   │   │   ├── dateNormalization.ts
│   │   │   ├── addressNormalization.ts
│   │   │   ├── jaroWinkler.ts
│   │   │   ├── tokenSimilarity.ts
│   │   │   ├── candidateGenerator.ts
│   │   │   └── scorer.ts
│   │   ├── review/
│   │   │   ├── reviewService.ts
│   │   │   ├── mergePlanner.ts
│   │   │   └── suppressionService.ts
│   │   └── apply/
│   │       ├── applyService.ts
│   │       ├── preflight.ts
│   │       ├── sheetsRequestBuilder.ts
│   │       └── applyChallenge.ts
│   └── client/
│       ├── Sidebar.template.html
│       ├── sidebar.ts
│       └── sidebar.css
├── test/
│   ├── fixtures.ts
│   ├── normalization.test.ts
│   ├── jaroWinkler.test.ts
│   ├── candidateGenerator.test.ts
│   ├── scorer.test.ts
│   ├── clusterer.test.ts
│   ├── mergePlanner.test.ts
│   ├── fingerprints.test.ts
│   ├── sheetsRequestBuilder.test.ts
│   └── acceptance.test.ts
└── dist/
    ├── Code.js
    ├── Sidebar.html
    └── appsscript.json
```

### 4.1 Build requirements

- Compile TypeScript with strict type checking.
- Bundle server code as an IIFE.
- Explicitly attach Apps Script entry points to `globalThis`.
- Bundle client JavaScript and CSS into `Sidebar.html`.
- Produce source maps locally, but do not push source maps to Apps Script.
- Run type checking, unit tests, and build before `clasp push`.

### 4.2 Suggested development dependencies

- `typescript`
- `esbuild`
- `vitest`
- `@types/google-apps-script`
- `@google/clasp`
- An optional linter and formatter

There must be no matching, UI, or data-processing package loaded at Apps Script runtime.

---

## 5. Apps Script Manifest

Use the following production manifest as the baseline:

```json
{
  "timeZone": "America/New_York",
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Sheets",
        "serviceId": "sheets",
        "version": "v4"
      }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.container.ui",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
```

### 5.1 Permission behavior

- All user-triggered operations must validate required scopes before starting.
- If Sheets permission is unavailable, return `AUTH_REQUIRED` rather than partially running.
- If the Advanced Sheets service is not enabled, return `ADVANCED_SHEETS_DISABLED` with setup instructions.
- The script must not request Drive, Gmail, Calendar, external-request, or other unrelated scopes.

---

## 6. Global Apps Script Entry Points

Only the following functions should be attached to `globalThis`:

```ts
onOpen
menuScanActiveSheet
menuOpenReviewSidebar
menuApplyReviewedDecisions
menuViewChangeHistory
menuRefreshCurrentBatch
rpcBootstrap
rpcStartScan
rpcAdvanceScan
rpcGetQueuePage
rpcGetCluster
rpcSaveClusterDecision
rpcGetBatchSummary
rpcCreateApplyChallenge
rpcApplyBatch
rpcGetAuditPage
rpcCancelCurrentBatch
rpcRepairDuplicateIds
rpcFocusSourceRow
```

All other functions remain private inside the bundle.

### 6.1 Menu definition

`onOpen()` creates:

```text
Deduplication
├── Scan Active Sheet
├── Open Review Sidebar
├── Refresh Current Batch
├── Apply Reviewed Decisions
├── View Change History
└── Repair Duplicate IDs
```

`Scan Active Sheet` opens the sidebar and begins or resumes a batch. It must not attempt to complete the full scan inside the menu callback.

### 6.2 RPC result envelope

Every RPC returns a serializable result:

```ts
type RpcResult<T> =
  | {
      ok: true;
      requestId: string;
      data: T;
    }
  | {
      ok: false;
      requestId: string;
      error: {
        code: ErrorCode;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
    };
```

Do not return JavaScript `Date`, `Map`, `Set`, class instances, functions, or Apps Script service objects to the browser. Convert dates to ISO strings and collections to arrays or plain objects.

### 6.3 Client call rule

The sidebar must make one `google.script.run` call at a time, with both success and failure handlers. Disable the initiating control until the call completes. Never launch concurrent scan slices.

---

## 7. Core Domain Models

Use TypeScript interfaces equivalent to the following.

### 7.1 Source schema

```ts
interface SourceSchema {
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

type CanonicalField =
  | 'first'
  | 'middle'
  | 'last'
  | 'dob'
  | 'address1'
  | 'city'
  | 'state'
  | 'county'
  | 'zip';
```

All column indexes inside the server domain should be zero based. Convert to one-based only at the Spreadsheet service boundary.

### 7.2 Record snapshot

```ts
interface RecordSnapshot {
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

type CellValue = string | number | boolean | null;
```

Dates must be serialized before storage. Never place a native `Date` in JSON.

### 7.3 Normalized participant

```ts
interface NormalizedParticipant {
  name: NormalizedName;
  dob: {
    value: string | null;        // yyyy-MM-dd
    state: 'VALID' | 'MISSING' | 'PLACEHOLDER' | 'INVALID';
  };
  zip: string | null;
  address: NormalizedAddress | null;
  city: string | null;
  state: string | null;
  county: string | null;
  extras: Record<string, string | null>;
}
```

### 7.4 Pair score

```ts
interface PairScore {
  pairKey: string;
  leftId: string;
  rightId: string;
  eligible: boolean;
  totalScore: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'EXCLUDED';
  nameMethod: NameMatchMethod;
  components: {
    nameSimilarity: number;
    namePoints: number;
    dobPoints: number;
    addressSimilarity: number;
    addressPoints: number;
    zipPoints: number;
    contextPoints: number;
    penalties: number;
  };
  flags: {
    exactDirectName: boolean;
    exactReversal: boolean;
    nameOnly: boolean;
    dobExact: boolean;
    dobConflict: boolean;
    zipExact: boolean;
    addressStrong: boolean;
  };
  reasons: string[];
  warnings: string[];
}
```

### 7.5 Cluster decision

```ts
interface ClusterDecision {
  batchId: string;
  clusterId: string;
  expectedRevision: number;
  mode: 'KEEP_ALL' | 'SELECT_RECORDS' | 'UNRESOLVED';
  retainedIds: string[];
  deleteAssignments: Record<string, string>; // deletedId -> retainedId
  fieldChoices: Record<
    string, // retainedId
    Record<
      string, // source header
      | { mode: 'AUTO'; sourceId: string }
      | { mode: 'SOURCE'; sourceId: string }
      | { mode: 'LEAVE_BLANK' }
    >
  >;
  notes: string;
  fallbackReviewerName?: string;
}
```

The server must reconstruct and validate the merge plan. It must never trust the browser’s assignments or proposed values without recalculation.

---

## 8. Hidden System Sheets

All system sheets:

- Start with `_Dedup_`.
- Are excluded from scans.
- Are hidden after creation.
- Use a warning-only protection where practical.
- Use a schema-version header.
- Are manipulated through repository modules, never directly from business logic.

Because all spreadsheet editors are allowed to apply changes, these sheets cannot be made cryptographically tamper-proof. The audit is operational change history, not a regulated immutable ledger.

### 8.1 `_Dedup_Config`

| Column | Purpose |
|---|---|
| `config_key` | Stable configuration key |
| `value_json` | JSON value |
| `description` | Human-readable description |
| `schema_version` | Config schema version |
| `updated_at` | ISO timestamp |
| `updated_by` | Email or fallback identity |

Seed defaults on first run. Version 1 has no end-user configuration editor.

### 8.2 `_Dedup_Batches`

| Column | Purpose |
|---|---|
| `batch_id` | Scan batch identifier |
| `source_spreadsheet_id` | Active spreadsheet ID |
| `source_sheet_id` | Numeric sheet ID |
| `source_sheet_name` | Name at scan time |
| `header_row` | Detected header row |
| `source_last_row` | Last row at snapshot |
| `source_last_col` | Last column at snapshot |
| `schema_json` | Serialized `SourceSchema` |
| `schema_hash` | Stale-data guard |
| `config_hash` | Scoring/config version used |
| `status` | Batch status |
| `phase` | Current scan phase |
| `phase_cursor` | Durable cursor |
| `record_count` | Snapshot record count |
| `candidate_count` | Generated pair count |
| `qualified_edge_count` | Qualifying pair count |
| `cluster_count` | Final queue count |
| `candidate_truncation_count` | Fuzzy-only candidates dropped by safety caps |
| `created_at` | ISO timestamp |
| `created_by` | Initiating identity |
| `updated_at` | ISO timestamp |
| `error_code` | Last terminal error code |
| `error_message` | User-safe error text |
| `revision` | Optimistic concurrency version |

Allowed statuses:

```text
INITIALIZING
SNAPSHOTTING
GENERATING_CANDIDATES
SCORING
CLUSTERING
READY
PAUSED
APPLYING
APPLIED
CANCELLED
FAILED
```

Only one nonterminal batch may exist per workbook. Starting a new scan while another batch is active must resume the current batch or require an explicit cancellation.

### 8.3 `_Dedup_Records`

| Column | Purpose |
|---|---|
| `batch_id` | Batch identifier |
| `dedup_id` | Stable participant row identifier |
| `source_row_at_scan` | Original one-based row number |
| `row_fingerprint` | Exact stale-data fingerprint |
| `relevant_hash` | Matching/suppression fingerprint |
| `raw_values_json` | Typed row values after serialization |
| `display_values_json` | Display strings, including ZIP formatting |
| `formulas_json` | Formula strings by column |
| `normalized_json` | Normalized participant representation |

This sheet remains available while a batch is under review. Purge terminal-batch rows according to the retention policy after audit events are safely written.

### 8.4 `_Dedup_Pairs`

| Column | Purpose |
|---|---|
| `batch_id` | Batch identifier |
| `pair_key` | Deterministic sorted-ID pair hash |
| `left_id` | First sorted record ID |
| `right_id` | Second sorted record ID |
| `generation_reasons_json` | Blocking rules that generated the pair |
| `pre_score` | Cheap ranking score |
| `score_status` | `PENDING`, `SCORED`, or `ERROR` |
| `score_json` | Serialized `PairScore` |
| `qualified` | Boolean |

Delete pair rows for a terminal scan after clusters have been finalized. They are temporary work data.

### 8.5 `_Dedup_Clusters`

| Column | Purpose |
|---|---|
| `batch_id` | Batch identifier |
| `cluster_id` | Deterministic cluster ID |
| `cluster_type` | `CORE`, `CORE_WITH_SUGGESTIONS`, or `LOW_PAIR` |
| `member_ids_json` | All displayed record IDs |
| `core_member_ids_json` | Members connected by High/Medium edges |
| `suggested_member_ids_json` | Low-confidence suggestions |
| `edge_keys_json` | Pair evidence used in the cluster |
| `highest_confidence` | Highest edge confidence |
| `max_score` | Highest numeric score |
| `warnings_json` | Cluster warnings |
| `status` | Review/apply state |
| `revision` | Optimistic concurrency version |
| `decision_json` | Validated decision and merge plan |
| `reviewer_id` | Email or fallback identity |
| `reviewed_at` | ISO timestamp |
| `notes` | Reviewer notes |
| `decision_hash` | Decision idempotency hash |
| `stale_reason` | Why the cluster is stale |
| `apply_batch_id` | Apply operation ID |
| `applied_at` | ISO timestamp |

Cluster statuses:

```text
UNREVIEWED
IN_PROGRESS
READY_TO_APPLY
KEEP_ALL
UNRESOLVED
STALE
APPLIED
APPLY_ERROR
```

### 8.6 `_Dedup_State`

| Column | Purpose |
|---|---|
| `state_type` | `SUPPRESSION`, `APPLY_CHALLENGE`, `SYSTEM`, etc. |
| `state_key` | Unique key within type |
| `value_json` | State payload |
| `created_at` | ISO timestamp |
| `updated_at` | ISO timestamp |

Keep All suppression rows use:

```ts
interface SuppressionState {
  suppressionKey: string;
  memberIds: string[];
  memberContentHash: string;
  configHash: string;
  reviewerId: string;
  reviewedAt: string;
}
```

### 8.7 `_Dedup_Audit`

Use one row per event rather than one row per cluster so history is filterable.

| Column | Purpose |
|---|---|
| `event_id` | UUID |
| `event_type` | Review, fill, deletion, apply, error, etc. |
| `event_at` | ISO timestamp in UTC |
| `actor_id` | Applying or acting identity |
| `actor_type` | `EMAIL` or `FALLBACK_NAME` |
| `reviewer_id` | Original reviewer identity, when relevant |
| `batch_id` | Scan batch ID |
| `apply_batch_id` | Apply operation ID |
| `cluster_id` | Cluster ID |
| `source_sheet_id` | Numeric source sheet ID |
| `source_sheet_name` | Source sheet name |
| `target_dedup_id` | Primary affected record |
| `related_ids_json` | Other involved records |
| `field_name` | Changed field, when relevant |
| `before_value_json` | Previous value |
| `after_value_json` | New value |
| `row_snapshot_json` | Deleted-row snapshot, when relevant |
| `confidence` | Cluster confidence |
| `score` | Numeric score |
| `reasons_json` | Match reasons |
| `warnings_json` | Match warnings |
| `result` | `SUCCESS`, `SKIPPED`, or `FAILED` |
| `error_code` | Error code, when relevant |
| `error_message` | User-safe error text |

Required event types:

```text
SCAN_STARTED
SCAN_COMPLETED
SCAN_FAILED
ID_ASSIGNED
ID_REPAIRED
CLUSTER_REVIEWED
KEEP_ALL_SAVED
DECISION_CHANGED
APPLY_ATTEMPTED
FIELD_FILLED
ROW_DELETED
CLUSTER_APPLIED
APPLY_COMPLETED
APPLY_FAILED
APPLY_SKIPPED
```

Source-changing audit events must be appended in the same atomic Sheets API request as the source changes.

---

## 9. Configuration Defaults

Seed the following logical configuration. Store actual values in `_Dedup_Config` and load them into a typed `DedupConfig` object.

```ts
const DEFAULT_CONFIG = {
  schemaVersion: 1,
  headerSearchRows: 25,
  placeholderDates: ['1900-01-01'],
  missingLabels: ['', 'unknown', 'n/a', 'na', 'none', 'null', 'not available'],
  thresholds: {
    high: 80,
    medium: 60,
    low: 45,
    nameOnlySimilarity: 0.88,
    meaningfulNameSimilarity: 0.62,
    strongNameSimilarity: 0.82,
    veryStrongNameSimilarity: 0.88
  },
  weights: {
    name: 60,
    dob: 25,
    address: 8,
    zip: 5,
    context: 2
  },
  penalties: {
    dobConflict: 35,
    zipConflict: 2,
    addressConflict: 2,
    houseNumberConflict: 4
  },
  blocking: {
    commonTokenBlockMax: 150,
    trigramPostingMax: 200,
    fuzzyOnlyCandidatesPerRecord: 100,
    maxTotalCandidates: 200000
  },
  execution: {
    sliceBudgetMs: 25000,
    pairScoreChunkSize: 750,
    recordWriteChunkSize: 500,
    queuePageSize: 20,
    maxAtomicApplyRequests: 900
  },
  retention: {
    terminalWorkingDataDays: 7
  }
};
```

Every scan stores `configHash`. A config change must make prior Keep All suppressions ineligible unless the suppression explicitly stores the same config hash.

---

## 10. Header Resolution

### 10.1 Current canonical aliases

```ts
const HEADER_ALIASES = {
  first: ['first', 'first name', 'firstname', 'given name', 'given'],
  middle: ['middle', 'middle name', 'middlename', 'middle initial'],
  last: ['last', 'last name', 'lastname', 'surname', 'family name'],
  dob: ['date of birth', 'dob', 'birth date', 'birthdate'],
  address1: ['line1', 'line 1', 'address', 'address 1', 'street', 'street address'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region'],
  county: ['county'],
  zip: ['zip', 'zip code', 'zipcode', 'postal code', 'postal']
};
```

### 10.2 Header-row algorithm

1. Read the first `min(headerSearchRows, lastRow)` rows as display values.
2. Normalize each candidate header cell by trimming, lowercasing, removing punctuation, and collapsing spaces.
3. Score each row by the number of unique canonical aliases matched.
4. Require both first and last headers for Version 1.
5. Require at least three recognized canonical fields total.
6. If two rows tie at the highest qualifying score, return `HEADER_AMBIGUOUS`.
7. If first or last is missing, return `MISSING_REQUIRED_HEADERS`.
8. Preserve all nonblank unmatched headers as extra participant fields.
9. Exclude `_Dedup_ID` from extras.
10. Compute `schemaHash` from header row, ordered headers, and canonical mappings.

### 10.3 Duplicate headers

After normalized comparison, duplicate nonblank headers are not allowed. Return `DUPLICATE_HEADERS` with the duplicate names and positions.

---

## 11. Stable `_Dedup_ID` Management

### 11.1 Creation

When `_Dedup_ID` is absent:

1. Insert it as the final used column.
2. Write the header in the detected header row.
3. Generate a UUID for every nonempty participant row.
4. Write UUIDs in one or more batch range operations.
5. Hide the column.
6. Append `ID_ASSIGNED` audit events without including participant values.

A row is considered a participant row when at least one mapped participant field or extra field is nonblank.

### 11.2 Missing IDs

For an existing ID column, assign a UUID to every nonempty participant row with a blank ID.

### 11.3 Duplicate IDs

A copied row may copy `_Dedup_ID`. Scanning must stop with `DUPLICATE_DEDUP_ID` and offer `Repair Duplicate IDs`.

Repair behavior:

1. Acquire a document lock.
2. Keep the first physical occurrence of an ID.
3. Assign new UUIDs to later occurrences.
4. Invalidate suppressions involving the duplicated ID.
5. Mark any active batch stale or cancel it.
6. Append `ID_REPAIRED` audit events.
7. Never alter participant values.

Do not silently repair IDs inside a normal scan.

---

## 12. Source Snapshot and Fingerprints

### 12.1 Bulk reads

Read the source range in bulk using:

- `getValues()` for typed values.
- `getDisplayValues()` for ZIP codes and human-readable comparisons.
- `getFormulas()` for formula detection and stale checking.

Do not alternate row-level reads and writes.

### 12.2 Row fingerprint

`rowFingerprint` detects whether a source row changed after scanning. It must include:

- Ordered source headers, excluding `_Dedup_ID`.
- For every cell, the serialized raw value.
- The display value.
- The formula string.

Canonicalize object keys before hashing. Use SHA-256.

### 12.3 Relevant hash

`relevantHash` controls matching and Keep All suppression. It includes normalized values for every non-system participant column. A change to any participant field changes the hash.

### 12.4 Hash helpers

Provide:

```ts
canonicalJson(value: unknown): string
sha256Hex(value: string): string
makePairKey(idA: string, idB: string): string
makeClusterId(batchId: string, memberIds: string[]): string
```

`makePairKey` sorts IDs before hashing. Cluster IDs are deterministic within a batch.

---

## 13. Normalization

Normalization must be pure, deterministic, and separately unit tested. It must never change the source sheet.

### 13.1 General text

1. Convert null-like values and configured missing labels to `null`.
2. Convert to Unicode NFKD.
3. Remove combining diacritical marks.
4. Convert to lowercase.
5. Normalize apostrophes and hyphens.
6. Replace comparison-only punctuation with spaces.
7. Collapse whitespace.
8. Trim.

### 13.2 Names

Create these representations:

```ts
interface NormalizedName {
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
```

Rules:

- Extract parenthetical text into `aliasTokens` while retaining non-parenthetical name text.
- Split hyphenated and spaced multipart names into tokens for token comparisons.
- Preserve apostrophe-connected names after normalization.
- Remove configurable titles such as `mr`, `mrs`, `ms`, and `dr` only when they appear as standalone leading tokens.
- Tokens of length one may be initials.
- Tokens of length two or fewer must match exactly; do not apply permissive fuzzy matching to very short tokens.
- Middle-name absence is neutral.
- Middle initial and full middle name are compatible when initials match.

### 13.3 Date of birth

1. If the raw value is a valid `Date`, format it as `yyyy-MM-dd` in the spreadsheet time zone.
2. For strings, parse only explicit supported formats:
   - `M/D/YYYY`
   - `MM/DD/YYYY`
   - `YYYY-MM-DD`
3. Do not rely on ambiguous JavaScript string-date parsing.
4. Validate month/day boundaries.
5. Convert `1900-01-01` to `PLACEHOLDER`.
6. Blank, invalid, and placeholder dates contribute no positive or negative evidence.
7. Two different valid dates create `DOB_CONFLICT`.

### 13.4 ZIP

- Use display values so leading zeros are preserved.
- Remove non-digits.
- Use the first five digits when ZIP+4 is present.
- Values with fewer than five digits are invalid/missing.

### 13.5 Address

Create:

```ts
interface NormalizedAddress {
  full: string;
  houseNumber: string | null;
  streetTokens: string[];
  unit: string | null;
}
```

Normalize common terms:

```text
street -> st
avenue -> ave
road -> rd
boulevard -> blvd
drive -> dr
lane -> ln
court -> ct
place -> pl
parkway -> pkwy
highway -> hwy
north -> n
south -> s
east -> e
west -> w
apartment -> unit
apt -> unit
# -> unit
```

Do not geocode or call an address API.

### 13.6 State and location

Map full U.S. state names to two-letter abbreviations. Normalize city and county with general text normalization. Remove a trailing standalone word `county` for county comparison only.

### 13.7 Extra fields

Normalize extra fields as general text. They may add weak contextual support but may not independently create a candidate or override a strong contradiction.

---

## 14. Candidate Generation

A 5,000-row all-pairs comparison would create approximately 12.5 million pairs, so candidate blocking is mandatory.

### 14.1 Indexes

Build indexes over all snapshot records:

```text
valid DOB -> record IDs
exact sorted full-name signature -> record IDs
exact name token -> record IDs
ZIP + name initial -> record IDs
house number + name initial -> record IDs
name trigram -> record IDs
```

Exclude missing/placeholder DOB values.

### 14.2 Name trigrams

For every name token with at least four characters:

- Add padded or unpadded three-character grams consistently.
- Ignore grams whose posting list exceeds `trigramPostingMax`.
- Count shared grams by candidate record.
- Require at least two shared grams and a minimum gram-overlap ratio before adding a fuzzy-only candidate.

### 14.3 Per-record generation

For record `i`, gather only candidate record indexes `j > i` from:

1. Exact valid DOB block.
2. Exact sorted-name block.
3. Exact name-token blocks.
4. ZIP-plus-initial blocks.
5. House-number-plus-initial blocks.
6. Trigram overlap.

Accumulate generation reasons in a map keyed by pair key.

### 14.4 Common-token control

For an exact token block larger than `commonTokenBlockMax`:

- Do not create every possible pair.
- Retain pairs that also share another blocking signal.
- Allow trigram ranking to identify the strongest fuzzy-only options.

### 14.5 Fuzzy-only cap

Strong-support candidates are never dropped by the per-record fuzzy cap. Fuzzy-only candidates are ranked by a cheap pre-score and limited to `fuzzyOnlyCandidatesPerRecord`.

Example cheap pre-score:

```text
+5 exact valid DOB
+3 exact sorted name
+2 exact name token
+2 exact ZIP
+2 exact house number
+0..3 shared trigram ratio
```

If candidates are truncated, increment `candidate_truncation_count` and display a batch warning. Never silently claim the scan was exhaustive.

### 14.6 Candidate-generation resumability

`GENERATING_CANDIDATES` stores a record-index cursor.

For each `rpcAdvanceScan()` call:

1. Reload normalized records.
2. Rebuild indexes in memory.
3. Start at `phase_cursor`.
4. Generate pair rows for successive records until the execution budget is reached.
5. Append pair rows in batches.
6. Save the next record index as the cursor.

Because only `j > i` pairs are emitted, rebuilding indexes does not create duplicate pairs across slices.

---

## 15. Similarity Functions

### 15.1 Jaro-Winkler

Implement a pure Jaro-Winkler function returning a value in `[0, 1]`. Unit-test it with known string pairs. Do not import a runtime package.

### 15.2 Soft token similarity

For two token sets:

1. Exact token matches receive `1.0`.
2. Nonexact tokens longer than two characters may match using Jaro-Winkler.
3. Accept a fuzzy token match only at or above `0.88`.
4. Match tokens greedily from highest similarity to lowest, using each token at most once.
5. Compute precision, recall, and F1 from the accepted token matches.

### 15.3 Name-component comparison

Compute:

- Direct first-to-first and last-to-last similarity.
- Swapped first-to-last and last-to-first similarity.
- Full token-set similarity.
- Ordered and reversed no-middle string similarity.
- Alias-to-core token similarity.
- Middle-name compatibility.

Suggested formula:

```ts
const direct = weightedCoreComponentSimilarity(a, b, false);
const swapped = weightedCoreComponentSimilarity(a, b, true);
const tokenBlend = 0.70 * softTokenF1(a.coreTokens, b.coreTokens)
                 + 0.30 * Math.max(
                     jaroWinkler(a.orderedNoMiddle, b.orderedNoMiddle),
                     jaroWinkler(a.orderedNoMiddle, b.reversedNoMiddle)
                   );
const alias = aliasSimilarity(a, b);

let nameSimilarity = Math.max(direct, swapped, tokenBlend, alias);
nameSimilarity += middleCompatibilityAdjustment(a, b); // bounded small adjustment
nameSimilarity = clamp(nameSimilarity, 0, 1);
```

Rules:

- Missing middle name is neutral.
- Conflicting middle names create a small warning/penalty, not an automatic rejection.
- When a core first or last component is missing on either record, cap the resulting name similarity at `0.88` unless an exact full-token relationship provides stronger evidence.
- Mark `EXACT_REVERSAL` when normalized first tokens of A equal normalized last tokens of B and vice versa.
- Mark `LIKELY_REVERSAL` when swapped similarity is at least `0.92` and materially exceeds direct similarity.

### 15.4 Address similarity

Suggested behavior:

```text
Exact normalized address: 1.00
Same house number + similar street: 0.35 + 0.55 * streetSimilarity + 0.10 * unitCompatibility
Different house number + similar street: at most 0.40 * streetSimilarity
Missing address on either side: 0.00 and neutral
```

- Exact/matching unit: compatible.
- Missing unit on one side: neutral.
- Different nonblank units: modest penalty, not automatic rejection.
- Strong street similarity with different house numbers creates `HOUSE_NUMBER_CONFLICT`.

### 15.5 Context similarity

Compute weak support from city, state, county, and exact normalized extra-field agreements. Cap total context contribution at two points.

---

## 16. Pair Scoring and Confidence

### 16.1 Base points

```ts
namePoints = round(nameSimilarity * 60)
dobPoints = 25 if exact valid DOB else 0
addressPoints = round(addressSimilarity * 8)
zipPoints = 5 if exact ZIP, -2 if conflicting valid ZIP, otherwise 0
contextPoints = 0..2
penalties = configured contradiction penalties
rawScore = namePoints + dobPoints + addressPoints + zipPoints + contextPoints - penalties
totalScore = clamp(round(rawScore), 0, 100)
```

For a valid DOB conflict:

- Apply the 35-point penalty.
- Add `CONFLICTING_VALID_DOB` warning.
- Cap confidence at Low.

### 16.2 Candidate eligibility

A pair is eligible when one of these conditions is met:

1. `nameSimilarity >= 0.88`.
2. `nameSimilarity >= 0.62` and there is strong supporting evidence.
3. Exact valid DOB and `nameSimilarity >= 0.52`.
4. Exact or likely first/last reversal and `nameSimilarity >= 0.82`.
5. Strong alias relationship and DOB, ZIP, or address support.

Strong supporting evidence is:

```text
Exact valid DOB
OR exact ZIP plus address similarity >= 0.60
OR address similarity >= 0.85
```

A pair is never eligible when its only evidence is a shared ZIP, address, city, state, county, or extra field.

### 16.3 Valid DOB conflict exception

A pair with conflicting valid birthdates is eligible only when:

```text
nameSimilarity >= 0.92
AND (exact ZIP OR address similarity >= 0.75)
```

It is always Low confidence.

### 16.4 Name-only detection

A pair is name-only when there is no exact valid DOB, no exact ZIP, address similarity is below `0.50`, and no meaningful contextual support exists.

Name-only behavior:

- Require `nameSimilarity >= 0.88`.
- Add `NAME_ONLY_MATCH` warning.
- Cap confidence at Low.

### 16.5 Confidence assignment

1. If not eligible, `EXCLUDED`.
2. If valid DOB conflict, `LOW`.
3. If name-only, `LOW`.
4. Otherwise High requires:
   - `totalScore >= 80`,
   - `nameSimilarity >= 0.82`, and
   - one of:
     - exact valid DOB,
     - exact ZIP and address similarity at least `0.55`,
     - exact direct/reversed name plus ZIP, strong address, or strong context.
5. Medium requires:
   - `totalScore >= 60`, and
   - `nameSimilarity >= 0.70`, exact DOB, or clear reversal.
6. Low requires `totalScore >= 45`.
7. Otherwise excluded.

### 16.6 Required reason codes

Positive reasons:

```text
EXACT_NAME
EXACT_DOB
FIRST_LAST_REVERSED
LIKELY_FIRST_LAST_REVERSED
LIKELY_NAME_TYPO
NAME_TOKENS_REORDERED
PARENTHETICAL_ALIAS
MIDDLE_NAME_MISSING
MIDDLE_INITIAL_MATCH
SAME_ZIP
SIMILAR_ADDRESS
SAME_CITY_STATE
EXTRA_FIELD_AGREEMENT
```

Warnings:

```text
CONFLICTING_VALID_DOB
NAME_ONLY_MATCH
DIFFERENT_ZIP
DIFFERENT_ADDRESS
HOUSE_NUMBER_CONFLICT
MIDDLE_NAME_CONFLICT
SAME_HOUSEHOLD_ONLY
INCOMPLETE_SOURCE_DATA
INVALID_DOB
POSSIBLE_CHAIN_CLUSTER
CANDIDATE_TRUNCATION
FORMULA_FIELD_SKIPPED
```

Sort and deduplicate all reason/warning arrays before storage so fingerprints remain deterministic.

---

## 17. Pair Scoring Phase

`SCORING` uses a durable pair-row cursor.

For every slice:

1. Read all record snapshots for the batch into an ID map.
2. Read the next `pairScoreChunkSize` pending pair rows.
3. Score each pair with pure functions.
4. Write `score_json`, `qualified`, and `score_status` in one batch range operation.
5. Increment qualified-edge metrics.
6. Advance the cursor.
7. Transition to `CLUSTERING` when no pending pairs remain.

A scoring exception for one pair should mark that pair `ERROR`, append a safe error event, and continue. A systemic error should fail the batch.

---

## 18. Cluster Formation

### 18.1 Core clusters

Use union-find over all High and Medium qualifying edges.

Each connected component with at least two records becomes a core cluster.

### 18.2 Low-confidence edges

Low edges must not independently create transitive chains.

Rules:

1. If both endpoints are already in the same core cluster, retain the Low edge only as explanatory evidence.
2. If one endpoint is in a core cluster and the other is not, add the outside record as a suggested member only to the core cluster with its strongest Low edge.
3. If both endpoints are outside every core cluster, create an independent two-record `LOW_PAIR` item.
4. If a Low edge connects two different core clusters, do not merge them. Add a `POSSIBLE_CHAIN_CLUSTER` warning and surface the relation as contextual evidence.

### 18.3 Cluster limits

If a cluster exceeds 50 displayed members:

- Mark the batch warning `OVERSIZED_CLUSTER`.
- Do not allow deletion from that cluster.
- Require manual data cleanup or a narrower rescan.

### 18.4 Cluster ordering

Queue ordering:

1. Highest confidence: High, then Medium, then Low.
2. Highest score descending.
3. Smallest original source row ascending.

Member labels are stable within a cluster and assigned by original row order: Record A, Record B, Record C, etc.

---

## 19. Keep All Suppression

### 19.1 Suppression key

```ts
suppressionKey = sha256Hex(
  sortedMemberIds.join('|') + '|' + configHash
);

memberContentHash = sha256Hex(
  sortedMembers.map(m => `${m.dedupId}:${m.relevantHash}`).join('|')
);
```

### 19.2 Save behavior

When a reviewer explicitly chooses Keep All:

1. Validate current record fingerprints.
2. Save cluster status `KEEP_ALL`.
3. Store or update a `SUPPRESSION` row.
4. Append `KEEP_ALL_SAVED` audit event.

### 19.3 Future-scan behavior

Suppress a generated cluster or Low pair only when:

- The sorted member IDs match.
- The member content hash matches.
- The config hash matches.

Any relevant field change, ID change, membership change, or config change makes it eligible again.

If a Keep All decision is later changed before a new scan, delete its suppression state.

---

## 20. Resumable Scan State Machine

### 20.1 Start

`rpcStartScan()`:

1. Resolve user identity.
2. Validate the active sheet is a grid sheet and not a system sheet.
3. Acquire document lock.
4. Ensure system sheets and config.
5. Ensure no active batch, or return the current batch.
6. Resolve headers.
7. Validate/assign IDs.
8. Create batch in `SNAPSHOTTING`.
9. Append `SCAN_STARTED` audit event.
10. Release lock.
11. Return batch status.

### 20.2 Advance

`rpcAdvanceScan(batchId)` performs exactly one bounded slice and returns:

```ts
interface ScanProgress {
  batchId: string;
  status: BatchStatus;
  phase: BatchPhase;
  completed: number;
  total: number | null;
  message: string;
  metrics: {
    records: number;
    candidates: number;
    qualifiedEdges: number;
    clusters: number;
  };
  warnings: string[];
}
```

### 20.3 Phase transitions

```text
SNAPSHOTTING
  -> GENERATING_CANDIDATES
  -> SCORING
  -> CLUSTERING
  -> READY
```

Every phase transition and cursor update must use an expected batch revision. Concurrent or duplicate calls return `BATCH_STATE_CONFLICT` rather than double-processing.

### 20.4 Snapshot phase

- Snapshot source rows in chunks.
- Store record snapshots.
- Ignore fully blank participant rows.
- Validate unique IDs.
- When finished, set `record_count` and transition.

### 20.5 Cluster phase

- Read qualifying scores.
- Build clusters.
- Apply suppression filters.
- Write `_Dedup_Clusters` in bulk.
- Set queue counts.
- Delete temporary `_Dedup_Pairs` rows for the batch after successful finalization.
- Mark batch `READY`.
- Append `SCAN_COMPLETED` audit event.

### 20.6 Failure and pause

- Recoverable client disconnect: batch remains in its current phase and can resume.
- Explicit cancel: batch `CANCELLED`, delete working records/pairs/clusters, retain audit.
- Systemic error: batch `FAILED`, retain enough metadata for diagnostics, never change source participant values.

---

## 21. Sidebar Design

Apps Script sidebars are narrow, so do not attempt a full desktop-style comparison table.

### 21.1 Views

```text
BOOTSTRAP
IDENTITY_REQUIRED
SCAN_PROGRESS
QUEUE
CLUSTER_REVIEW
BATCH_SUMMARY
APPLY_CONFIRMATION
APPLY_RESULT
AUDIT_HISTORY
ERROR
```

### 21.2 Bootstrap

`rpcBootstrap()` returns:

- User identity state.
- Active batch, if any.
- Queue counts.
- Current filters.
- Whether a fallback reviewer name is needed.

### 21.3 Identity fallback

The client passes an optional fallback name with every mutation.

Server behavior:

1. Try `Session.getActiveUser().getEmail()`.
2. If nonblank, use email and ignore fallback.
3. If blank and fallback is absent, return `IDENTITY_REQUIRED`.
4. If blank and fallback is present, sanitize and use it.
5. Also store the temporary active-user key internally when available, but do not display it.

The sidebar stores the fallback name only in `sessionStorage`, never `localStorage`.

### 21.4 Queue filters

Default:

- High checked.
- Medium checked.
- Low unchecked.
- Unreviewed checked.

Additional filters:

- Reviewed.
- Stale.
- Match reason.
- Warning type.

### 21.5 Queue page API

```ts
rpcGetQueuePage({
  batchId,
  confidence: ['HIGH', 'MEDIUM'],
  statuses: ['UNREVIEWED', 'IN_PROGRESS'],
  cursor,
  pageSize
})
```

Use cursor pagination, not full-queue transfer.

### 21.6 Cluster review layout

For each cluster:

1. Confidence, score, reasons, and warnings.
2. Progress indicator.
3. Compact record cards with:
   - Record label.
   - Name.
   - DOB.
   - Address/ZIP.
   - Original source row.
   - `Open source row` action.
4. A field-difference list. Each field shows values stacked by record.
5. Explicit decision controls:
   - `Keep all records`.
   - `Choose records to keep`.
   - `Leave unresolved`.
6. Retain checkboxes shown only in choose-records mode.
7. Merge-target selection for each proposed deletion when multiple records remain.
8. Proposed blank-field fills grouped by retained record.
9. Conflict radio buttons or dropdowns.
10. Reviewer notes.
11. `Save decision`.

There must be no default deletion selection. Opening a cluster cannot make it ready to apply.

### 21.7 Source-row focus

`rpcFocusSourceRow()` validates batch, sheet, and ID, locates the current row, activates it, and returns success. The client then calls `google.script.host.editor.focus()`.

### 21.8 Safe rendering

- Insert participant values with `textContent`, never `innerHTML`.
- Do not place PII in URL fragments, browser logs, or analytics.
- Do not use remote fonts, remote scripts, or third-party assets.

---

## 22. Review and Merge Planning

### 22.1 Keep All

- Retained IDs equal every displayed member ID.
- No deletion assignments.
- No merge plan.
- Save suppression immediately.

### 22.2 Choose records to keep

Validation:

1. At least one record is retained.
2. Every nonretained record has exactly one retained merge target.
3. A record cannot target itself.
4. All referenced IDs belong to the cluster.
5. Suggested members are treated like normal members only after the reviewer includes them in the decision.

### 22.3 Protected fields

Never automatically fill or overwrite:

```text
First
Middle
Last
Date of Birth
_Dedup_ID
```

Header aliases must map protected canonical fields regardless of source spelling.

### 22.4 Formula behavior

- A target cell containing a formula is never treated as blank.
- A formula source cell is never used for automatic fill.
- Add `FORMULA_FIELD_SKIPPED` warning when relevant.

### 22.5 Automatic proposal algorithm

For every retained target and eligible source header:

1. If target has a formula or nonblank value, do not propose a change.
2. Collect nonblank literal values from records assigned for deletion to that target.
3. Group values by normalized comparison value.
4. If one group exists, propose `AUTO` using a deterministic source:
   - Lowest original source row, then lowest `_Dedup_ID`.
5. If multiple groups exist, require `SOURCE` or `LEAVE_BLANK`.
6. Never pull values from another retained record.

### 22.6 Save decision

`rpcSaveClusterDecision()`:

1. Resolve actor identity.
2. Load cluster and expected revision.
3. Re-read current source rows for involved IDs.
4. Compare row fingerprints and schema hash.
5. Rebuild merge proposals server-side.
6. Validate the submitted decision.
7. Save decision and increment revision.
8. Update or remove Keep All suppression.
9. Append review audit event.
10. Return refreshed cluster state.

If source data changed, mark cluster `STALE` and return `CLUSTER_STALE`.

---

## 23. Batch Summary and Confirmation

### 23.1 Summary contents

`rpcGetBatchSummary()` returns:

- Total clusters.
- Ready-to-apply clusters.
- Keep All clusters.
- Unresolved clusters.
- Stale clusters.
- Rows to retain.
- Rows proposed for permanent deletion.
- Blank fields to fill.
- Manual conflict choices.
- Candidate truncation warning.
- Source sheet name.
- Reviewer identities represented in the batch.

### 23.2 Apply challenge

`rpcCreateApplyChallenge()`:

1. Recompute the summary.
2. Create `summaryHash` from all ready decision hashes and current counts.
3. Create a random challenge token.
4. Store token, user identity key, batch ID, summary hash, and expiration in user cache or `_Dedup_State`.
5. Return the token and exact warning text.

The confirmation UI must require a checkbox:

> I understand that the selected rows will be permanently removed from the participant sheet and no full-sheet backup will be created.

No typed confirmation phrase is required.

The server must not acquire the apply lock before the user confirms.

---

## 24. Apply Preflight

`rpcApplyBatch()` must:

1. Resolve applying-user identity.
2. Validate the apply challenge and expiration.
3. Acquire `LockService.getDocumentLock()` with a bounded timeout.
4. Reload the batch, ready clusters, source schema, and current source sheet.
5. Recompute the batch summary and require the same `summaryHash`.
6. Bulk-read the current source data.
7. Build a current `_Dedup_ID -> row` map.
8. Verify every affected ID exists exactly once.
9. Verify the current schema hash.
10. Verify every involved row fingerprint.
11. Recalculate every merge plan.
12. Verify every cluster decision hash.
13. Verify no ID is both retained and deleted across clusters.
14. Verify at least one retained record per cluster.
15. Verify all field conflicts are resolved.
16. Verify the batch has not already been applied.
17. Record `APPLY_ATTEMPTED` separately.
18. Build one atomic Sheets API request.

If any ready cluster is stale, mark it stale and exclude it only when the remaining clusters have no shared IDs. If cluster relationships overlap, fail the entire apply preflight.

---

## 25. Atomic Sheets API Request

### 25.1 Request order

Build requests in this order:

1. Value-copy requests for approved blank-field fills.
2. Source-row deletion requests sorted by descending row interval.
3. Append audit-event rows.
4. Update applied cluster rows.
5. Update batch status and metrics.

The API processes subrequests in order and applies a valid batch atomically.

### 25.2 Blank-field fills

Use `CopyPasteRequest` with `PASTE_VALUES` from the selected source record cell to the retained target cell.

Reasons:

- The source value already exists in the same spreadsheet.
- It preserves the source’s effective value without writing a browser-supplied value.
- The copy occurs before the source row is deleted.
- It does not copy formatting.

Only build a copy request after preflight proves the target is still blank and formula-free.

### 25.3 Row deletions

- Convert current one-based source rows to zero-based grid indexes.
- Combine consecutive rows into intervals.
- Sort intervals descending.
- Use `DeleteDimensionRequest` with dimension `ROWS`.

### 25.4 Audit append

Use one `AppendCellsRequest` containing every source-changing event row. Include:

- One `FIELD_FILLED` event per field.
- One `ROW_DELETED` event per deleted record, with full row snapshot.
- One `CLUSTER_APPLIED` event per cluster.
- One `APPLY_COMPLETED` event.

### 25.5 Queue and batch updates

Update `_Dedup_Clusters` and `_Dedup_Batches` inside the same request. Do not make a second “mark applied” write after source deletion.

### 25.6 Request-size guard

If generated subrequests exceed `maxAtomicApplyRequests`:

- Do not split a cluster.
- Return `APPLY_REQUEST_TOO_LARGE` before source changes.
- Ask the reviewer to apply a smaller set of ready clusters.

Version 1 should prefer failing safely over silently splitting a batch into non-atomic chunks.

### 25.7 Success and failure

On success:

1. Call `SpreadsheetApp.flush()`.
2. Release the document lock in `finally`.
3. Return an apply summary.

On API failure:

1. The atomic request should leave all included changes unapplied.
2. Append `APPLY_FAILED` in a separate safe audit write.
3. Mark the batch/cluster apply state as error only if doing so cannot obscure the original ready decision.
4. Release the lock.
5. Return a user-safe error.

Never retry a source-changing API request automatically after an ambiguous transport error. Re-run preflight and inspect batch/cluster status first.

---

## 26. Idempotency

### 26.1 Decision hash

```ts
decisionHash = sha256Hex(canonicalJson({
  batchId,
  clusterId,
  retainedIds: sorted,
  deleteAssignments: sortedObject,
  fieldChoices: canonicalized,
  sourceFingerprints: sorted
}));
```
