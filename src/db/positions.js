import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy, slippageAdjustedMcap } from './settings.js';
import { effectivePositionSizeSol } from '../pipeline/llm.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export let pendingPositionCount = 0;

export function incrementPendingPosition() {
  pendingPositionCount++;
}

export function decrementPendingPosition() {
  pendingPositionCount = Math.max(0, pendingPositionCount - 1);
}

// Reserve a position slot synchronously before any async refresh/execution.
// JavaScript runs this check-and-increment without an await boundary, so
// concurrent candidates cannot all claim the same slot.
export function tryReservePositionSlot() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  const openCount = db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
  if (max > 0 && openCount + pendingPositionCount >= max) return false;
  incrementPendingPosition();
  return true;
}

export function openPositionCount() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
  return count + pendingPositionCount;
}

export function hasClosedPosition(mint) {
  const row = db.prepare(`
    SELECT 1 FROM dry_run_positions WHERE mint = ? AND status = 'closed' LIMIT 1
  `).get(mint);
  return !!row;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function liveEntryBlockReason(mint, strat = activeStrategy()) {
  const active = db.prepare(`
    SELECT status FROM dry_run_positions
    WHERE mint = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
    LIMIT 1
  `).get(mint);
  if (active) return `position_${active.status}`;
  const recentClosed = db.prepare(`
    SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
  `).get(mint, now() - 24 * 60 * 60 * 1000);
  if (recentClosed) return 'closed_within_24h';
  const blockDays = Number(strat.win_block_days ?? ({ sniper: 2, dip_buy: 5, smart_money: 3, degen: 1 }[strat.id] ?? 7));
  const pastWin = db.prepare(`
    SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
      AND closed_at_ms > ? LIMIT 1
  `).get(mint, now() - blockDays * 24 * 60 * 60 * 1000);
  return pastWin ? 'recent_winning_trade' : null;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function positionSizeBreakdown(candidate, decision, strat = activeStrategy(), utcHour = new Date().getUTCHours()) {
  const baseAfterConfidence = effectivePositionSizeSol(strat, decision);
  const riskFlags = candidate.riskFlags || [];
  const totalRiskSeverity = riskFlags.reduce((sum, flag) => sum + (flag.severity || 0), 0);
  const riskMultiplier = totalRiskSeverity >= 4 ? 0.25 : totalRiskSeverity >= 2 ? 0.5 : 1;
  const rawSourceWeight = Number(candidate.filters?.sourceWeight ?? 1);
  const minimumOpportunityWeight = Math.max(0, Math.min(1, numSetting('min_opportunity_size_multiplier', 0.35)));
  // A passed candidate must not be reduced repeatedly by correlated soft
  // opportunity scores. Zero remains zero (hard/no-route rejection); positive
  // weights share one conservative floor. Independent safety risk still applies.
  const sourceWeight = Number.isFinite(rawSourceWeight)
    ? rawSourceWeight > 0 ? Math.max(minimumOpportunityWeight, Math.min(1, rawSourceWeight)) : 0
    : 0;
  const sessionMultiplier = utcHour >= 12 && utcHour <= 18 ? 0.5 : 1;
  // Regime learning is advisory only. It must not mutate money sizing outside
  // the reviewed learning/approval pipeline.
  const regimeMultiplier = 1;
  const rawSizeSol = Math.max(0, baseAfterConfidence * riskMultiplier * sourceWeight * sessionMultiplier);
  const minimumEconomicSol = Math.max(0, numSetting('min_executable_position_sol', 0.001));
  const executable = rawSizeSol >= minimumEconomicSol;
  return {
    baseAfterConfidence, totalRiskSeverity, riskMultiplier, rawSourceWeight,
    minimumOpportunityWeight, sourceWeight,
    sessionMultiplier, regimeMultiplier, rawSizeSol,
    finalSizeSol: executable ? rawSizeSol : 0,
    minimumEconomicSol, executable,
  };
}

export function calculatePositionSizeSol(candidate, decision, strat = activeStrategy()) {
  return positionSizeBreakdown(candidate, decision, strat).finalSizeSol;
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizing = positionSizeBreakdown(candidate, decision, strat);
  if (!sizing.executable) {
    console.log(`[position] skipped dust size ${sizing.rawSizeSol.toFixed(6)} SOL < ${sizing.minimumEconomicSol} SOL`);
    return { id: null, isNew: false, blockedBy: 'below_minimum_economic_size', sizing };
  }
  const finalSize = sizing.finalSizeSol;
  console.log(`[position] sizing ${JSON.stringify(sizing)}`);

  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  let entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  entryMcap = slippageAdjustedMcap(entryMcap, 'entry');
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    // Dedup: block re-entry if this token has been closed within 24 hours
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — closed <24h ago`);
      return { id: recentClosed.id, isNew: false };
    }

    // Block re-entry if this mint had a winning trade in the last WIN_BLOCK_DAYS days (avoid round-trip losses)
    const WIN_BLOCK_DAYS_BY_STRATEGY = {
      sniper: 2,
      dip_buy: 5,
      smart_money: 3,
      degen: 1
    };
    const stratId = strat.id || 'default';
    const WIN_BLOCK_DAYS = strat.win_block_days ?? WIN_BLOCK_DAYS_BY_STRATEGY[stratId] ?? numSetting('win_block_days', 7);

    const pastWin = db.prepare(`
      SELECT id, pnl_sol, closed_at_ms FROM dry_run_positions
      WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
        AND closed_at_ms > ?
      ORDER BY closed_at_ms DESC LIMIT 1
    `).get(candidate.token.mint, now() - WIN_BLOCK_DAYS * 86400000);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past WIN exists`);
      return { id: pastWin.id, isNew: false, blockedBy: 'past_win', pastWinPnlSol: pastWin.pnl_sol, pastWinClosedAtMs: pastWin.closed_at_ms };
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      finalSize,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id, sizing, llmConfidence: decision.confidence ?? null, signalRoute: candidate.signals?.route ?? null }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, finalSize, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy', sizeSolOverride = null) {
  const strat = activeStrategy();
  const sizeSol = Number.isFinite(Number(sizeSolOverride))
    ? Number(sizeSolOverride)
    : calculatePositionSizeSol(candidate, decision, strat);

  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    // Dedup: block re-entry if this token has been closed within 24 hours
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — closed <24h ago (live)`);
      return { id: recentClosed.id, isNew: false };
    }

    // Block re-entry if this mint ever had a winning trade (avoid round-trip losses)
    const WIN_BLOCK_DAYS_BY_STRATEGY = {
      sniper: 2,
      dip_buy: 5,
      smart_money: 3,
      degen: 1
    };
    const stratId = strat.id || 'default';
    const WIN_BLOCK_DAYS = strat.win_block_days ?? WIN_BLOCK_DAYS_BY_STRATEGY[stratId] ?? numSetting('win_block_days', 7);

    const pastWin = db.prepare(`
      SELECT id FROM dry_run_positions
      WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
        AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - WIN_BLOCK_DAYS * 86400000);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past WIN exists (live)`);
      return { id: pastWin.id, isNew: false };
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}
