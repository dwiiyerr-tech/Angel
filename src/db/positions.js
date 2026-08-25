import { db } from './connection.js';
import { DRY_RUN_SIMULATOR_VERSION } from '../learning/simulatorVersion.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy, slippageAdjustedMcap } from './settings.js';
import { DRY_RUN_NETWORK_FEE_SOL, DRY_RUN_PRIORITY_FEE_SOL, RISK_PER_TRADE_SOL } from '../config.js';
import { effectivePositionSizeSol } from '../pipeline/llm.js';
import { riskControlState } from '../execution/riskControls.js';

export function riskRewardRatio(tpPercent, slPercent) {
  const tp = Number(tpPercent);
  const sl = Math.abs(Number(slPercent));
  return Number.isFinite(tp) && Number.isFinite(sl) && sl > 0 ? tp / sl : 0;
}

export function riskRewardBlockReason(tpPercent, slPercent) {
  const minimum = Math.max(1, numSetting('min_risk_reward_ratio', 1.5));
  const ratio = riskRewardRatio(tpPercent, slPercent);
  return ratio >= minimum ? null : `risk/reward ${ratio.toFixed(2)} < ${minimum.toFixed(2)}`;
}

// Historical/reporting helper: intentionally returns every open position,
// including zero-capital Research. Capital/risk code must use the execution-only
// helpers below so virtual experiments never consume real-money slots.
export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openExecutionPositions() {
  return db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE status = 'open' AND coalesce(execution_mode, 'dry_run') != 'research'
    ORDER BY opened_at_ms DESC
  `).all();
}

export let pendingPositionCount = 0;

export function incrementPendingPosition() {
  pendingPositionCount++;
}

export function decrementPendingPosition() {
  pendingPositionCount = Math.max(0, pendingPositionCount - 1);
}

function executionOpenCount() {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM dry_run_positions
    WHERE status = 'open' AND coalesce(execution_mode, 'dry_run') != 'research'
  `).get()?.count || 0);
}

export function tryReservePositionSlot() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  const openCount = executionOpenCount();
  if (max > 0 && openCount + pendingPositionCount >= max) return false;
  incrementPendingPosition();
  return true;
}

// Public legacy name now means capital-bearing execution capacity only.
// PAPER capacity lives in src/research/engine.js.
export function openPositionCount() {
  return executionOpenCount() + pendingPositionCount;
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
  // Concurrent exposure to the same mint is blocked even if the other position
  // is PAPER; this keeps position identity/reconciliation unambiguous.
  const active = db.prepare(`
    SELECT status FROM dry_run_positions
    WHERE mint = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
    LIMIT 1
  `).get(mint);
  if (active) return `position_${active.status}`;

  // Closed zero-capital experiments must never impose capital cooldowns.
  const recentClosed = db.prepare(`
    SELECT id FROM dry_run_positions
    WHERE mint = ? AND status = 'closed'
      AND coalesce(execution_mode, 'dry_run') != 'research'
      AND closed_at_ms > ?
    LIMIT 1
  `).get(mint, now() - 24 * 60 * 60 * 1000);
  if (recentClosed) return 'closed_within_24h';

  const blockDays = Number(strat.win_block_days ?? ({ sniper: 2, dip_buy: 5, smart_money: 3, degen: 1 }[strat.id] ?? 7));
  const pastWin = db.prepare(`
    SELECT id FROM dry_run_positions
    WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
      AND coalesce(execution_mode, 'dry_run') != 'research'
      AND closed_at_ms > ?
    LIMIT 1
  `).get(mint, now() - blockDays * 24 * 60 * 60 * 1000);
  return pastWin ? 'recent_winning_trade' : null;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  // Two public modes, one compatibility bridge:
  // - PAPER is routed away before this helper and maps to legacy shadow_live if
  //   old execution code asks anyway, which guarantees no broadcast.
  // - LIVE maps internally to legacy confirm semantics so every BUY becomes a
  //   Telegram trade intent. Only the owner-confirmed intent path may broadcast.
  // Protective exits remain automatic on persisted execution_mode='live'.
  if (mode === 'live') return 'confirm';
  if (mode === 'confirm') return 'confirm';
  return 'shadow_live';
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
  const sourceWeight = Number.isFinite(rawSourceWeight)
    ? rawSourceWeight > 0 ? Math.max(minimumOpportunityWeight, Math.min(1, rawSourceWeight)) : 0
    : 0;
  const decisionTier = String(candidate.filters?.decisionTier || decision?.tier || 'A').toUpperCase();
  const bTierMultiplier = decisionTier === 'B'
    ? Math.max(0.1, Math.min(1, numSetting('b_tier_size_multiplier', 0.5)))
    : 1;
  const sessionMultiplier = utcHour >= 12 && utcHour <= 18 ? 0.5 : 1;
  const regimeMultiplier = 1;
  const lossRisk = riskControlState(tradingMode());
  const unconstrainedSizeSol = Math.max(0, baseAfterConfidence * riskMultiplier * sourceWeight * sessionMultiplier * lossRisk.sizeMultiplier * bTierMultiplier);
  const stopDistanceFraction = Math.abs(Number(decision?.suggested_sl_percent ?? strat?.sl_percent ?? numSetting('default_sl_percent', -25))) / 100;
  const riskBudgetSol = Math.max(0, numSetting('risk_per_trade_sol', RISK_PER_TRADE_SOL));
  const riskCappedSizeSol = riskBudgetSol > 0 && stopDistanceFraction > 0
    ? riskBudgetSol / stopDistanceFraction
    : unconstrainedSizeSol;
  const allocatorMultiplier = Math.max(0, Math.min(1, numSetting('market_allocator_size_multiplier', 1)));
  const rawSizeSol = Math.min(unconstrainedSizeSol * allocatorMultiplier, riskCappedSizeSol);
  const minimumEconomicSol = Math.max(0, numSetting('min_executable_position_sol', 0.001));
  const executable = rawSizeSol >= minimumEconomicSol;
  return {
    baseAfterConfidence, totalRiskSeverity, riskMultiplier, rawSourceWeight,
    minimumOpportunityWeight, sourceWeight,
    sessionMultiplier, regimeMultiplier, rawSizeSol,
    finalSizeSol: executable ? rawSizeSol : 0,
    minimumEconomicSol, executable, unconstrainedSizeSol, riskBudgetSol, stopDistanceFraction,
    lossStreak: lossRisk.streak, lossStreakMultiplier: lossRisk.sizeMultiplier, allocatorMultiplier,
    decisionTier, bTierMultiplier,
  };
}

export function calculatePositionSizeSol(candidate, decision, strat = activeStrategy()) {
  return positionSizeBreakdown(candidate, decision, strat).finalSizeSol;
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy', entryQuote = null) {
  const strat = activeStrategy();
  const sizing = positionSizeBreakdown(candidate, decision, strat);
  if (!sizing.executable) {
    console.log(`[position] skipped dust size ${sizing.rawSizeSol.toFixed(6)} SOL < ${sizing.minimumEconomicSol} SOL`);
    return { id: null, isNew: false, blockedBy: 'below_minimum_economic_size', sizing };
  }
  const finalSize = sizing.finalSizeSol;
  console.log(`[position] sizing ${JSON.stringify(sizing)}`);

  const entryPrice = Number(entryQuote?.effectivePriceUsd || candidate.metrics.priceUsd || 0) || null;
  let entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  if (Number(entryQuote?.effectiveMcapUsd) > 0) entryMcap = Number(entryQuote.effectiveMcapUsd);
  entryMcap = slippageAdjustedMcap(entryMcap, 'entry');
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const rrBlocked = riskRewardBlockReason(tp, sl);
  if (rrBlocked) return { id: null, isNew: false, blockedBy: rrBlocked, riskRewardRatio: riskRewardRatio(tp, sl) };
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);
  const entryFeeSol = Math.max(0, numSetting('dry_run_network_fee_sol', DRY_RUN_NETWORK_FEE_SOL))
    + Math.max(0, numSetting('dry_run_priority_fee_sol', DRY_RUN_PRIORITY_FEE_SOL));

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions
      WHERE mint = ? AND status = 'closed'
        AND coalesce(execution_mode, 'dry_run') != 'research'
        AND closed_at_ms > ?
      LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — execution position closed <24h ago`);
      return { id: recentClosed.id, isNew: false };
    }

    const WIN_BLOCK_DAYS_BY_STRATEGY = { sniper: 2, dip_buy: 5, smart_money: 3, degen: 1 };
    const stratId = strat.id || 'default';
    const WIN_BLOCK_DAYS = strat.win_block_days ?? WIN_BLOCK_DAYS_BY_STRATEGY[stratId] ?? numSetting('win_block_days', 7);
    const pastWin = db.prepare(`
      SELECT id, pnl_sol, closed_at_ms FROM dry_run_positions
      WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
        AND coalesce(execution_mode, 'dry_run') != 'research'
        AND closed_at_ms > ?
      ORDER BY closed_at_ms DESC LIMIT 1
    `).get(candidate.token.mint, now() - WIN_BLOCK_DAYS * 86400000);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past execution WIN exists`);
      return { id: pastWin.id, isNew: false, blockedBy: 'past_win', pastWinPnlSol: pastWin.pnl_sol, pastWinClosedAtMs: pastWin.closed_at_ms };
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, entry_fee_sol, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      candidateId, candidate.token.mint, candidate.token.symbol, now(), finalSize, entryPrice, entryMcap,
      Number(entryQuote?.tokenAmount) > 0 ? Number(entryQuote.tokenAmount) : null,
      entryPrice, entryMcap, tp, sl, trailingEnabled, trailingPercent, decision.id || null, strat.id, entryFeeSol,
      json({
        candidate, decision, reason, strategy: strat.id, sizing, entryQuote,
        strategyFamily: candidate.signals?.strategyFamily || candidate.strategyFamily || 'edge1',
        simulatorVersion: DRY_RUN_SIMULATOR_VERSION,
        entryQuoteMode: entryQuote ? 'position_sized' : 'fallback_mark',
        llmConfidence: decision.confidence ?? null,
        signalRoute: candidate.signals?.route ?? null,
      }),
    );
    const positionId = Number(result.lastInsertRowid);
    if (entryQuote?.outputAmountRaw) db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(entryQuote.outputAmountRaw), positionId);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, finalSize, entryQuote?.tokenAmount || null, reason, json({ candidateId, decision, entryQuote }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy', sizeSolOverride = null) {
  const strat = activeStrategy();
  const sizeSol = Number.isFinite(Number(sizeSolOverride)) ? Number(sizeSolOverride) : calculatePositionSizeSol(candidate, decision, strat);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1`).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions
      WHERE mint = ? AND status = 'closed'
        AND coalesce(execution_mode, 'dry_run') != 'research'
        AND closed_at_ms > ?
      LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) return { id: recentClosed.id, isNew: false };
    const WIN_BLOCK_DAYS_BY_STRATEGY = { sniper: 2, dip_buy: 5, smart_money: 3, degen: 1 };
    const stratId = strat.id || 'default';
    const WIN_BLOCK_DAYS = strat.win_block_days ?? WIN_BLOCK_DAYS_BY_STRATEGY[stratId] ?? numSetting('win_block_days', 7);
    const pastWin = db.prepare(`
      SELECT id FROM dry_run_positions
      WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
        AND coalesce(execution_mode, 'dry_run') != 'research'
        AND closed_at_ms > ?
      LIMIT 1
    `).get(candidate.token.mint, now() - WIN_BLOCK_DAYS * 86400000);
    if (pastWin) return { id: pastWin.id, isNew: false };
    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, entry_fee_sol, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?, ?)
    `).run(
      candidateId, candidate.token.mint, candidate.token.symbol, now(), sizeSol, entryPrice, entryMcap, null,
      entryPrice, entryMcap, tp, sl, trailingEnabled, trailingPercent, decision.id || null,
      swap.signature, swap.outputAmount || null, strat.id, Number(swap.feeSol || 0),
      json({ candidate, decision, reason, swap, strategy: strat.id, strategyFamily: candidate.signals?.strategyFamily || candidate.strategyFamily || 'edge1' }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json) VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)`).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)`).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}
