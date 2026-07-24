# Railway scan backend

Matching for large sheets runs on a small Node API you host on Railway. The
Sheets sidebar and apply flow stay in Apps Script. Coworkers do **not** need the
git repo — only the add-on and a workbook shared with the service account.

## Architecture

1. Sidebar calls `rpcStartScan`.
2. Apps Script `UrlFetchApp` POSTs to `DEDUP_API_URL/v1/scans` with the
   spreadsheet id + sheet name (not row payloads).
3. Railway loads the workbook with a Google **service account**, runs the same
   sync scan engine in memory, then writes `_Dedup_*` sheets and `_Dedup_ID`.
4. Review / apply continue in Apps Script against those sheets.

## One-time setup

### 1. Google service account

1. In your GCP project, create a service account with no unused roles.
2. Create a JSON key. You will paste the JSON into Railway as
   `GOOGLE_SERVICE_ACCOUNT_JSON`.
3. Note the `client_email` (looks like `…@….iam.gserviceaccount.com`).

### 2. Railway

1. Create a Railway project from this repo.
2. Set start command to `pnpm api:start` (see `railway.toml`).
3. Set variables (see `services/api/.env.example`):
   - `API_KEY` — long random string
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — full service-account JSON
   - `PORT` — Railway usually injects this
4. Deploy and copy the public HTTPS base URL (no trailing slash).

### 3. Share each workbook

For every spreadsheet that will be scanned, share it with the service account
email as **Editor**. Without that share, the backend cannot read or write.

### 4. Apps Script / add-on Script Properties

In the bound project or standalone add-on project:

**Project Settings → Script properties**

| Property | Value |
| --- | --- |
| `DEDUP_API_URL` | `https://your-service.up.railway.app` |
| `DEDUP_API_KEY` | same as Railway `API_KEY` |

Emergency only: set `DEDUP_USE_LOCAL_SCAN` = `1` to force the old in-Apps-Script
scan path (slow / timeout-prone on large sheets).

Re-authorize after adding the `script.external_request` scope
(`pnpm push` / `pnpm addon:push`, then open the sidebar once).

## Local API development

```bash
export API_KEY=dev-key
export GOOGLE_SERVICE_ACCOUNT_JSON="$(cat ./sa.json)"
pnpm api:dev
```

Point a UAT script's `DEDUP_API_URL` at `http://localhost:3000` only when using
clasp push to a personal test project that can reach your machine (tunnel).

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | No auth |
| POST | `/v1/scans` | Header `X-Api-Key`. Body: `{ spreadsheetId, sheetName, fallbackName? }` |
| GET | `/v1/scans/:batchId?spreadsheetId=` | Status from sheet after flush |
| POST | `/v1/scans/:batchId/cancel` | Body includes `spreadsheetId` |

## Performance notes

- The API loads only the source participant sheet plus `_Dedup_*` system sheets
  (not every tab in the workbook).
- While a scan runs, it flushes batch progress periodically so the sidebar can
  poll phase/metrics; the full records/clusters write happens at the end.
- Candidate generation is capped (`maxTotalCandidates`, tighter fuzzy/token
  limits). Truncation and high volume surface as scan warnings.
- `GET /v1/scans/:id` responses include `timings` (`loadMs`, `scanMs`, `flushMs`,
  `sheetsLoaded`, `progressFlushes`) for live speed checks after deploy.

Local engine bench (no Google I/O):

```bash
pnpm exec tsx tools/benchScan.ts
```

## Security notes

- Do not log participant cell values.
- Do not commit service-account JSON or `API_KEY`.
- Requirement 25: matching runs only on this owned backend — no third-party
  matching APIs.
