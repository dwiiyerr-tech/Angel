import { db } from '../db/connection.js';
import { sendTelegram } from '../telegram/send.js';
import { rollbackMutation } from './autoApply.js';
import { setting } from '../db/settings.js';

export const LEARNING_OBSERVATION_POLICY = Object.freeze({
  emergencyAfterMs: 12 * 60 * 60 * 1000,
  decisionAfterMs: 7 * 24 * 60 * 60 * 1000,
  emergencyMinTrades: 10,
  decisionMinTrades: 50,
});

function rates(stats) {
  const total = Number(stats?.total || 0);
  return {
    total,
    winRate: total ? (Number(stats?.wins || 0) / total) * 100 : 0,
    avgPnl: total ? Number(stats?.pnl_sum || 0) / total : 0,
    pnlSum: Number(stats?.pnl_sum || 0),
  };
}

// Pure decision function, exported so the safety thresholds remain testable.
export function assessMutationObservation({ ageMs, beforeStats, afterStats }) {
  const before = rates(beforeStats);
  const after = rates(afterStats);
  const policy = LEARNING_OBSERVATION_POLICY;

  if (ageMs < policy.emergencyAfterMs) return { action: 'observe', reason: 'emergency_window_not_reached' };

  if (ageMs < policy.decisionAfterMs) {
    if (before.total < policy.emergencyMinTrades || after.total < policy.emergencyMinTrades) {
      return { action: 'observe', reason: 'insufficient_emergency_samples' };
    }
    const severeRelativeDamage = before.winRate - after.winRate >= 25
      && before.avgPnl - after.avgPnl >= 15;
    const severeAbsoluteLoss = after.pnlSum <= -100 && after.avgPnl <= -10;
    return severeRelativeDamage || severeAbsoluteLoss
      ? { action: 'rollback', reason: `Emergency degradation: WR ${before.winRate.toFixed(1)}% -> ${after.winRate.toFixed(1)}%, avg PnL ${before.avgPnl.toFixed(1)}% -> ${after.avgPnl.toFixed(1)}%` }
      : { action: 'observe', reason: 'minimum_observation_period_not_reached' };
  }

  if (before.total < policy.decisionMinTrades || after.total < policy.decisionMinTrades) {
    return { action: 'observe', reason: 'insufficient_decision_samples' };
  }

  const degraded = before.winRate - after.winRate > 15 || before.avgPnl - after.avgPnl > 10;
  return degraded
    ? { action: 'rollback', reason: `7-day evaluation degraded: WR ${before.winRate.toFixed(1)}% -> ${after.winRate.toFixed(1)}%, avg PnL ${before.avgPnl.toFixed(1)}% -> ${after.avgPnl.toFixed(1)}%` }
    : { action: 'keep', reason: `7-day evaluation passed with ${after.total} post-change trades` };
}

function statsForWindow(startMs, endMs, strategy) {
  const scoped = strategy && strategy !== 'global';
  return db.prepare(`
    SELECT count(*) AS total,
           sum(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
           coalesce(sum(pnl_percent), 0) AS pnl_sum
    FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms > ? AND closed_at_ms <= ?
      ${scoped ? 'AND strategy_id = ?' : ''}
  `).get(...(scoped ? [startMs, endMs, strategy] : [startMs, endMs]));
}

export async function runRollbackMonitor() {
  try {
    if (setting('trading_mode', 'dry_run') !== 'dry_run') {
      console.log('[rollback] skipped outside dry_run mode');
      return;
    }
    const nowMs = Date.now();
    const ready = db.prepare(`
      SELECT * FROM parameter_mutation_history
      WHERE rolled_back = 0 AND rollback_checked_at_ms IS NULL AND applied_at_ms <= ?
    `).all(nowMs - LEARNING_OBSERVATION_POLICY.emergencyAfterMs);

    for (const mutation of ready) {
      const currentValue = mutation.strategy === 'global'
        ? db.prepare('SELECT value FROM settings WHERE key = ?').get(mutation.param_key)?.value
        : (() => {
            const row = db.prepare('SELECT config_json FROM strategies WHERE id = ?').get(mutation.strategy);
            if (!row) return undefined;
            return JSON.parse(row.config_json)[mutation.param_key];
          })();
      if (String(currentValue) !== String(mutation.new_value)) {
        db.prepare('UPDATE parameter_mutation_history SET rollback_checked_at_ms = ? WHERE id = ?').run(nowMs, mutation.id);
        console.log(`[rollback] skipped stale mutation #${mutation.id}; parameter changed since apply`);
        continue;
      }

      const ageMs = nowMs - mutation.applied_at_ms;
      const evaluationWindowMs = ageMs >= LEARNING_OBSERVATION_POLICY.decisionAfterMs
        ? LEARNING_OBSERVATION_POLICY.decisionAfterMs
        : LEARNING_OBSERVATION_POLICY.emergencyAfterMs;
      const beforeStats = statsForWindow(mutation.applied_at_ms - evaluationWindowMs, mutation.applied_at_ms, mutation.strategy);
      const afterStats = statsForWindow(mutation.applied_at_ms, mutation.applied_at_ms + evaluationWindowMs, mutation.strategy);
      const assessment = assessMutationObservation({ ageMs, beforeStats, afterStats });

      if (assessment.action === 'rollback') {
        rollbackMutation(mutation.id, assessment.reason);
        db.prepare('UPDATE parameter_mutation_history SET rollback_checked_at_ms = ? WHERE id = ?').run(nowMs, mutation.id);
        await sendTelegram(`⚠️ AUTO-ROLLBACK: ${mutation.param_key} ${mutation.new_value} → ${mutation.old_value}\nReason: ${assessment.reason}`);
      } else if (assessment.action === 'keep') {
        db.prepare('UPDATE parameter_mutation_history SET rollback_checked_at_ms = ? WHERE id = ?').run(nowMs, mutation.id);
        console.log(`[rollback] mutation #${mutation.id} passed: ${assessment.reason}`);
      } else {
        // Deliberately leave rollback_checked_at_ms NULL: the mutation is still observing.
        console.log(`[rollback] mutation #${mutation.id} observing: ${assessment.reason}`);
      }
    }
  } catch (err) {
    console.error('Rollback monitor error:', err);
  }
}

export function startRollbackMonitor() {
  runRollbackMonitor().catch(err => console.error('Initial rollback monitor error:', err));
  setInterval(runRollbackMonitor, 6 * 60 * 60 * 1000);
}
