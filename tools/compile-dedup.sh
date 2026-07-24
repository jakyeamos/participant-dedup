#!/usr/bin/env bash
# Build standalone dedup binaries with Bun (no Node required on target).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist-bin

echo "Compiling macOS (host) → dist-bin/dedup ..."
bun build ./tools/dedupCli.ts --compile --minify --outfile dist-bin/dedup

echo "Compiling Windows x64 → dist-bin/dedup.exe ..."
bun build ./tools/dedupCli.ts --compile --minify \
  --target=bun-windows-x64 \
  --outfile dist-bin/dedup.exe

ls -lh dist-bin/dedup dist-bin/dedup.exe
echo ""
echo "Mac:     ./dist-bin/dedup scan"
echo "Windows: dist-bin\\dedup.exe scan"
echo "Put dedup.config.json + sa.json next to the binary."
