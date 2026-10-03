#!/bin/sh
# Upload one tile (path like hpms-2024/382_-858.bin.gz, relative to tools/out/tiles). Used by upload_tiles.sh.
# Retries three times; on final failure appends the path to tools/out/upload_failed.txt.
for try in 1 2 3; do
  (cd "$ROOT/proxy" && $WRANGLER r2 object put "$BUCKET/$1" --file "$ROOT/tools/out/tiles/$1" \
    --content-type application/octet-stream --content-encoding gzip \
    --cache-control "public, max-age=2592000" --remote >/dev/null 2>&1) && exit 0
  sleep 2
done
echo "$1" >> "$ROOT/tools/out/upload_failed.txt"
