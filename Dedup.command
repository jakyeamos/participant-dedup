#!/bin/bash
# Double-click this on a Mac (or run: ./Dedup.command)
cd "$(dirname "$0")"

DEDUP_BIN="./dist-bin/dedup"
if [[ ! -x "$DEDUP_BIN" ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    DEDUP_BIN="pnpm exec tsx tools/dedupCli.ts"
  elif [[ -x "./dedup" ]]; then
    DEDUP_BIN="./dedup"
  else
    echo "Cannot find dist-bin/dedup or ./dedup"
    echo "Ask your teammate to run: pnpm dedup:compile"
    read -r -p "Press Enter to close…"
    exit 1
  fi
fi

echo ""
echo "  Participant Dedup"
echo "  -----------------"
echo "  1) Scan   — find duplicates"
echo "  2) Review — choose what to keep"
echo "  3) Apply  — delete marked rows (asks to confirm)"
echo "  4) Quit"
echo ""
read -r -p "Pick 1-4: " choice

case "$choice" in
  1) $DEDUP_BIN scan ;;
  2) $DEDUP_BIN review ;;
  3) $DEDUP_BIN apply ;;
  *) echo "Bye."; exit 0 ;;
esac

echo ""
read -r -p "Press Enter to close…"
