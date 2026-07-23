# participant-dedup — Build & Dogfood Design

**Date:** 2026-07-23
**Status:** Approved
**Scope:** This document specifies *how the application is built and validated*. It does **not** restate or alter the product requirements, which are locked in the owner's handoff package (`google_sheets_dedup_technical_design.md`, `codex_implementation_prompt.md`, in `~/Downloads/google_sheets_dedup_codex_handoff/`) under "Approved Requirements That Must Not Be Changed". That package is treated as read-only external material and is not vendored into this repo. Where this doc and the spec disagree, the spec wins.

## 1. Goal

Deliver a production-ready, container-bound Google Apps Script participant-deduplication application per the locked technical design, validated to a level of confidence achievable without the owner's live Google authorization, plus a precise hand-off checklist for the owner-gated live steps.

## 2. Constraints (from the locked spec)

- No automatic row deletion; no participant value mutated during scan/review (only `_Dedup_ID` added/repaired).
- All matching stays inside Apps Script / Sheets — **no external service calls** (no `UrlFetchApp`).
- No real participant data in repo, tests, logs, or fixtures.
- No hardcoded spreadsheet ID, sheet ID, row count, or participant values.
- Do not deploy to or modify the production spreadsheet.
- TypeScript strict; esbuild bundle to Apps Script-compatible JS; vanilla HTML sidebar; Advanced Sheets service v4; single atomic `batchUpdate` for apply; `LockService.getDocumentLock()`; fail-closed on stale data / dup IDs / unresolved conflicts / changed summary hash / lock timeout / oversized request.

## 3. Repository layout

Follows technical-design §4 exactly:

```
participant-dedup/
├── src/
│   ├── server/
│   │   ├── globals.ts, menu.ts, rpc.ts        # global + RPC entry points (§6)
│   │   ├── config.ts, errors.ts, types.ts
│   │   ├── identity.ts, hashing.ts            # _Dedup_ID UUIDs, SHA-256 fingerprints
│   │   ├── systemSheets.ts, schemaResolver.ts # hidden _Dedup_ sheets, header aliases (§8, §10)
│   │   ├── *Repository.ts                     # per-sheet data access
│   │   ├── sheets/SheetsGateway.ts            # ONLY Advanced Sheets adapter (the seam)
│   │   ├── scan/                              # snapshot→candidates→score→cluster (§20)
│   │   ├── match/                             # jaroWinkler, softToken, normalize, blocking, score, cluster
│   │   ├── review/                            # cluster views, merge proposals, suppression (§19, §21, §22)
│   │   └── apply/                             # 17-step preflight, atomic request builder, audit (§24, §25)
│   ├── client/                               # Sidebar.html + vanilla JS/CSS
│   └── shared/                               # constants, pure types
├── test/                                     # vitest: unit + integration (synthetic only)
├── tools/                                    # 5,000-row fixture generator
├── dist/                                     # esbuild output: Code.js, Sidebar.html, appsscript.json
├── build/                                    # esbuild config
└── README.md, package.json, tsconfig.json
```

### Architectural seam (the load-bearing decision)

All Apps Script globals and `Sheets.*` calls live behind **one** adapter, `SheetsGateway`. Everything in `match/`, the logic of `scan/`, `review/`, and the request-building of `apply/` is **pure** — no Apps Script imports. Consequences:

- The entire matching/scoring/clustering brain runs under vitest against an **in-memory fake gateway**, with zero Google dependency.
- Autonomous dogfooding of match quality is possible without the owner's OAuth.
- The Apps Script boundary is thin and reviewable in isolation for the "no external calls" static check.

## 4. Build sequence (engine-first)

The spec's seven phases are resequenced so match quality is proven before UI is built on top of it.

| Phase | Builds | Gate |
|-------|--------|------|
| **A. Foundation** | `types`, `config` (DEFAULT_CONFIG §9), `errors`, `hashing`, `identity`, normalization (§13) | typecheck + unit |
| **B. Matching engine** | Jaro-Winkler (§15), soft-token F1, trigram blocking (§10), scoring + confidence + eligibility (§16), union-find clustering (§18) | unit tests + **dogfood loop 1** |
| **C. Fixture + dogfood** | 5,000-row synthetic generator emitting ground-truth labels; run engine over it; measure precision/recall; tune thresholds | **dogfood loop 2** |
| **D. Repositories + scan** | hidden system sheets (§8), repositories, resumable scan state machine (§20), suppression (§19), stale-data detection | integration tests (fake gateway) |
| **E. Apply pipeline** | 17-step preflight (§24), atomic `batchUpdate` builder (§25), audit writes, idempotency, fail-closed paths | integration tests |
| **F. Sidebar + entry points** | `menu`, `onOpen`, all `rpc*` (§6), vanilla sidebar (§21), `textContent`-only rendering | build + DOM smoke |
| **G. Packaging** | esbuild → `dist/`, README, implementation report, full acceptance matrix AT-01…AT-30 | full quality ladder |

### Dogfood loops (B & C)

The fixture generator produces dirty records with known ground truth: misspellings, missing middle names, parenthetical aliases `(alias)`, reordered name tokens, swapped first/last fields, `01/01/1900` placeholders, conflicting valid DOBs, partial addresses/ZIPs. The engine runs over them and its clusters + confidence bands are scored against ground truth (precision/recall/F1 per confidence band). Tuning targets:

- HIGH band: very high precision (few false merges) — this is what auto-fills blanks.
- Conflicting valid DOB → capped at LOW with warning.
- Strong name-only match → capped at LOW.
- `01/01/1900` never contributes DOB evidence.

Iteration continues until the precision/recall report on synthetic data is defensible.

## 5. Testing approach

- **Unit** — every `match/` function with hand-built vectors: normalization rules, Jaro-Winkler values, soft-token F1, scoring weights/penalties, confidence caps (DOB-conflict→LOW, name-only→LOW), eligibility.
- **Integration** — scan→cluster→apply driven through the **fake in-memory gateway**: atomic-request shape, descending-row-deletion ordering, audit-append contents, suppression via content+config hashes, idempotency via decision hashes, and every fail-closed path (stale fingerprint, duplicate `_Dedup_ID`, unresolved conflict, changed `summaryHash`, lock timeout, oversized atomic request).
- **Static review** — assert no `UrlFetchApp`/external calls, no hardcoded spreadsheet/sheet IDs, no real PII, `textContent`-only participant rendering.
- **No real participant data** anywhere; all fixtures synthetic and generated.

## 6. Dogfooding boundary & deliverables

### Autonomous (this session)
Typecheck, full vitest suite, production build, 5,000-row fixture, precision/recall dogfood report. Covers the bulk of acceptance matrix AT-01…AT-30 except live-sheet-only items (actual row deletion, network inspection, live 5k performance timing).

### Test Google Sheet
A synthetic CSV (no real PII) is created as a Google Sheet in the owner's Drive via the Drive connector — real data to point the installed script at.

### Owner-gated (hand-off checklist in README + implementation report)
`clasp login` → `clasp push` to a container-bound script on a **copy** of the test sheet → enable Advanced Sheets service → authorize scopes → exercise sidebar → apply. No production spreadsheet is touched. These steps require the owner's Google OAuth in a browser and cannot be performed autonomously.

## 7. Definition of done

Maps to technical-design §35. Complete when: repo matches §4; manifest enables Advanced Sheets + only required scopes; build emits `dist/Code.js`, `dist/Sidebar.html`, `dist/appsscript.json`; all global/RPC entry points present; system-sheet init + migration implemented; full matching/scoring/clustering/review/merge/apply/audit/suppression/stale/idempotency behavior implemented with no TODO placeholders in required paths; unit + integration tests pass on synthetic data; 5,000-row fixture generated; README + implementation report written; acceptance matrix validated to the autonomous boundary; static review confirms no external calls and no real PII.

## 8. Risks

- **Live-execution gap** — atomic apply, sidebar UX, and live 5k performance can only be fully verified by the owner post-push. Mitigated by exhaustive integration tests against the fake gateway that assert exact request shapes.
- **Apps Script V8 vs Node divergence** — esbuild target and a lint pass for Apps-Script-incompatible constructs (no Node built-ins in server bundle) guard this.
- **Threshold tuning generalization** — synthetic data may not mirror real dirtiness. Mitigated by making all thresholds live in `DEFAULT_CONFIG` and documenting how the owner re-tunes on a workbook copy.
