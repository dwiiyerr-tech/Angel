#!/bin/bash
# Angel Health Monitor Script
# Checks: process, signals, trades, config

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DB="$PROJECT_ROOT/angel.sqlite"
LOG="/tmp/angel.log"

echo "=== ANGEL HEALTH CHECK $(date) ==="

# 1. Process check
echo -e "\n[PROCESS]"
PIDS=$(pgrep -f "node index" | head -1)
if [ -z "$PIDS" ]; then
    echo "❌ CRITICAL: Angel NOT running!"
    cd "$PROJECT_ROOT" && node index.js &
    echo "🔄 Auto-restarted Angel"
else
    echo "✅ Angel running (PID: $PIDS)"
fi

# 2. Config check
echo -e "\n[CONFIG]"
MIN_MCAP=$(sqlite3 "$DB" "SELECT json_extract(config_json, '$.min_mcap_usd') FROM strategies WHERE id='pump_scalp';")
MAX_MCAP=$(sqlite3 "$DB" "SELECT json_extract(config_json, '$.max_mcap_usd') FROM strategies WHERE id='pump_scalp';")
SL=$(sqlite3 "$DB" "SELECT json_extract(config_json, '$.sl_percent') FROM strategies WHERE id='pump_scalp';")
echo "Mcap range: $MIN_MCAP - $MAX_MCAP"
echo "SL: $SL%"

# 3. Recent signals (use Unix epoch for correct timezone)
echo -e "\n[SIGNALS - Last 2 hours]"
NOW_EPOCH=$(date +%s)
TWO_HOURS_AGO=$((NOW_EPOCH - 7200))
sqlite3 "$DB" "
SELECT 
  COUNT(*) as candidates,
  SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) as approved,
  SUM(CASE WHEN status='wait' THEN 1 ELSE 0 END) as waiting
FROM candidates 
WHERE updated_at_ms > ${TWO_HOURS_AGO}000;
"

# 4. Recent trades (use Unix epoch)
echo -e "\n[TRADES - Last 24 hours]"
TWENTY_FOUR_HOURS_AGO=$((NOW_EPOCH - 86400))
sqlite3 "$DB" "
SELECT 
  COUNT(*) as trades,
  ROUND(AVG(pnl_percent), 2) as avg_pnl,
  ROUND(SUM(pnl_percent), 2) as total_pnl
FROM dry_run_positions 
WHERE status='closed' AND closed_at_ms > ${TWENTY_FOUR_HOURS_AGO}000;
"

# 5. Performance (50K-100K range)
echo -e "\n[PERFORMANCE - 50K-100K mcap]"
sqlite3 "$DB" "
SELECT 
  COUNT(*) as trades,
  ROUND(SUM(CASE WHEN pnl_percent > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate,
  ROUND(AVG(pnl_percent), 2) as avg_pnl
FROM dry_run_positions 
WHERE status='closed' AND entry_mcap BETWEEN 50000 AND 100000;
"

# 6. Last trade time (convert to local time)
echo -e "\n[LAST ACTIVITY]"
LAST_TRADE_EPOCH=$(sqlite3 "$DB" "SELECT MAX(closed_at_ms) / 1000 FROM dry_run_positions;")
if [ -n "$LAST_TRADE_EPOCH" ]; then
    LAST_TRADE_LOCAL=$(date -d "@$LAST_TRADE_EPOCH" "+%Y-%m-%d %H:%M:%S %Z")
    MINUTES_AGO=$(( (NOW_EPOCH - LAST_TRADE_EPOCH) / 60 ))
    echo "Last trade: $LAST_TRADE_LOCAL ($MINUTES_AGO minutes ago)"
    
    if [ $MINUTES_AGO -gt 360 ]; then
        echo "⚠️  WARNING: No trades in last 6 hours!"
    fi
else
    echo "No trades found"
fi

# 7. Open positions
echo -e "\n[POSITIONS]"
OPEN_POSITIONS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM dry_run_positions WHERE status='open';")
echo "Open positions: $OPEN_POSITIONS"

# 8. Check for issues
echo -e "\n[ISSUES]"
ONE_HOUR_AGO=$((NOW_EPOCH - 3600))
RECENT_SIGNALS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM candidates WHERE updated_at_ms > ${ONE_HOUR_AGO}000;")
if [ "$RECENT_SIGNALS" -lt 5 ]; then
    echo "⚠️  WARNING: Low signal count ($RECENT_SIGNALS in 1h)"
fi

echo -e "\n=== END HEALTH CHECK ==="
