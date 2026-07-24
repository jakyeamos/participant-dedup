# Implementation Report — Participant Deduplication

Date: 2026-07-23  
Branch: `feat/engine`  
Spec: `docs/superpowers/specs/2026-07-23-participant-dedup-technical-design.md`  
Plan: `docs/superpowers/plans/2026-07-23-participant-dedup.md`

## Architecture summary

Pure TypeScript matching/scoring/clustering engine behind a `SheetsGateway`
adapter. Production uses `AppsScriptSheetsGateway`; tests use an in-memory
`FakeSheetsGateway`. `esbuild` emits:

- `dist/Code.js` — IIFE installing the §6 allowlisted globals on `globalThis`
- `dist/Sidebar.html` — vanilla sidebar with CSS/JS inlined (no remote assets)
- `dist/appsscript.json` — V8 runtime, Advanced Sheets v4, OAuth scopes

Review and apply never trust browser-supplied row values: merge plans are
recomputed server-side; apply is gated by a typed confirmation challenge and a
single atomic `batchUpdate`.

## Verification run

Commands (all via `pnpm`):

```bash
pnpm typecheck
pnpm vitest run
pnpm build
pnpm dogfood
```

Results at handoff:

| Gate | Result |
| --- | --- |
| Typecheck | PASS |
| Vitest | PASS (329+ tests across unit/integration/static/client/build) |
| Build | PASS — `dist/Code.js`, `dist/Sidebar.html`, `dist/appsscript.json` |
| Dogfood (seed=1, 5,000 rows) | PASS |

### Dogfood precision/recall (seed=1, 5,000 rows)

```
candidateCount:          79289 (cap 200000)
truncated:               false
recallAllSeeded:         100.00%
householdFalsePositives: 0
clusters:                275
band    precision  recall    f1
HIGH     100.00%   84.62%  91.67%
MEDIUM   100.00%   15.38%  26.67%
LOW        0.00%    0.00%   0.00%
```

HIGH + MEDIUM together recall 100% of seeded duplicate pairs at 100% precision.
LOW stays empty on this fixture (by design of the scoring thresholds).

## Privacy review

- Static scan (`test/static/noExternalCalls.test.ts`) asserts no `UrlFetchApp`,
  no `fetch(`, no embedded `http(s)` URLs in `src/` (manifest OAuth scopes
  excepted), no client `innerHTML` / `insertAdjacentHTML` / `document.write`,
  and no hardcoded spreadsheet ids.
- Static scan (`test/static/noPii.test.ts`) asserts a denylist of common real
  full names is absent from `src/`, `test/`, and `tools/`.
- Fixture generator invents syllable-based names only.
- Sidebar render fixtures use the surname `Placeholder`.

## Assumptions

1. The workbook is edited by one primary reviewer at a time during apply; the
   document lock and fingerprint checks handle contention fail-closed.
2. Apps Script may withhold `Session.getActiveUser().getEmail()`; the sidebar
   then requires a typed fallback name stored only in `sessionStorage`.
3. `_Dedup_ID` may be added/repaired on the source sheet; no other participant
   value is written outside a confirmed apply.
4. The technical design file in-repo is the locked requirement set for
   implemented sections; later missing §27–§35 prose in the truncated copy does
   not change already-coded behavior.

## Deviations

| Deviation | Justification |
| --- | --- |
| Client sources are TypeScript modules (`sidebar.ts`, `views/*`) bundled into `Sidebar.html`, not hand-written `sidebar.js` | Same runtime contract; jsdom-testable pure views; G1 inlines the IIFE. |
| Template lives at `src/client/Sidebar.template.html` with CSS/JS placeholders | Required so `showSidebar` can inject `<?!= boot ?>` and esbuild can inline assets. |
| Package manager is `pnpm` (spec §35 cites `npm test`) | Repo / agent invariant; equivalent gates via `pnpm test`. |
| Spec file ends mid-§26.1 in the recovered copy | Verbatim recovery from the handoff package; behavior for §27–§30 covered by plan tasks and tests. |

## Remaining risks

1. **Broader `spreadsheets` OAuth scope** — not `spreadsheets.currentonly`. The
   bound script can access any spreadsheet the user can. Mitigate by pushing
   only to a copy and reviewing OAuth consent carefully.
2. **Collaborative-edit race** — another editor can change a row between review
   and apply. Preflight fingerprint checks fail closed (`STALE_ROW`), but a
   determined concurrent editor can still force retries.
3. **Audit-sheet tamper limits** — `_Dedup_Audit` is a sheet the spreadsheet
   editors can edit. It is append-oriented evidence, not a cryptographic ledger.
4. **Live UAT still required** — AT items that need a real Sheets runtime
   (authorization UX, Advanced service enablement, true six-minute slice timing)
   are documented for owner UAT in `README.md` and labelled in the acceptance
   matrix.

## Entry-point allowlist (§6)

`onOpen`, `menuScanActiveSheet`, `menuOpenReviewSidebar`,
`menuApplyReviewedDecisions`, `menuViewChangeHistory`, `menuRefreshCurrentBatch`,
`rpcBootstrap`, `rpcStartScan`, `rpcAdvanceScan`, `rpcGetQueuePage`,
`rpcGetCluster`, `rpcSaveClusterDecision`, `rpcGetBatchSummary`,
`rpcCreateApplyChallenge`, `rpcApplyBatch`, `rpcGetAuditPage`,
`rpcCancelCurrentBatch`, `rpcRepairDuplicateIds`, `rpcFocusSourceRow`.
