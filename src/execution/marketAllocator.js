import { db } from '../db/connection.js';
import { numSetting, setting, setSetting } from '../db/settings.js';

const EDGE1_FAMILY = 'edge1';
const SECOND_WAVE_FAMILY = 'second_wave_v2';
const ROLLING_TRADES = 20;
const SWITCH_CONFIRMATIONS = 3;
const MIN_MODE_HOLD_MS = 30 * 60 * 1000;

function recentFamilyTrades(family) {
  return db.prepare(`
    SELECT pnl_percent, pnl_sol, closed_at_ms, snapshot_json
    FROM dry_run_positions
    WHERE status = 'closed'
      AND COALESCE(execution_mode, 'dry_run') = 'dry_run'
      AND COALESCE(json_extract(snapshot_json, '$.strategyFamily'), 'edge1') = ?
    ORDER BY closed_at_ms DESC, id DESC
    LIMIT ?
  `).all(family, ROLLING_TRADES);
}

function lossStreak(rows) {
  let streak = 0;
  for (const row of rows) {
    if (Number(row.pnl_percent) > 0 || Number(row.pnl_sol) > 0) break;
    streak += 1;
  }
  return streak;
}

function familyHealth(rows) {
  if (!rows.length) return { healthy: true, trades: 0, avgPnlPercent: null, lossStreak: 0 };
  const avgPnlPercent = rows.reduce((sum, row) => sum + Number(row.pnl_percent || 0), 0) / rows.length;
  const streak = lossStreak(rows);
  return {
    healthy: !(streak >= 3 || (rows.length >= 10 && avgPnlPercent <= -5)),
    trades: rows.length,
    avgPnlPercent,
    lossStreak: streak,
  };
}

function modeFromSetting() {
  const value = setting('market_allocator_mode', 'green');
  return ['green', 'yellow', 'red'].includes(value) ? value : 'green';
}

export function evaluateMarketAllocator({ force = false } = {}) {
  const rows = recentFamilyTrades(EDGE1_FAMILY);
  const secondWaveHealth = familyHealth(recentFamilyTrades(SECOND_WAVE_FAMILY));
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
  setSetting('market_allocator_size_multiplier', next === 'yellow' ? 0.5 : next === 'red' ? 0 : 1);
  setSetting('market_allocator_pending_mode', next === current ? desired : '');
  setSetting('market_allocator_pending_count', nextPending);
  return {
    mode: next,
    desired,
    edgeFamily: next === 'red' ? null : EDGE1_FAMILY,
    secondWaveEnabled: next !== 'green' && secondWaveHealth.healthy,
    edge1SizeMultiplier: next === 'yellow' ? 0.5 : next === 'red' ? 0 : 1,
    observations: { trades: rows.length, wins, losses, pnlSol: pnl, avgPnlPercent: avgPnl, expectancyPercent: expectancy, lossStreak: streak, secondWaveHealth },
    transition: { pending, pendingCount: nextPending, confirmationsRequired: SWITCH_CONFIRMATIONS, minModeHoldMs: MIN_MODE_HOLD_MS },
  };
}

export function candidateFamily(candidate) {
  return candidate?.signals?.strategyFamily || candidate?.strategyFamily || EDGE1_FAMILY;
}

export function secondWaveCandidateAllowed(candidate) {
  const data = candidate?.secondWave || candidate?.signals?.secondWave;
  if (!data || data.score < 8 || data.safetyVerified !== true || data.dataQuality !== 'verified') return false;
  return candidateFamily(candidate) === SECOND_WAVE_FAMILY;
}

export function allocationAllowsCandidate(candidate, allocation = evaluateMarketAllocator()) {
  const family = candidateFamily(candidate);
  if (family === SECOND_WAVE_FAMILY) return allocation.secondWaveEnabled && secondWaveCandidateAllowed(candidate);
  return allocation.edgeFamily === EDGE1_FAMILY;
}
