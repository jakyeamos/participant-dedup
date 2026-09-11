# Participant Deduplication (Google Sheets)

Container-bound Google Apps Script that finds fuzzy duplicate participant rows,
lets a reviewer decide what to keep, and applies deletions atomically with an
audit trail. Matching runs on an owned Railway backend for large sheets; review and apply stay
inside the spreadsheet sidebar. No third-party matching APIs, no remote sidebar
assets, and no participant data in the repository.

## Quality evidence checkpoint

Last reviewed: 2026-08-11.

The repository instructions, completion checks, and executable quality commands
were reviewed on this date. This checkpoint keeps the evidence current; it
does not claim that every check passes. Re-run the documented checks and the
fleet audit when these contracts or the target branch changes.

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io/)
- A Google account that can edit a **copy** of the target workbook
- [`clasp`](https://github.com/google/clasp) (installed via this repo's `pnpm` deps)
- For production-scale scans: a Railway service + Google service account
  (see [`docs/BACKEND.md`](docs/BACKEND.md))

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` writes clasp-ready artifacts to `dist/`:

- `dist/Code.js` — server IIFE with the §6 global entry points
- `dist/Sidebar.html` — sidebar with CSS/JS inlined
- `dist/appsscript.json` — Apps Script manifest (Advanced Sheets + OAuth scopes)

## Owner hand-off checklist

Do **not** push to the production participant workbook. Always use a copy.

1. **Login**
   ```bash
   pnpm exec clasp login
   ```
2. **Create a bound script on a workbook copy** (or reuse an empty bound project):
   ```bash
   cp .clasp.json.example .clasp.json
   # Edit .clasp.json and set scriptId to the copy's Apps Script project id.
   ```
3. **Push the build**
   ```bash
   pnpm push
   ```
   `.clasp.json` sets `rootDir` to `dist`, so clasp uploads only the built
   artifacts.
4. **Enable Advanced Sheets service**
   - Open the Apps Script project → **Services** → add **Google Sheets API**
     (`Sheets`, v4) if the manifest did not enable it automatically.
5. **Configure the Railway scan backend** (required for large sheets)
   - Follow [`docs/BACKEND.md`](docs/BACKEND.md).
   - Set Script Properties `DEDUP_API_URL` and `DEDUP_API_KEY`.
   - Share the workbook with the service account as Editor.
6. **Authorize**
   - Open the bound spreadsheet copy.
   - Run **Deduplication → Open Review Sidebar** once and accept the OAuth
     prompts (`spreadsheets`, `script.container.ui`, `userinfo.email`,
     `script.external_request`).
7. **UAT on the copy** (synthetic or redacted data only)
   - [ ] Scan Active Sheet completes through to a review queue
   - [ ] Hostile cell text like `<script>` renders as text, not markup
   - [ ] Default queue shows High + Medium only
   - [ ] Saving a decision does not change participant values
   - [ ] Apply without typing `confirm` is rejected
   - [ ] Confirmed apply deletes only the reviewed rows and writes audit history
   - [ ] Re-running apply is a no-op
   - [ ] Editing a reviewed row marks the cluster stale and blocks apply
   - [ ] Keep All suppresses an unchanged group on the next scan
   - [ ] Duplicate `_Dedup_ID` values stop the scan until Repair Duplicate IDs runs

## Sharing with coworkers

Use the lane that matches how portable the tool needs to be.

### Template workbook

For a small group or one-off UAT, share a spreadsheet copy that already has the
script bound to it. The coworker makes a copy, imports or pastes their
participant data into a tab, and runs **Deduplication → Scan Active Sheet**.
Share that copy with the scan **service account** as Editor so Railway can run.

### Sheets Editor Add-on

For coworkers who need to run the tool on their own spreadsheet files, use the
standalone add-on lane:

```bash
cp .clasp.addon.json.example .clasp.addon.json
pnpm addon:push
```

The real `.clasp.addon.json` points at a standalone Apps Script project and is
ignored by git. Coworkers install the add-on once, open any non-production
spreadsheet they can edit, and run the Deduplication menu there. Each workbook
must still be shared with the service account; Script Properties on the add-on
project hold `DEDUP_API_URL` / `DEDUP_API_KEY`.

See [`docs/ADDON_PACKAGING.md`](docs/ADDON_PACKAGING.md) for standalone project,
OAuth, test deployment, and internal Workspace publishing steps. See
[`docs/BACKEND.md`](docs/BACKEND.md) for Railway + service-account setup.

## Useful scripts

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Strict TypeScript |
| `pnpm test` | Full vitest suite |
| `pnpm build` | Emit `dist/` |
| `pnpm api:dev` / `pnpm api:start` | Run the Railway scan API locally |
| `pnpm push` | Build and push to the workbook-bound `.clasp.json` target |
| `pnpm addon:push` | Build and push to the standalone add-on target |
| `pnpm addon:version` | Create an immutable Apps Script add-on version |
| `pnpm addon:deploy` | Create an Apps Script deployment from the add-on target |
| `pnpm fixture` | Write a synthetic CSV under `tools/out/` |
| `pnpm dogfood` | Precision/recall gate on 5,000 synthetic rows |
| `pnpm sheet-dogfood` | End-to-end scan→queue→apply rehearsal on a CSV via FakeSheetsGateway |
| `pnpm dedup …` | Local CLI — simple: `scan` / `review` / `apply` after `dedup.config.json` ([`docs/COWORKER.md`](docs/COWORKER.md)) |
| `pnpm dedup:compile` | Build standalone `dist-bin/dedup` with Bun |

## Live Google Sheet dogfood

1. Generate a synthetic workbook CSV (no real participant data):
   ```bash
   pnpm exec tsx -e 'import {writeFileSync,mkdirSync} from "fs"; import {generateFixture,HEADERS} from "./tools/generateFixture.ts"; mkdirSync("tools/out",{recursive:true}); const {rows,groundTruth}=generateFixture(42,80); const esc=v=>/[",\n]/.test(v)?`"${v.replace(/"/g,"\"\"")}"`:v; writeFileSync("tools/out/uat-participants-80.csv",[HEADERS.join(","),...rows.map(r=>HEADERS.map(h=>esc(r[h]??"")).join(","))].join("\n")); writeFileSync("tools/out/uat-ground-truth-80.json",JSON.stringify(groundTruth,null,2));'
   ```
   Or reuse `tools/out/uat-participants-80.csv` if already generated.
2. Rehearse locally first:
   ```bash
   pnpm sheet-dogfood tools/out/uat-participants-80.csv tools/out/uat-ground-truth-80.json
   ```
3. Create a **new** Google Sheet (never the production workbook), import the CSV
   (File → Import → Upload), rename it something like `participant-dedup UAT`.
4. Follow the owner hand-off checklist above (`clasp login` → push to a bound
   copy → Advanced Sheets → authorize → UAT).

Live sheet creation from this agent requires you to be signed into Google in the
browser session it opens.
## Privacy

- No real participant data in `src/`, `test/`, or `tools/`.
- Fixtures use invented names only.
- The client renders sheet values with `textContent` only — never `innerHTML`.
- Runtime code makes no `UrlFetchApp` / `fetch` / remote asset calls.

See `docs/IMPLEMENTATION_REPORT.md` for dogfood numbers, assumptions, deviations,
and remaining risks.

## Behavior intent and proof

The approved [product requirements](README.md) are linked to exact source and proof in [Compass](.project-compass/development.json), with change routing in the [surface matrix](.agents/change-surface-matrix.json). Local synthetic fixtures do not establish Apps Script, live Sheets or Railway deployment and reviewer UAT. Production participant data and automatic deletion remain outside this bootstrap.
