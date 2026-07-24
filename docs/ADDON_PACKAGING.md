# Sheets Editor Add-on Packaging

This project can ship in two lanes:

- **Container-bound UAT:** push to one copied spreadsheet with `.clasp.json`.
- **Sheets Editor Add-on:** push to one standalone Apps Script project with
  `.clasp.addon.json`, then install the add-on into any spreadsheet.

The add-on lane preserves the existing HTML sidebar. It is intentionally not a
CardService Google Workspace Add-on.

## One-time add-on project setup

1. Build the clasp-ready artifacts:

   ```bash
   pnpm build
   ```

2. Create a standalone Apps Script project for the add-on:

   ```bash
   pnpm exec clasp -P .clasp.addon.json create \
     --type standalone \
     --title "Participant Dedup Add-on" \
     --rootDir dist
   ```

   If you create the project in the Apps Script UI instead, copy the template:

   ```bash
   cp .clasp.addon.json.example .clasp.addon.json
   ```

   Then replace `REPLACE_WITH_STANDALONE_ADDON_SCRIPT_ID` with the standalone
   project's script ID.

3. Link the Apps Script project to a Google Cloud project owned by your org:

   - Apps Script → **Project Settings**
   - **Google Cloud Platform project** → Change project
   - Use the org-owned GCP project number

4. Configure OAuth consent:

   - Use **Internal** when all users are in the same Google Workspace domain.
   - Use External + test users only for mixed-domain testing.
   - Keep the scopes aligned with `src/appsscript.json`.

5. Confirm the Advanced Sheets service is present:

   - Apps Script → **Services**
   - Add **Google Sheets API** (`Sheets`, v4) if it is missing

## Push and test as an add-on

1. Push the current build to the standalone add-on project:

   ```bash
   pnpm addon:push
   ```

2. In Apps Script, create a test deployment:

   - **Deploy** → **Test deployments**
   - Choose the editor add-on test deployment
   - Install it for your account and select a non-production spreadsheet

3. Open that spreadsheet and run:

   - **Extensions** → add-on menu → **Deduplication** → **Open Review Sidebar**
   - Accept OAuth prompts
   - Select a participant tab and run **Scan Active Sheet**

4. Repeat with one coworker on a separate non-production workbook. The add-on
   should create `_Dedup_*` sheets inside that workbook. Share each test
   workbook with the Railway service account (Editor) and ensure the add-on
   project Script Properties include `DEDUP_API_URL` and `DEDUP_API_KEY`
   (see [`BACKEND.md`](BACKEND.md)).

## Versioned internal publish

After the test deployment passes:

1. Create an immutable Apps Script version:

   ```bash
   pnpm addon:version -- "Internal add-on UAT"
   ```

2. Create or update the add-on deployment from that version in Apps Script.
3. Publish through the Google Workspace Marketplace SDK with visibility limited
   to the Workspace domain.
4. Have coworkers install from the internal listing, then open their own
   spreadsheet and use the Deduplication menu.

## Operational notes

- Keep `.clasp.addon.json` local. It contains the real standalone add-on script
  ID and is ignored by git.
- Keep `.clasp.json` for the copied workbook UAT lane.
- Do not install into production workbooks until the same README UAT checklist
  passes on copied or synthetic sheets.
- Each workbook gets its own `_Dedup_*` system sheets; scan compute runs on the
  owned Railway API, while review/apply stay in Apps Script.
- Matching never calls third-party APIs. Participant rows leave the sheet only
  for that owned backend (service-account Sheets access).
