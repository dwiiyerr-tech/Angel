#!/bin/bash
# Angel Silent Monitor - Only outputs when problems detected
# Designed for cron: silent = OK, output = alert

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DB="$PROJECT_ROOT/angel.sqlite"
NOW=$(date +%s)

# Quick checks - exit silently if all OK
ISSUES=""

# 1. Process alive?
if ! pgrep -f "node index" > /dev/null; then
    ISSUES="${ISSUES}❌ CRITICAL: Angel NOT running!\n"
fi

# 2. Last trade within 6h?
LAST_TRADE=$(sqlite3 "$DB" "SELECT MAX(closed_at_ms) / 1000 FROM dry_run_positions;")
if [ -n "$LAST_TRADE" ]; then
    MINUTES_AGO=$(( (NOW - LAST_TRADE) / 60 ))
    if [ $MINUTES_AGO -gt 360 ]; then
        ISSUES="${ISSUES}⚠️ No trades in ${MINUTES_AGO}m ($(($MINUTES_AGO / 60))h)\n"
    fi
fi

# 3. Signals flowing? (last 2h)
TWO_HOURS_AGO=$((NOW - 7200))
SIGNAL_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM candidates WHERE updated_at_ms > ${TWO_HOURS_AGO}000;")
if [ "$SIGNAL_COUNT" -lt 10 ]; then
    ISSUES="${ISSUES}⚠️ Low signals: ${SIGNAL_COUNT} in 2h\n"
fi

# 4. Win rate check (all closed trades)
WIN_RATE=$(sqlite3 "$DB" "SELECT ROUND(SUM(CASE WHEN pnl_percent > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) FROM dry_run_positions WHERE status='closed';")
if [ -n "$WIN_RATE" ]; then
    WIN_RATE_INT=${WIN_RATE%.*}
    if [ "$WIN_RATE_INT" -lt 40 ]; then
        ISSUES="${ISSUES}⚠️ Win rate dropped: ${WIN_RATE}%\n"
    fi
fi

# Output only if issues found
if [ -n "$ISSUES" ]; then
    echo "🚨 Angel Alert"
    echo -e "$ISSUES"
    echo "Time: $(date '+%H:%M %Z')"
    exit 1
else
    # Silent exit = no notification
    exit 0
fi
