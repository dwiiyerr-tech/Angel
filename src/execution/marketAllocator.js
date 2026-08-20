import { db } from '../db/connection.js';
import { setting, setSetting } from '../db/settings.js';

const EDGE1_FAMILY = 'edge1';
const ROLLING_TRADES = 20;
const SWITCH_CONFIRMATIONS = 3;
const MIN_MODE_HOLD_MS = 30 * 60 * 1000;
const RED_RECOVERY_SIZE_MULTIPLIER = 0.25;

function recentEdgeTrades() {
  return db.prepare(`
    SELECT pnl_percent, pnl_sol, closed_at_ms, snapshot_json
    FROM dry_run_positions
    WHERE status = 'closed'
      AND COALESCE(execution_mode, 'dry_run') = 'dry_run'
      AND COALESCE(json_extract(snapshot_json, '$.strategyFamily'), 'edge1') = 'edge1'
    ORDER BY closed_at_ms DESC, id DESC
    LIMIT ?
  `).all(ROLLING_TRADES);
}

function lossStreak(rows) {
  let streak = 0;
  for (const row of rows) {
    if (Number(row.pnl_percent) > 0 || Number(row.pnl_sol) > 0) break;
    streak += 1;
  }
  return streak;
}

function modeFromSetting() {
  const value = setting('market_allocator_mode', 'green');
  return ['green', 'yellow', 'red'].includes(value) ? value : 'green';
}

export function evaluateMarketAllocator({ force = false } = {}) {
  const rows = recentEdgeTrades();
  const pnl = rows.reduce((sum, row) => sum + Number(row.pnl_sol || 0), 0);
  const avgPnl = rows.length ? rows.reduce((sum, row) => sum + Number(row.pnl_percent || 0), 0) / rows.length : null;
  const wins = rows.filter(row => Number(row.pnl_percent) > 0).length;
  const losses = rows.length - wins;
  const streak = lossStreak(rows);
  const expectancy = rows.length
    ? rows.reduce((sum, row) => sum + Number(row.pnl_percent || 0), 0) / rows.length
    : null;
  const desired = streak >= 3 || (rows.length >= 10 && avgPnl != null && avgPnl <= -5)
    ? 'red'
    : streak >= 2 || (rows.length >= 10 && expectancy != null && expectancy < 0)
      ? 'yellow'
      : 'green';
  const current = modeFromSetting();
  const changedAt = Number(setting('market_allocator_changed_at_ms', 0));
  const pending = setting('market_allocator_pending_mode', '');
  const pendingCount = Number(setting('market_allocator_pending_count', 0));
  let next = current;
  let nextPending = pending === desired ? pendingCount + 1 : 1;
  if (force || (desired !== current && nextPending >= SWITCH_CONFIRMATIONS && Date.now() - changedAt >= MIN_MODE_HOLD_MS)) {
    next = desired;
    nextPending = 0;
    setSetting('market_allocator_mode', next);
    setSetting('market_allocator_changed_at_ms', Date.now());
  }
  setSetting('market_allocator_size_multiplier', next === 'yellow' ? 0.5 : next === 'red' ? RED_RECOVERY_SIZE_MULTIPLIER : 1);
  setSetting('market_allocator_pending_mode', next === current ? desired : '');
  setSetting('market_allocator_pending_count', nextPending);
  return {
    mode: next,
    desired,
    // Edge-1 is the only active family. In red, pause-sized entries would
    // deadlock recovery because no new closed trades could improve the metric.
    // Keep screening alive with a quarter-size recovery mode instead.
    edgeFamily: EDGE1_FAMILY,
    edge1SizeMultiplier: next === 'yellow' ? 0.5 : next === 'red' ? RED_RECOVERY_SIZE_MULTIPLIER : 1,
    observations: { trades: rows.length, wins, losses, pnlSol: pnl, avgPnlPercent: avgPnl, expectancyPercent: expectancy, lossStreak: streak },
    transition: { pending, pendingCount: nextPending, confirmationsRequired: SWITCH_CONFIRMATIONS, minModeHoldMs: MIN_MODE_HOLD_MS },
  };
}

export function candidateFamily(candidate) {
  return candidate?.signals?.strategyFamily || candidate?.strategyFamily || EDGE1_FAMILY;
}

export function allocationAllowsCandidate(candidate, allocation = evaluateMarketAllocator()) {
  const family = candidateFamily(candidate);
  return family === EDGE1_FAMILY && allocation.edgeFamily === EDGE1_FAMILY;
}
