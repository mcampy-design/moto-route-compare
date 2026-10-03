#!/bin/sh
# Upload built tiles to the R2 bucket with parallel `wrangler r2 object put` (no API token needed).
# Usage: tools/upload_tiles.sh [bucket] [parallelism]   (run from anywhere; needs `wrangler login`)
# Set WRANGLER to a faster launcher than `npx wrangler` if you have one.
# Failed uploads are listed in tools/out/upload_failed.txt; rerun the script to retry only those.
BUCKET="${1:-moto-hpms-tiles}"
JOBS="${2:-12}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER="${WRANGLER:-npx wrangler}"
LIST="$ROOT/tools/out/upload_todo.txt"
if [ -s "$ROOT/tools/out/upload_failed.txt" ]; then cp "$ROOT/tools/out/upload_failed.txt" "$LIST"
else (cd "$ROOT/tools/out/tiles" && find hpms-* -type f -name '*.bin.gz' | sort > "$LIST"); fi
: > "$ROOT/tools/out/upload_failed.txt"
export BUCKET ROOT WRANGLER
echo "uploading $(wc -l < "$LIST") tiles to $BUCKET with $JOBS parallel jobs"
xargs -n 1 -P "$JOBS" "$ROOT/tools/upload_one.sh" < "$LIST"
echo "finished; failed: $(wc -l < "$ROOT/tools/out/upload_failed.txt")"
