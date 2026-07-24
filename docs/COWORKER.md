# Coworker quick start (no flags)

You only need three words after setup: **scan**, **review**, **apply**.

## One-time setup (someone technical does this once)

1. Copy the config and fill in the tab name (bottom of the Google Sheet):
   ```bash
   cp dedup.config.example.json dedup.config.json
   ```
   Edit `dedup.config.json`:
   - `sheet` — exact tab name from the spreadsheet
   - `saJson` — path to the service-account JSON (or keep `./sa.json`)
2. Put the service-account file at that path.
3. Share the Google Sheet with the service account email as **Editor**.
4. Give them a folder containing:
   - **Windows:** `dedup.exe` + `Dedup.bat` + `dedup.config.json` + `sa.json`
   - **Mac:** `dedup` + `Dedup.command` + `dedup.config.json` + `sa.json`
   - this doc (`docs/COWORKER.md`)

Build binaries (on a machine with Bun):

```bash
pnpm dedup:compile
# writes dist-bin/dedup (Mac) and dist-bin/dedup.exe (Windows)
```

Or download `dedup.exe` from the GitHub **Releases** page for this repo.

## Everyday use (Windows)

1. Open the folder in File Explorer.
2. Double-click **`Dedup.bat`** and pick `1` / `2` / `3`,  
   **or** open PowerShell/Command Prompt in that folder:

```bat
dedup.exe scan
dedup.exe review
dedup.exe apply
```

Shortcuts: `dedup.exe s` · `dedup.exe r` · `dedup.exe a`

| Command | What it does |
| --- | --- |
| `scan` | Find possible duplicates |
| `review` | Walk through matches and choose what to keep |
| `apply` | Delete the rows you marked (asks you to confirm) |

No `--spreadsheet`, `--backend`, or `--sheet` flags needed once `dedup.config.json` is set.

**Tip:** Windows may warn on the first run of an unsigned `.exe` — choose More info → Run anyway if you trust the file from your teammate.

## Everyday use (Mac)

```bash
./dedup scan
./dedup review
./dedup apply
```

Or double-click **`Dedup.command`**.

## Excel instead of Google Sheets

In `dedup.config.json`:

```json
{
  "backend": "xlsx",
  "file": "./participants.xlsx",
  "sheet": "Participants"
}
```

Then the same `scan` / `review` / `apply` commands work.
