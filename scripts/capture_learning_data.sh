#!/bin/bash
# Angel learning data capture — keeps last 14 snapshots, removes older
set -euo pipefail

DB=/root/Angel/angel.sqlite
EXPORTS=/root/Angel/exports
KEEP=14
TS=$(date +%Y%m%d_%H%M%S)
DIR=$EXPORTS/learning_capture_$TS

if [ ! -f "$DB" ]; then
  echo "SKIP: $DB not found"
  exit 0
fi

mkdir -p "$DIR"
cp "$DB" "$DIR/angel.sqlite"
sqlite3 "$DB" ".dump learning_lessons" > "$DIR/learning_lessons.sql"
sqlite3 "$DB" ".dump settings" > "$DIR/settings.sql"
sqlite3 "$DB" ".dump strategies" > "$DIR/strategies.sql"
sqlite3 "$DB" "SELECT * FROM llm_decisions ORDER BY id DESC LIMIT 100;" > "$DIR/recent_decisions.txt"
sqlite3 "$DB" "SELECT * FROM dry_run_positions WHERE status='closed' ORDER BY id DESC LIMIT 100;" > "$DIR/recent_closed_positions.txt"

python3 /root/Angel/scripts/capture_learning_data.py >/dev/null 2>&1

# Prune old snapshots — keep newest $KEEP
ls -1dt "$EXPORTS"/learning_capture_* 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -rf

LATEST=$(ls -1dt "$EXPORTS"/learning_capture_* 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  echo "captured: $LATEST ($(du -sh "$LATEST" | cut -f1))"
fi
