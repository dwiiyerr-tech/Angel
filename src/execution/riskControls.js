import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';

function modeClause(executionMode) {
  if (!executionMode) return '';
  // `confirm` still executes real-money swaps after human approval, so all
  // money modes must share the live loss history instead of paper-trade PnL.
  const normalizedMode = executionMode === 'confirm' ? 'live' : executionMode;
  return `AND COALESCE(execution_mode, 'dry_run') = '${normalizedMode === 'live' ? 'live' : 'dry_run'}'`;
}

export function recentLossStreak(executionMode = null) {
  const rows = db.prepare(`
    SELECT pnl_percent, pnl_sol, closed_at_ms
    FROM dry_run_positions
    WHERE status = 'closed' ${modeClause(executionMode)}
    ORDER BY closed_at_ms DESC, id DESC
    LIMIT 100
  `).all();
  let streak = 0;
  for (const row of rows) {
    if (Number(row.pnl_percent) > 0 || Number(row.pnl_sol) > 0) break;
    streak += 1;
  }
  return { streak, latestClosedAtMs: rows[0]?.closed_at_ms || null };
}

export function riskControlState(executionMode = null, atMs = Date.now()) {
  const { streak, latestClosedAtMs } = recentLossStreak(executionMode);
  const cutAfter = Math.max(1, numSetting('loss_streak_size_cut_after', 2));
  const pauseAfter = Math.max(cutAfter, numSetting('loss_streak_pause_after', 3));
  const pauseMs = Math.max(0, numSetting('loss_streak_pause_ms', 30 * 60 * 1000));
  const pausedUntilMs = streak >= pauseAfter && latestClosedAtMs
    ? Number(latestClosedAtMs) + pauseMs
    : null;
  const paused = Boolean(pausedUntilMs && atMs < pausedUntilMs);
  return {
    streak,
    // A paused money mode must calculate to a zero-sized entry. This keeps
    // confirmation intents fail-closed even if the loss streak changes after
    // the intent was created but before the user confirms it.
    sizeMultiplier: paused
      ? 0
      : streak >= cutAfter
        ? Math.max(0.1, Math.min(1, numSetting('loss_streak_size_multiplier', 0.5)))
        : 1,
    paused,
    pausedUntilMs,
    cutAfter,
    pauseAfter,
  };
}

export function assertLossStreakAllowed(executionMode = 'live') {
  const state = riskControlState(executionMode);
  if (state.paused) {
    const minutes = Math.ceil((state.pausedUntilMs - Date.now()) / 60000);
    throw new Error(`Entry paused after ${state.streak} consecutive losses; retry in ${minutes}m.`);
  }
  return state;
}
