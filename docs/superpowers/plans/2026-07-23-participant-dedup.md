# Participant Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready, container-bound Google Apps Script that fuzzy-deduplicates participant records in one active sheet, with human-reviewed, atomic, audited row deletion.

**Architecture:** Pure TypeScript matching/scoring/clustering brain (no Apps Script imports) behind a single `SheetsGateway` adapter, bundled by esbuild into an Apps Script IIFE. The entire brain is testable under vitest via an in-memory fake gateway; only the thin gateway and global entry points touch Google. Engine-first build order: prove match quality on synthetic ground-truth data before building the sidebar/apply layers on top.

**Tech Stack:** TypeScript (strict), esbuild, vitest, @google/clasp, @types/google-apps-script, Advanced Sheets service v4, vanilla HTML/CSS/JS sidebar.

**Reference spec (on disk, read-only, NOT vendored):** `~/Downloads/google_sheets_dedup_codex_handoff/google_sheets_dedup_technical_design.md`. Section citations below (e.g. §15.1) point there for verbatim algorithm bodies. Where this plan and the spec disagree, the spec wins.

## Global Constraints

- **No automatic row deletion.** Deletion happens only through the explicit apply/confirm flow.
- **No participant value mutated during scan/review.** Only `_Dedup_ID` may be added or repaired.
- **No external runtime calls.** No `UrlFetchApp`, no remote assets, no network. Matching is 100% local.
- **No real participant data** in repo, tests, logs, fixtures, or screenshots. Fixtures are synthetic and generated.
- **No hardcoded** spreadsheet ID, sheet ID, row count, or participant values.
- **Do not deploy to or modify the production spreadsheet.**
- **TypeScript strict**; no `any` in production code; explicit return types on exported functions.
- **Package manager: pnpm** (never npm/yarn) — commit-quality gate enforces this.
- **All `Sheets.*` / Apps Script globals live behind `SheetsGateway` only.** `match/`, `scan/` logic, `review/`, and `apply/` request-building import zero Apps Script globals.
- **Render participant values with `textContent`; never interpolate into HTML.**
- **Fail closed** on: stale row fingerprint, duplicate `_Dedup_ID`, unresolved conflict, changed `summaryHash`, lock timeout, oversized atomic request.
- **Server never trusts** browser-supplied spreadsheet IDs, rows, record values, merge proposals, or decisions without server-side recalculation/validation.
- **Config:** all thresholds/weights/penalties live in `DEFAULT_CONFIG` (§9); never inline magic numbers that duplicate config.
- **Determinism:** sort + dedupe all reason/warning arrays before storage so fingerprints are stable.
- Commit at the end of every task. `main` stays green.

---

## File Structure

```
participant-dedup/
├── package.json, tsconfig.json, vitest.config.ts, .gitignore
├── build/esbuild.mjs                      # bundles server → dist/Code.js, copies sidebar + manifest
├── src/
│   ├── shared/
│   │   ├── constants.ts                   # system-sheet names, canonical fields, reason/warning codes
│   │   └── config.ts                      # DEFAULT_CONFIG, DedupConfig type, HEADER_ALIASES
│   ├── server/
│   │   ├── types.ts                       # SourceSchema, RecordSnapshot, NormalizedParticipant, PairScore, ClusterDecision
│   │   ├── errors.ts                      # DedupError taxonomy (§29), error codes
│   │   ├── hashing.ts                     # sha256, rowFingerprint, relevantHash, schemaHash, decisionHash, configHash
│   │   ├── identity.ts                    # UUID, reviewer identity resolution
│   │   ├── match/
│   │   │   ├── normalizeText.ts           # §13.1 general text
│   │   │   ├── normalizeName.ts           # §13.2 NormalizedName
│   │   │   ├── normalizeDob.ts            # §13.3
│   │   │   ├── normalizeZip.ts            # §13.4
│   │   │   ├── normalizeAddress.ts        # §13.5 NormalizedAddress
│   │   │   ├── normalizeLocation.ts       # §13.6 state/city/county
│   │   │   ├── normalizeParticipant.ts    # assembles NormalizedParticipant from raw row
│   │   │   ├── jaroWinkler.ts             # §15.1 pure
│   │   │   ├── softToken.ts               # §15.2 precision/recall/F1
│   │   │   ├── nameSimilarity.ts          # §15.3 name-component comparison
│   │   │   ├── addressSimilarity.ts       # §15.4
│   │   │   ├── contextSimilarity.ts       # §15.5
│   │   │   ├── candidateGenerator.ts      # §14 blocking/indexes/trigrams
│   │   │   ├── scorePair.ts               # §16 scoring, eligibility, confidence, reasons
│   │   │   └── cluster.ts                 # §18 union-find, low-edge, ordering
│   │   ├── review/
│   │   │   ├── suppression.ts             # §19 Keep All suppression key + eligibility
│   │   │   └── mergePlan.ts               # §22 protected fields, auto-proposal, conflict detection
│   │   ├── apply/
│   │   │   ├── preflight.ts               # §24 17-step validation
│   │   │   ├── atomicRequest.ts           # §25 batchUpdate request builder (pure)
│   │   │   └── audit.ts                    # §25.4 audit-append composition
│   │   ├── sheets/
│   │   │   ├── SheetsGateway.ts           # interface + live Advanced Sheets impl (ONLY Google seam)
│   │   │   └── FakeSheetsGateway.ts        # in-memory impl for tests (lives under src for reuse; test-only)
│   │   ├── schemaResolver.ts              # §10 header-row detection
│   │   ├── systemSheets.ts                # §8 hidden _Dedup_ sheet init + migration
│   │   ├── *Repository.ts                 # config/batches/records/pairs/clusters/state/audit repos (§8)
│   │   ├── scan/
│   │   │   └── scanStateMachine.ts        # §20 start/advance/phases/cursors
│   │   ├── rpc.ts                         # §6 RPC envelope + rpc* handlers
│   │   ├── menu.ts                        # §6.1 Deduplication menu
│   │   └── globals.ts                     # onOpen + global entry point exports
│   ├── client/
│   │   ├── Sidebar.html                   # vanilla shell
│   │   ├── sidebar.js                     # views, textContent rendering, google.script.run calls
│   │   └── sidebar.css
│   └── appsscript.json                    # §5 manifest
├── tools/generateFixture.ts              # §32.4 5,000-row synthetic generator (+ ground truth)
├── tools/dogfoodReport.ts                # runs engine over fixture, prints precision/recall by band
└── test/                                  # vitest unit + integration mirrors src/ layout
```

---

# PHASE A — Foundation

### Task A1: Project scaffold + toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/appsscript.json`
- Create: `src/shared/constants.ts`

**Interfaces:**
- Produces: `SYSTEM_SHEETS` (record of `_Dedup_*` names), `CANONICAL_FIELDS` (readonly tuple), `POSITIVE_REASONS`/`WARNINGS` (readonly tuples from §16.6).

- [ ] **Step 1: Write `package.json`** with pnpm scripts: `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:watch`, `build` (`node build/esbuild.mjs`), `fixture` (`tsx tools/generateFixture.ts`), `dogfood` (`tsx tools/dogfoodReport.ts`). Dev deps: `typescript`, `esbuild`, `vitest`, `tsx`, `@types/google-apps-script`, `@google/clasp`. No runtime deps.

- [ ] **Step 2: Write `tsconfig.json`** — `strict: true`, `target: ES2019` (Apps Script V8), `module: ESNext`, `moduleResolution: bundler`, `noUncheckedIndexedAccess: true`, `types: ["google-apps-script"]`, path alias `@/* → src/*`.

- [ ] **Step 3: Write `src/appsscript.json`** (§5): `runtimeVersion: V8`, `Sheets` advanced service enabled (v4), `oauthScopes`: `spreadsheets`, `script.container.ui`, `userinfo.email`. NOT `spreadsheets.currentonly`.

- [ ] **Step 4: Write `src/shared/constants.ts`** with system-sheet names, canonical fields, and the reason/warning code tuples verbatim from §16.6.

- [ ] **Step 5: Install + verify.** Run: `pnpm install && pnpm typecheck`. Expected: PASS (no source yet beyond constants).

- [ ] **Step 6: Commit.** `git add -A && git commit -m "chore: scaffold participant-dedup toolchain + constants"`

---

### Task A2: Config + DedupConfig type

**Files:**
- Create: `src/shared/config.ts`
- Test: `test/shared/config.test.ts`

**Interfaces:**
- Produces: `DEFAULT_CONFIG` (verbatim §9), `type DedupConfig = typeof DEFAULT_CONFIG`, `HEADER_ALIASES` (verbatim §10.1).

- [ ] **Step 1: Write failing test** asserting `DEFAULT_CONFIG.thresholds.high === 80`, `.weights.name === 60`, `.penalties.dobConflict === 35`, `.blocking.maxTotalCandidates === 200000`, and `HEADER_ALIASES.last` includes `'surname'`.
- [ ] **Step 2: Run** `pnpm vitest run test/shared/config.test.ts` → FAIL (module not found).
- [ ] **Step 3: Write `config.ts`** copying `DEFAULT_CONFIG` and `HEADER_ALIASES` verbatim from §9/§10.1; export `DedupConfig` type.
- [ ] **Step 4: Run** test → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: dedup config defaults + header aliases"`

---

### Task A3: Error taxonomy

**Files:**
- Create: `src/server/errors.ts`
- Test: `test/server/errors.test.ts`

**Interfaces:**
- Produces: `class DedupError extends Error` with `code: DedupErrorCode` and `safeMessage: string`; `type DedupErrorCode` union covering §29 codes (`HEADER_AMBIGUOUS`, `MISSING_REQUIRED_HEADERS`, `DUPLICATE_HEADERS`, `DUPLICATE_DEDUP_ID`, `STALE_ROW`, `REVISION_CONFLICT`, `SUMMARY_HASH_CHANGED`, `LOCK_TIMEOUT`, `ATOMIC_REQUEST_TOO_LARGE`, `UNRESOLVED_CONFLICT`, `DUPLICATE_APPLY`, …); `isDedupError(e): e is DedupError`.

- [ ] **Step 1: Write failing test:** `new DedupError('STALE_ROW','x').code === 'STALE_ROW'`; `isDedupError(new Error()) === false`; `safeMessage` never contains passed PII arg (constructor takes only code + a static safe message).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `errors.ts` with the code union (§29) and a `SAFE_MESSAGES` map so `safeMessage` derives from code, not from interpolated data.
- [x] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: DedupError taxonomy with PII-safe messages"`

---

### Task A4: Hashing utilities

**Files:**
- Create: `src/server/hashing.ts`
- Test: `test/server/hashing.test.ts`

**Interfaces:**
- Produces: `sha256Hex(input: string): string`; `stableStringify(v: unknown): string` (sorted keys); `rowFingerprint(displayValues: string[]): string` (§12.2); `relevantHash(fields: Record<string,string|null>): string` (§12.3); `schemaHash(headers: string[], mapping: Record<string,number>): string`; `decisionHash(decision: ClusterDecision): string` (§26.1); `configHash(cfg: DedupConfig): string`.

Note: Apps Script exposes `Utilities.computeDigest`. For pure testability, `sha256Hex` takes an injectable digest fn defaulting to Node `crypto` in tests and `Utilities` at runtime (via a tiny platform shim in `SheetsGateway`), OR implement a pure JS SHA-256. **Decision: pure JS SHA-256** (dependency-free, identical Node/Apps Script output, fully unit-testable).

- [ ] **Step 1: Write failing test** with a known vector: `sha256Hex('abc')` starts with `ba7816bf...`; `stableStringify({b:1,a:2}) === '{"a":2,"b":1}'`; `rowFingerprint(['A','b'])` is deterministic and differs from `rowFingerprint(['A','B'])`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** pure SHA-256 + helpers. `rowFingerprint`/`relevantHash`/`decisionHash` build a stableStringify’d payload then `sha256Hex`.
- [ ] **Step 4: Run** → PASS (verify known SHA-256 vector).
- [ ] **Step 5: Commit.** `git commit -m "feat: deterministic hashing + fingerprints"`

---

### Task A5: Domain types

**Files:**
- Create: `src/server/types.ts`

**Interfaces:**
- Produces: `SourceSchema`, `CanonicalField`, `RecordSnapshot`, `CellValue`, `NormalizedParticipant`, `NormalizedName`, `NormalizedAddress`, `PairScore`, `NameMatchMethod`, `ClusterDecision` — **verbatim from §7 and §13.2/§13.5**.

- [ ] **Step 1: Write** `types.ts` copying all interfaces from §7, §13.2 (`NormalizedName`), §13.5 (`NormalizedAddress`). Define `type NameMatchMethod = 'DIRECT'|'SWAPPED'|'TOKEN'|'ALIAS'`.
- [ ] **Step 2: Run** `pnpm typecheck` → PASS.
- [ ] **Step 3: Commit.** `git commit -m "feat: core domain types"`

---

# PHASE B — Matching engine (pure)

> Every task here is pure TypeScript with zero Apps Script imports. This is the dogfoodable core.

### Task B1: General text + location normalization

**Files:**
- Create: `src/server/match/normalizeText.ts`, `src/server/match/normalizeLocation.ts`, `src/server/match/normalizeZip.ts`
- Test: `test/server/match/normalizeText.test.ts`, `.../normalizeZip.test.ts`

**Interfaces:**
- Produces: `normalizeText(v: CellValue, cfg: DedupConfig): string | null` (§13.1); `normalizeState(v): string|null`, `normalizeCity(v)`, `normalizeCounty(v)` (§13.6); `normalizeZip(display: string): string|null` (§13.4).
- Consumes: `DedupConfig.missingLabels`.

- [ ] **Step 1: Write failing tests:** `normalizeText('  Café ',cfg) === 'cafe'` (NFKD + diacritic strip + lowercase); `normalizeText('N/A',cfg) === null`; `normalizeZip('01234-5678') === '01234'`; `normalizeZip('123') === null`; `normalizeState('California') === 'ca'`; `normalizeCounty('Kings County') === 'kings'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per §13.1/§13.4/§13.6 (NFKD, combining-mark regex `/\p{Diacritic}/gu`, apostrophe/hyphen normalization, punctuation→space, whitespace collapse; ZIP digit-strip + first-5; US state map).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: text/zip/location normalization"`

---

### Task B2: Name normalization

**Files:**
- Create: `src/server/match/normalizeName.ts`
- Test: `test/server/match/normalizeName.test.ts`

**Interfaces:**
- Produces: `normalizeName(first: CellValue, middle: CellValue, last: CellValue, cfg: DedupConfig): NormalizedName` (§13.2).
- Consumes: `normalizeText`.

- [ ] **Step 1: Write failing tests** covering §13.2 rules: parenthetical `"Bob (Bobby)"` → `aliasTokens` includes `bobby`, core retains `bob`; hyphenated `"Smith-Jones"` → two last tokens; title strip `"Dr John"` → `john`; `orderedNoMiddle`/`reversedNoMiddle` strings; `sortedTokenSignature` order-independent; `missingCoreComponent` true when last blank; middle initial `"J"` vs `"James"` both retained as tokens/initials.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per §13.2.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: name normalization with alias/reversal signatures"`

---

### Task B3: DOB + address normalization

**Files:**
- Create: `src/server/match/normalizeDob.ts`, `src/server/match/normalizeAddress.ts`
- Test: `test/server/match/normalizeDob.test.ts`, `.../normalizeAddress.test.ts`

**Interfaces:**
- Produces: `normalizeDob(raw: CellValue, tz: string, cfg: DedupConfig): NormalizedParticipant['dob']` (§13.3); `normalizeAddress(v: CellValue, cfg): NormalizedAddress | null` (§13.5).

- [ ] **Step 1: Write failing tests:** `normalizeDob('1/2/1990',tz).value === '1990-01-02'` state VALID; `normalizeDob('01/01/1900',tz).state === 'PLACEHOLDER'`; `normalizeDob('',tz).state==='MISSING'`; `normalizeDob('13/40/2000',tz).state==='INVALID'`; address `"123 North Main Street Apt 4"` → houseNumber `123`, streetTokens include `n`,`main`,`st`, unit `4`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per §13.3 (explicit formats only, no `new Date(string)` ambiguity, month/day bounds, placeholder map) and §13.5 (abbrev map, house number, unit).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: dob + address normalization"`

---

### Task B4: Participant assembler

**Files:**
- Create: `src/server/match/normalizeParticipant.ts`
- Test: `test/server/match/normalizeParticipant.test.ts`

**Interfaces:**
- Produces: `normalizeParticipant(valuesByHeader: Record<string,CellValue>, displayByHeader: Record<string,string>, schema: SourceSchema, tz: string, cfg: DedupConfig): NormalizedParticipant`.
- Consumes: all B1–B3 normalizers + `schema.columnByCanonicalField`.

- [ ] **Step 1: Write failing test:** given a header-mapped row, returns a fully populated `NormalizedParticipant`; extras normalized as general text; ZIP uses **display** value (leading zeros).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — pull each canonical field via schema mapping, call the right normalizer, collect extras.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: participant normalization assembler"`

---

### Task B5: Jaro-Winkler + soft-token F1

**Files:**
- Create: `src/server/match/jaroWinkler.ts`, `src/server/match/softToken.ts`
- Test: `test/server/match/jaroWinkler.test.ts`, `.../softToken.test.ts`

**Interfaces:**
- Produces: `jaroWinkler(a: string, b: string): number` (§15.1); `softToken(a: string[], b: string[]): { precision: number; recall: number; f1: number; matches: Array<[string,string]> }` (§15.2).

- [ ] **Step 1: Write failing tests** with known JW values: `jaroWinkler('martha','marhta')` ≈ `0.961`; `jaroWinkler('dwayne','duane')` ≈ `0.84`; identical strings `=== 1`; disjoint `=== 0`. softToken: exact-set F1 `=== 1`; greedy fuzzy match only accepts ≥ `0.88`; tokens used at most once.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** pure JW (§15.1) and greedy soft-token (§15.2). Assert JW values within `±0.005`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: jaro-winkler + soft-token f1"`

---

### Task B6: Name / address / context similarity

**Files:**
- Create: `src/server/match/nameSimilarity.ts`, `src/server/match/addressSimilarity.ts`, `src/server/match/contextSimilarity.ts`
- Test: `test/server/match/nameSimilarity.test.ts`, `.../addressSimilarity.test.ts`

**Interfaces:**
- Produces: `nameSimilarity(a: NormalizedName, b: NormalizedName, cfg): { similarity: number; method: NameMatchMethod; exactDirect: boolean; exactReversal: boolean; likelyReversal: boolean; middleConflict: boolean }` (§15.3); `addressSimilarity(a: NormalizedAddress|null, b: NormalizedAddress|null): { similarity: number; houseNumberConflict: boolean }` (§15.4); `contextSimilarity(a: NormalizedParticipant, b: NormalizedParticipant): number` capped at 2 (§15.5).
- Consumes: `jaroWinkler`, `softToken`.

- [ ] **Step 1: Write failing tests:** identical names → `1`, method `DIRECT`; swapped first/last with matching tokens → `exactReversal true`; typo `jon`/`john` → similarity high but < 1; missing last on one side caps at `0.88`; address exact → `1`; same house# + similar street ≈ formula in §15.4; different house# similar street → `houseNumberConflict true`, similarity ≤ `0.40*streetSim`; context capped at 2.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the §15.3 blended formula, §15.4 address bands, §15.5 context cap.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: name/address/context similarity"`

---

### Task B7: Pair scoring, eligibility, confidence, reasons

**Files:**
- Create: `src/server/match/scorePair.ts`
- Test: `test/server/match/scorePair.test.ts`

**Interfaces:**
- Produces: `scorePair(a: RecordSnapshot, b: RecordSnapshot, cfg: DedupConfig): PairScore` (§16). Deterministically sorted+deduped `reasons`/`warnings`.
- Consumes: `nameSimilarity`, `addressSimilarity`, `contextSimilarity`, `DEFAULT_CONFIG`.

- [ ] **Step 1: Write failing tests mapping to acceptance matrix** (pure-testable subset):
  - AT-01 exact duplicate → `confidence HIGH`.
  - AT-02 first/last swapped + matching DOB → HIGH or MEDIUM, reasons include `FIRST_LAST_REVERSED`.
  - AT-03 one-char typo + DOB + ZIP → HIGH.
  - AT-04 missing middle → still strong (not downgraded by absence).
  - AT-05 middle initial vs full → reason `MIDDLE_INITIAL_MATCH`.
  - AT-06 parenthetical alias → reason `PARENTHETICAL_ALIAS`.
  - AT-07 `01/01/1900` on both → no `dobPoints`, no conflict.
  - AT-08 different valid DOBs (name strong, same ZIP) → `LOW`, warning `CONFLICTING_VALID_DOB`.
  - AT-09 strong name-only (no DOB/ZIP/address) → `LOW`, warning `NAME_ONLY_MATCH`.
  - AT-10 different people same address (weak names) → `EXCLUDED`.
  - AT-11 same person moved (name+DOB match, ZIP/address differ) → eligible (not excluded).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** §16.1 base points, §16.2 eligibility, §16.3 DOB-conflict exception, §16.4 name-only, §16.5 confidence ladder, §16.6 reason/warning emission. Sort+dedupe arrays.
- [ ] **Step 4: Run** all AT-0x pair tests → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: pair scoring + confidence + reason codes"`

---

### Task B8: Candidate generation (blocking)

**Files:**
- Create: `src/server/match/candidateGenerator.ts`
- Test: `test/server/match/candidateGenerator.test.ts`

**Interfaces:**
- Produces: `generateCandidates(records: RecordSnapshot[], cfg: DedupConfig): { pairs: Array<{leftId:string; rightId:string}>; truncated: boolean }` (§14). Indexes over DOB, sorted full-name signature, name tokens, ZIP+initial, house#+initial, name trigrams (§14.1–14.3); common-token cap (§14.4); fuzzy-only per-record cap (§14.5); global `maxTotalCandidates` with `truncated` flag (never silent).
- Consumes: `NormalizedName.sortedTokenSignature`, trigram helper.

- [ ] **Step 1: Write failing tests:** two exact-name records produce a candidate pair; household-only pairs (shared ZIP/address, disjoint names) are NOT emitted from ZIP/address blocks alone unless a name block also links them; exceeding `maxTotalCandidates` sets `truncated true`; trigram block links `jon`/`john`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** §14 indexes + generation + caps. Dedupe pairs by ordered key.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: candidate generation with blocking + truncation flag"`

---

### Task B9: Cluster formation

**Files:**
- Create: `src/server/match/cluster.ts`
- Test: `test/server/match/cluster.test.ts`

**Interfaces:**
- Produces: `formCluster(scores: PairScore[], cfg: DedupConfig): Cluster[]` where `Cluster = { clusterId: string; memberIds: string[]; edges: PairScore[]; topConfidence: 'HIGH'|'MEDIUM'|'LOW'; hasLowOnlyEdges: boolean; chainWarning: boolean }` (§18). Core clusters from HIGH/MEDIUM edges via union-find; LOW edges attach as suggestions only (§18.2); cluster size limit (§18.3); ordering (§18.4).
- Consumes: `PairScore`.

- [x] **Step 1: Write failing tests:** AT-12 three transitively related records (A~B, B~C HIGH) → one cluster of 3; LOW-only edge does not merge two otherwise-separate HIGH clusters (stays a suggestion); oversized cluster flags `POSSIBLE_CHAIN_CLUSTER`; deterministic `clusterId` + ordering.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** union-find over qualifying edges per §18.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: union-find cluster formation"` — done `5c641be`. `Cluster` extended beyond the plan's minimal shape to carry `clusterType`, `suggestedMemberIds`, `topScore`, and `oversized` so §18.2 rule 2 (suggested members) and §18.3 (deletion block) are representable downstream.

---

# PHASE C — Fixture + dogfood loop

### Task C1: Synthetic fixture generator

**Files:**
- Create: `tools/generateFixture.ts`
- Test: `test/tools/generateFixture.test.ts`

**Interfaces:**
- Produces: `generateFixture(seed: number, rows?: number): { rows: Array<Record<string,string>>; groundTruth: Array<{ids: string[]; kind: string}> }` — invented names/addresses only; injects §32.4 patterns: exact duplicates, swapped names, common surnames, typos, household members, placeholder DOBs, changed ZIPs. Deterministic by seed. Also writes CSV to `tools/out/fixture.csv` when run as a script.

- [x] **Step 1: Write failing test:** `generateFixture(1, 200)` returns 200 rows, deterministic across two calls with same seed, groundTruth non-empty, and **no** name collides with a small denylist of real-looking seed names (sanity that data is synthetic).
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** a seeded PRNG + invented token pools; emit ground-truth labels per injected duplicate.
- [x] **Step 4: Run** → PASS. Then run `pnpm fixture` to emit `tools/out/fixture.csv` (gitignored).
- [x] **Step 5: Commit.** `git commit -m "feat: synthetic 5k fixture generator with ground truth"`


### Task C2: Dogfood precision/recall report

**Files:**
- Create: `tools/dogfoodReport.ts`
- Test: `test/tools/dogfood.test.ts`

**Interfaces:**
- Consumes: `generateFixture`, `normalizeParticipant`, `generateCandidates`, `scorePair`, `formCluster`.
- Produces: `runDogfood(rows, groundTruth, cfg): { candidateCount: number; truncated: boolean; byBand: Record<'HIGH'|'MEDIUM'|'LOW', {precision:number; recall:number; f1:number}>; recallAllSeeded: number; householdFalsePositives: number }`.

- [x] **Step 1: Write failing test (this is the dogfood gate):** on 5,000 seeded rows — `candidateCount < cfg.blocking.maxTotalCandidates`; `recallAllSeeded === 1` (every seeded duplicate appears as a candidate); `householdFalsePositives === 0` (no household-only pair reaches eligible); HIGH-band precision `>= 0.98`.
- [x] **Step 2: Run** `pnpm vitest run test/tools/dogfood.test.ts` → observe actual numbers.
- [x] **Step 3: DOGFOOD ITERATION.** If any gate fails, inspect misclassified pairs, tune only `DEFAULT_CONFIG` thresholds/weights (never hardcode), re-run. Repeat until gates pass. Record final numbers in the implementation report.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: dogfood precision/recall harness (engine gate passing)"`


# PHASE D — Repositories + scan state machine

### Task D1: SheetsGateway interface + fake

**Files:**
- Create: `src/server/sheets/SheetsGateway.ts`, `src/server/sheets/FakeSheetsGateway.ts`
- Test: `test/server/sheets/fakeGateway.test.ts`

**Interfaces:**
- Produces: `interface SheetsGateway` with only the operations the app needs: `getSpreadsheetId()`, `getTimeZone()`, `listSheets()`, `readRange(sheetName,a1)`, `readDisplayRange(...)`, `batchGet(ranges)`, `batchUpdate(request)`, `getDocumentLock()`, `getActiveUserEmail()`, `insertSheet`/`hideSheet`, etc. `FakeSheetsGateway` implements an in-memory grid + records the last `batchUpdate` request for assertions.
- **This is the only module that will later gain an Apps Script implementation.** The fake carries all logic tests.

- [x] **Step 1: Write failing test:** fake gateway round-trips a range write/read; `batchUpdate` stores the request object; `getDocumentLock()` returns a lock whose double-acquire throws `LOCK_TIMEOUT`.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** interface + fake.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: SheetsGateway interface + in-memory fake"`

---

### Task D2: Schema resolver (header detection)

**Files:**
- Create: `src/server/schemaResolver.ts`
- Test: `test/server/schemaResolver.test.ts`

**Interfaces:**
- Produces: `resolveSchema(gateway: SheetsGateway, sheetName: string, cfg: DedupConfig): SourceSchema` (§10). Throws `DedupError` with `HEADER_AMBIGUOUS` / `MISSING_REQUIRED_HEADERS` / `DUPLICATE_HEADERS`.
- Consumes: `HEADER_ALIASES`, `SheetsGateway.readDisplayRange`, `schemaHash`.

- [x] **Step 1: Write failing tests:** a sheet whose row 3 has First/Last/DOB/ZIP headers resolves with `headerRow===3` and correct `columnByCanonicalField`; missing Last → `MISSING_REQUIRED_HEADERS`; two tied header rows → `HEADER_AMBIGUOUS`; duplicate `First` columns → `DUPLICATE_HEADERS`; unmatched nonblank headers become `extraColumns`; `_Dedup_ID` excluded from extras.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** §10.2 algorithm.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: header-row schema resolver"`

---

### Task D3: System sheets + repositories

**Files:**
- Create: `src/server/systemSheets.ts`, `src/server/configRepository.ts`, `src/server/batchesRepository.ts`, `src/server/recordsRepository.ts`, `src/server/pairsRepository.ts`, `src/server/clustersRepository.ts`, `src/server/stateRepository.ts`, `src/server/auditRepository.ts`
- Test: `test/server/repositories.test.ts`

**Interfaces:**
- Produces: `ensureSystemSheets(gateway, cfg)` (§8 init/hide/migrate + schema-version header); each repository exposes typed CRUD scoped to its sheet (columns per §8.1–8.7). `configRepository.load(): DedupConfig` merges `_Dedup_Config` over `DEFAULT_CONFIG`.
- Consumes: `SheetsGateway`, `types`.

- [x] **Step 1: Write failing tests** (fake gateway): `ensureSystemSheets` creates all seven `_Dedup_*` sheets with header rows, hidden; re-running is idempotent (no duplicate sheets, migrates schema_version); records repo writes+reads a `RecordSnapshot` row; audit repo append never stores participant values in disallowed columns.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** systemSheets + repositories per §8.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: hidden system sheets + repositories"`

---

### Task D4: Identity + `_Dedup_ID` management

**Files:**
- Create: `src/server/identity.ts`, `src/server/dedupIdService.ts`
- Test: `test/server/dedupId.test.ts`

**Interfaces:**
- Produces: `resolveReviewer(gateway, fallbackName?): { email: string|null; display: string }` (§21.3 fallback); `ensureDedupIds(gateway, schema, cfg): { assigned: number }` (§11.1/11.2); `detectDuplicateIds(records): string[]` and `repairDuplicateIds(gateway, schema)` (§11.3) — repair keeps first occurrence, reassigns later ones, under document lock.
- Consumes: `SheetsGateway`, `schema`.

- [x] **Step 1: Write failing tests:** blank ID column → UUID assigned to every participant row, column hidden, `ID_ASSIGNED` audit appended without values; duplicate IDs detected → `detectDuplicateIds` returns them; `repairDuplicateIds` keeps first, reassigns rest; email unavailable → reviewer requires fallback name (AT-21).
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** §11 + §21.3.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: dedup-id assignment/repair + reviewer identity"`

---

### Task D5: Snapshot + scan state machine

**Files:**
- Create: `src/server/scan/snapshot.ts`, `src/server/scan/scanStateMachine.ts`
- Test: `test/server/scan/scanStateMachine.test.ts`

**Interfaces:**
- Produces: `snapshotBatch(gateway, schema, cfg): batchId` (§12.1 bulk reads → `RecordSnapshot[]` with fingerprints); `startScan(gateway, cfg): ScanState`; `advanceScan(gateway, cfg): ScanState` (§20 SNAPSHOTTING→GENERATING_CANDIDATES→SCORING→CLUSTERING→READY with durable cursors); phases call B7/B8/B9 pure functions and persist via repositories.
- Consumes: repositories, `generateCandidates`, `scorePair`, `formCluster`, `ensureDedupIds`, `detectDuplicateIds`.

- [x] **Step 1: Write failing integration tests** (fake gateway):
  - Full scan of a 20-row synthetic batch advances through all phases to `READY` and yields expected clusters.
  - AT-30: duplicate `_Dedup_ID` present → scan stops at `DUPLICATE_DEDUP_ID`, no clusters.
  - Cursor resume: interrupting after SCORING and calling `advanceScan` again resumes without rescoring completed pairs.
  - AT-27 (scaled): 5,000-row fixture completes through repeated `advanceScan` slices; candidate count < cap.
  - Scanning never writes participant values (assert source grid unchanged except `_Dedup_ID`).
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** §20 state machine + §12 snapshot.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: resumable scan state machine + snapshot"`

---

### Task D6: Keep All suppression

**Files:**
- Create: `src/server/review/suppression.ts`
- Test: `test/server/review/suppression.test.ts`

**Interfaces:**
- Produces: `suppressionKey(clusterMemberRelevantHashes: string[], configHash: string): string` (§19.1); `isSuppressed(key, store): boolean`; `recordKeepAll(key, store)`; scan filters clusters whose key is suppressed AND whose members’ relevant hashes are unchanged (§19.3).
- Consumes: `relevantHash`, `configHash`.

- [x] **Step 1: Write failing tests:** AT-23 Keep All unchanged → suppressed next scan; AT-24 a member row changed (relevant hash differs) → reappears; config change (configHash differs) → suppression ineligible.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** §19.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: keep-all suppression"`

---

# PHASE E — Apply pipeline

### Task E1: Merge plan (protected fields + auto-proposal + conflicts)

**Files:**
- Create: `src/server/review/mergePlan.ts`
- Test: `test/server/review/mergePlan.test.ts`

**Interfaces:**
- Produces: `buildMergePlan(cluster, decision: ClusterDecision, records: RecordSnapshot[], schema, cfg): MergePlan` where `MergePlan = { fills: Array<{retainedId:string; header:string; value:string; sourceId:string}>; deletions: Array<{deletedId:string; retainedId:string}>; conflicts: Array<{retainedId:string; header:string; options:string[]}>; ok: boolean }` (§22). Protected fields (First/Middle/Last/DOB/`_Dedup_ID`, formulas) never auto-filled (§22.3); only blank, nonconflicting fields auto-fill (§22.5); conflicting proposed values require explicit `SOURCE`/`LEAVE_BLANK` choice or `ok=false` (§22.2).
- Consumes: `RecordSnapshot`, `ClusterDecision`, `schema`. **Recomputes from snapshots — never trusts browser values.**

- [x] **Step 1: Write failing tests:** AT-14 one unambiguous blank → auto fill proposed; AT-15 blank First/DOB → never auto-filled (stays protected); AT-16 two conflicting ZIP proposals → `conflicts` entry, `ok=false` until resolved; AT-13 multiple retained → every deleted row assigned to a retained target or `ok=false`; formula field → skipped with `FORMULA_FIELD_SKIPPED`.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement** §22.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit.** `git commit -m "feat: server-side merge plan with protected fields + conflicts"`

---

### Task E2: Apply preflight (17 steps)

**Files:**
- Create: `src/server/apply/preflight.ts`
- Test: `test/server/apply/preflight.test.ts`

**Interfaces:**
- Produces: `preflight(gateway, batchId, decisions: ClusterDecision[], challenge: {token:string; summaryHash:string; confirmed:boolean}, cfg): { plan: MergePlan[]; deletionRowCount: number; summaryHash: string }` (§24). Fails closed on: stale row fingerprint (AT-22), duplicate `_Dedup_ID`, unresolved conflict, revision mismatch (§27.2), changed `summaryHash` (AT-18/challenge), unconfirmed checkbox (AT-18), already-applied decision (AT-26 idempotency, §26.3).
- Consumes: `buildMergePlan`, repositories, `rowFingerprint`, `decisionHash`.

- [ ] **Step 1: Write failing tests:** AT-18 apply without `confirmed` → rejected; AT-22 row edited after review (fingerprint changed) → `STALE_ROW`, no plan; changed summaryHash → `SUMMARY_HASH_CHANGED`; AT-26 re-preflight of an already-applied decision → no-op (no duplicate fills/deletions); revision conflict → `REVISION_CONFLICT`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the 17-step §24 sequence.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: apply preflight with fail-closed validation"`

---

### Task E3: Atomic request builder + audit

**Files:**
- Create: `src/server/apply/atomicRequest.ts`, `src/server/apply/audit.ts`
- Test: `test/server/apply/atomicRequest.test.ts`

**Interfaces:**
- Produces: `buildAtomicRequest(plan: MergePlan[], deletions, auditRows, statusUpdates, cfg): SheetsBatchUpdateRequest` (§25) — order: blank-field fills → descending row deletions → audit append → queue/batch status (§25.1); row deletions computed as descending non-overlapping intervals (§25.3); request-size guard throws `ATOMIC_REQUEST_TOO_LARGE` above `maxAtomicApplyRequests` (§25.6). `composeAuditRows(...)` includes deleted-row snapshots (§25.4), user-attributed.
- Consumes: `MergePlan`, `DedupConfig.execution.maxAtomicApplyRequests`.

- [ ] **Step 1: Write failing tests:** deletions for rows [5,3,8] emit descending intervals [8,5,3]; request array ordering matches §25.1; exceeding request cap → `ATOMIC_REQUEST_TOO_LARGE`; audit rows contain deleted snapshot + reviewer, and are part of the SAME request object (atomicity); AT-29 an invalid sub-request means the whole request is one unit (builder produces a single batchUpdate, not multiple).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** §25.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: atomic batchUpdate builder + audit composition"`

---

### Task E4: Apply executor (wires preflight → gateway.batchUpdate)

**Files:**
- Create: `src/server/apply/applyDecisions.ts`
- Test: `test/server/apply/applyDecisions.test.ts`

**Interfaces:**
- Produces: `applyDecisions(gateway, batchId, decisions, challenge, cfg): { deletedRows: number; filledFields: number; auditWritten: number }` — acquires document lock, runs `preflight`, builds atomic request, calls `gateway.batchUpdate` once, marks decisions applied with `applyBatchId` (§26.2).
- Consumes: E1–E3 + `SheetsGateway`.

- [ ] **Step 1: Write failing integration tests** (fake gateway): AT-19 confirmed deletion → source row removed in fake grid + audit snapshot present; AT-17 saving a decision (no apply) changes no source values; AT-26 second `applyDecisions` with same decisions → idempotent no-op; lock timeout → fail closed.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: atomic apply executor"`

---

# PHASE F — Sidebar + entry points

### Task F1: RPC layer + envelope

**Files:**
- Create: `src/server/rpc.ts`, `src/server/menu.ts`, `src/server/globals.ts`
- Test: `test/server/rpc.test.ts`

**Interfaces:**
- Produces: RPC handlers returning the §6.2 envelope `{ ok: true; data } | { ok: false; error: {code; message} }`: `rpcBootstrap`, `rpcStartScan`, `rpcAdvanceScan`, `rpcGetQueuePage` (§21.5), `rpcGetCluster`, `rpcSaveDecision`, `rpcGetBatchSummary` (§23), `rpcPreviewApply`, `rpcApply`, `rpcGetHistory` (§28.1), `rpcRepairDuplicateIds`. `globals.ts` exposes `onOpen` + each `rpc*` as a global for `google.script.run`. `menu.ts` builds the `Deduplication` menu (§6.1). Each handler wraps errors into the envelope; never leaks PII in `error.message`.
- Consumes: all server modules via a small composition root that constructs the live `SheetsGateway`.

- [ ] **Step 1: Write failing tests:** each `rpc*` returns a well-formed envelope on success and `{ok:false}` with a safe code on thrown `DedupError`; `rpcApply` without confirmation → `{ok:false}`; envelope never contains a stack trace.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** rpc/menu/globals. Inject the gateway so tests use the fake.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: RPC envelope + entry points + menu"`

---

### Task F2: Vanilla sidebar

**Files:**
- Create: `src/client/Sidebar.html`, `src/client/sidebar.js`, `src/client/sidebar.css`
- Test: `test/client/sidebar.render.test.ts` (jsdom)

**Interfaces:**
- Produces: views (§21.1) Scan / Queue / Cluster review / Summary / Confirm / History; renders every participant value via `textContent` (§21.8, never innerHTML); default queue filter High+Medium (AT-25); identity fallback stored in `sessionStorage` only (§21.3); calls `google.script.run` for each `rpc*`.

- [ ] **Step 1: Write failing jsdom test:** a render function given a cluster with a value containing `<script>` inserts it via `textContent` (assert `el.innerHTML` shows escaped text, no live node); default filter shows only HIGH/MEDIUM rows.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the sidebar. Keep DOM-building functions pure/importable so jsdom can test them without Apps Script.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: vanilla sidebar with safe textContent rendering"`

---

# PHASE G — Packaging + verification

### Task G1: esbuild bundle → dist/

**Files:**
- Create: `build/esbuild.mjs`
- Test: `test/build/dist.test.ts`

**Interfaces:**
- Produces: `pnpm build` emits `dist/Code.js` (IIFE, ES2019, all globals attached to `globalThis`), `dist/Sidebar.html` (sidebar.js + css inlined, no remote assets), `dist/appsscript.json`.

- [ ] **Step 1: Write failing test:** after build, `dist/Code.js` exists, contains `function onOpen`, contains NO `import`/`require`/`UrlFetchApp`/`http`; `dist/Sidebar.html` contains no `src="http`/`href="http`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** esbuild config (bundle server as IIFE, define globals; inline sidebar assets).
- [ ] **Step 4: Run** `pnpm build && pnpm vitest run test/build/dist.test.ts` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "build: esbuild bundle to dist/"`

---

### Task G2: Static safety + full-suite gate

**Files:**
- Create: `test/static/noExternalCalls.test.ts`, `test/static/noPii.test.ts`

**Interfaces:**
- Produces: tests that scan `src/**` for `UrlFetchApp`, `fetch(`, `http://`, `https://` (allow only in comments/spec refs), and for hardcoded spreadsheet-id-shaped strings; assert fixtures/tests contain no real-name denylist.

- [ ] **Step 1: Write** the static scans (AT-28 proxy: no external-call constructs in source).
- [ ] **Step 2: Run** full ladder: `pnpm typecheck && pnpm vitest run && pnpm build`. Expected: all PASS.
- [ ] **Step 3: Fix** any failures.
- [ ] **Step 4: Commit.** `git commit -m "test: static no-external-call + no-PII gates; full suite green"`

---

### Task G3: README + implementation report + clasp config

**Files:**
- Create: `README.md`, `docs/IMPLEMENTATION_REPORT.md`, `.clasp.json.example`

**Interfaces:**
- Produces: README with setup/build/test/push/authorization/Advanced-Sheets-enable/UAT steps (§36 items 6–8); implementation report listing tests run, dogfood precision/recall numbers, assumptions, deviations, remaining risks (broader `spreadsheets` scope, collaborative-edit race, audit tamper limits — §36 items 3/10); `.clasp.json.example` (no real script ID committed).

- [ ] **Step 1: Write** README with the exact owner hand-off checklist (clasp login → clasp push to a **copy** → enable Advanced Sheets → authorize → UAT). All commands use pnpm.
- [ ] **Step 2: Write** implementation report from actual test/dogfood output.
- [ ] **Step 3: Run** `pnpm typecheck && pnpm vitest run && pnpm build` once more → PASS.
- [ ] **Step 4: Commit.** `git commit -m "docs: README + implementation report + clasp example"`

---

### Task G4: Acceptance matrix validation

**Files:**
- Create: `test/acceptance/matrix.test.ts` (aggregates/labels AT-01…AT-30 across existing tests, marks live-only ones as documented-manual)

- [ ] **Step 1: Write** a matrix test file that references each AT-01…AT-30 by id, asserting the automatable ones pass and explicitly `.skip`-documenting the live-only ones (AT-19 real deletion is covered via fake gateway; AT-27 scaled; AT-28 via static scan; the truly-live perf/network items are marked for owner UAT).
- [ ] **Step 2: Run** → PASS/skip as designed.
- [ ] **Step 3: Commit.** `git commit -m "test: acceptance matrix coverage map"`

---

## Self-Review Notes (author checklist run against spec)

- **Spec coverage:** §7 types→A5; §8 sheets→D3; §9 config→A2; §10 headers→D2; §11 IDs→D4; §12 snapshot/fingerprints→A4+D5; §13 normalization→B1–B4; §14 candidates→B8; §15 similarity→B5–B6; §16 scoring→B7; §17 scoring phase→D5; §18 clusters→B9; §19 suppression→D6; §20 scan→D5; §21 sidebar→F2; §22 merge→E1; §23 summary→F1(rpcGetBatchSummary); §24 preflight→E2; §25 atomic→E3; §26 idempotency→E2/E4; §27 concurrency/stale→E2/E4; §28 history→F1(rpcGetHistory); §29 errors→A3; §31 privacy→G2; §32 tests→throughout; §33 matrix→G4; §34 sequence→phase order; §35 DoD→G1–G4. No gaps found.
- **Placeholder scan:** algorithm bodies intentionally cite spec sections (executor has the spec on disk); every task carries concrete signatures, test vectors, and commands. No "TODO/handle edge cases" left in steps.
- **Type consistency:** `NormalizedName`/`NormalizedAddress`/`PairScore`/`ClusterDecision` names match §7/§13 verbatim; gateway method names consistent D1→F1; `MergePlan` shape consistent E1→E4.
