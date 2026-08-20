#!/bin/bash
# Auto-retrain ML momentum model from latest trade data
# Runs retrain script, then hot-reloads ml-service
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$PROJECT_DIR/logs/retrain.log"
DB_PATH="${ANGEL_DB_PATH:-$PROJECT_DIR/angel.sqlite}"

mkdir -p "$PROJECT_DIR/logs"

echo "========================================" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting ML retrain..." >> "$LOG_FILE"

# Check minimum trade count before wasting compute
TRADE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM dry_run_positions WHERE status = 'closed' AND COALESCE(execution_mode,'dry_run')='dry_run' AND json_extract(snapshot_json,'$.simulatorVersion')='quote_sized_v3';")
echo "[retrain] Compatible closed trades: $TRADE_COUNT" >> "$LOG_FILE"

if [ "$TRADE_COUNT" -lt 50 ]; then
  echo "[retrain] SKIP: Only $TRADE_COUNT trades. Need at least 50." >> "$LOG_FILE"
  exit 0
fi

# Run retrain
cd "$PROJECT_DIR"
python3 "$PROJECT_DIR/scripts/retrain_momentum.py" >> "$LOG_FILE" 2>&1
RETRAIN_EXIT=$?

if [ $RETRAIN_EXIT -eq 3 ]; then
  echo "[retrain] Challenger not deployed; keeping current service/model." >> "$LOG_FILE"
  exit 0
fi

if [ $RETRAIN_EXIT -ne 0 ]; then
  echo "[retrain] FAILED with exit code $RETRAIN_EXIT" >> "$LOG_FILE"
  exit 1
fi

echo "[retrain] Model retrained successfully. Reloading angel-ml..." >> "$LOG_FILE"

# Hot-reload ml-service so it picks up new model
if ! pm2 restart angel-ml >> "$LOG_FILE" 2>&1; then
  echo "[retrain] FAILED: model deployed but angel-ml restart failed; operator action required" >> "$LOG_FILE"
  exit 1
fi

echo "[retrain] Done. angel-ml restarted." >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
