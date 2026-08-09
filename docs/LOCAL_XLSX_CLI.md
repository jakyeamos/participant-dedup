# Local dedup CLI (xlsx + Google Sheets + TUI)

Run matching on your machine with **no Railway/Coolify host**. Same commands for
Excel files and Google Sheets. Optional interactive review TUI. Optional
single-file binary via Bun.

## Prerequisites

- Node 20+ (for `pnpm dedup …` during development)
- `pnpm install` in this repo
- **Sheets only:** a Google service account JSON, workbook shared as **Editor**
- **Binary only:** [Bun](https://bun.sh) on the build machine (`pnpm dedup:compile`)

## Excel workflow

```bash
pnpm dedup scan --file ./participants.xlsx --sheet Participants
pnpm dedup queue --file ./participants.dedup.xlsx
pnpm dedup review --file ./participants.dedup.xlsx    # interactive TUI
pnpm dedup apply --file ./participants.dedup.xlsx --confirm
```

Or non-interactive (keep richest row + merge blanks):

```bash
pnpm dedup auto-review --file ./participants.dedup.xlsx --confidence HIGH
pnpm dedup apply --file ./participants.dedup.xlsx --confirm
```

## Google Sheets workflow

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON="$(cat ./sa.json)"

pnpm dedup scan --backend sheets --spreadsheet SPREADSHEET_ID --sheet Participants
pnpm dedup review --backend sheets --spreadsheet SPREADSHEET_ID
pnpm dedup apply --backend sheets --spreadsheet SPREADSHEET_ID --confirm
```

## Review TUI

`dedup review` walks HIGH/MEDIUM unreviewed clusters:

1. Pick a cluster from the list
2. Inspect member rows
3. Accept the suggested richest-row merge, pick a core row, keep all, skip, or quit
4. Use **Auto-resolve all waiting clusters** to apply the same information-preserving plan to the current queue
5. Optionally apply deletions when finished

## Single binary

```bash
pnpm dedup:compile
./dist-bin/dedup scan --file ./participants.xlsx --sheet Participants
./dist-bin/dedup review --file ./participants.dedup.xlsx
```

The binary embeds the Bun runtime (~tens of MB). Cross-compile examples:

```bash
bun build ./tools/dedupCli.ts --compile --minify --target=bun-linux-x64 --outfile dist-bin/dedup-linux
bun build ./tools/dedupCli.ts --compile --minify --target=bun-windows-x64 --outfile dist-bin/dedup.exe
```

## Notes

- Headers use the same aliases as the Sheets add-on.
- Hosted API (`docs/BACKEND.md`) remains optional for the in-spreadsheet sidebar.
- CLI integration tests exercise `tools/dedupCli.ts` across a process boundary. Vitest's in-process V8 report cannot attribute that child-process execution, so the entrypoint is explicitly excluded from changed-line coverage; the review planner and decision logic remain covered by unit tests.
