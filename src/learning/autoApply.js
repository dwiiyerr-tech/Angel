import { db } from '../db/connection.js';
import { setting } from '../db/settings.js';

const LEARNING_PARAMETER_POLICY = {
  default_sl_percent: { min: -50, max: -5 },
  default_tp_percent: { min: 10, max: 500 },
  llm_min_confidence: { min: 20, max: 95 },
  max_mcap_usd: { min: 0, max: 5_000_000 },
  min_liquidity_usd: { min: 1_000, max: 500_000 },
  min_mcap_usd: { min: 0, max: 1_000_000 },
  position_size_sol: { min: 0.005, max: 0.5 },
  max_open_positions: { min: 1, max: 5 },
  trailing_percent: { min: 2, max: 50 },
  partial_tp_at_percent: { min: 5, max: 500 },
  partial_tp_sell_percent: { min: 5, max: 90 },
};

const LOCKED_SAFETY_PARAMETERS = new Set([
  'filter_max_bot_holders_pct',
  'min_liquidity_usd',
  'max_top20_holder_percent',
  'live_circuit_breaker_open',
  'trading_mode',
]);

export function validateTuningProposal({ param, currentValue, proposedValue, evidence = {} }) {
  if (LOCKED_SAFETY_PARAMETERS.has(param)) return { ok: false, reason: 'safety_parameter_locked' };
  const base = validateLearningSuggestion(param, proposedValue);
  if (!base.ok) return base;
  if (Number(evidence.candidates || 0) < 200 && Number(evidence.trades || 0) < 30) {
    return { ok: false, reason: 'insufficient_sample' };
  }
  if (evidence.splitHalfPositive !== true || evidence.runnerRecallPreserved !== true) {
    return { ok: false, reason: 'validation_requirements_not_met' };
  }
  const current = Number(currentValue);
  if (Number.isFinite(current) && current !== 0) {
    const relativeChange = Math.abs((base.value - current) / current);
    if (relativeChange > 0.1) return { ok: false, reason: 'change_exceeds_10_percent' };
  }
  return { ok: true, value: base.value, requiresShadow: true, requiresManualLiveApproval: true };
}

export function validateLearningSuggestion(param, value) {
  const policy = LEARNING_PARAMETER_POLICY[param];
  if (!policy) return { ok: false, reason: 'parameter_not_allowlisted' };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { ok: false, reason: 'not_numeric' };
  if (numeric < policy.min || numeric > policy.max) {
    return { ok: false, reason: `outside_safe_range_${policy.min}_${policy.max}` };
  }
  return { ok: true, value: numeric };
}

export function autoApplyLessons() {
  // Autonomous mutation is intentionally retired. Learning is advisory-only:
  // lessons may inform LLM context, but never write settings or strategies.
  return { applied: 0, actions: [], disabledReason: 'llm_advisory_only' };
}

export function rollbackMutation(mutationId, reason) {
  if (setting('trading_mode', 'dry_run') !== 'dry_run') return false;
  const mutation = db.prepare('SELECT * FROM parameter_mutation_history WHERE id = ?').get(mutationId);
  if (!mutation || mutation.rolled_back) return false;

  if (mutation.strategy === 'global') {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(mutation.param_key, String(mutation.old_value));
  } else {
    const strategy = db.prepare('SELECT config_json FROM strategies WHERE id = ?').get(mutation.strategy);
    if (strategy) {
      const cfg = JSON.parse(strategy.config_json);
      let oldVal = mutation.old_value;
      if (oldVal === 'true') oldVal = true;
      else if (oldVal === 'false') oldVal = false;
      else if (!isNaN(Number(oldVal))) oldVal = Number(oldVal);

      cfg[mutation.param_key] = oldVal;
      db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), mutation.strategy);
    }
  }

  db.prepare('UPDATE parameter_mutation_history SET rolled_back = 1, rollback_reason = ? WHERE id = ?').run(reason || 'Manual rollback', mutationId);
  return true;
}
