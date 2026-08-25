import { db } from '../db/connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from '../db/settings.js';
import { calculatePositionSizeSol } from '../db/positions.js';
import { DRY_RUN_NETWORK_FEE_SOL, DRY_RUN_PRIORITY_FEE_SOL } from '../config.js';
import { fetchDryRunEntryQuote } from '../enrichment/jupiter.js';
import { ensureResearchSchema } from './schema.js';
import { initialRiskSol, plannedRiskReward, nextExcursionState, rMultiple } from './rr.js';
import { hunterPolicy } from '../pipeline/hunterPolicy.js';
import {
  applyModeledExitFee,
  fetchResearchEntryExecutionProfile,
  sizeImpactPct,
} from './executionCost.js';
import { assertPaperWalletCapacity } from './virtualWallet.js';

export const RESEARCH_SIMULATOR_VERSION = 'zero_capital_execution_cost_v2';

let pendingResearchPositionCount = 0;

function boundedPositive(value, fallback, min = 0.001, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function researchReferenceNotionalSol() {
  return boundedPositive(numSetting('research_notional_sol', 0.05), 0.05);
}

export function researchPositionCap() {
  const configured = Math.max(1, Math.min(100, Math.floor(numSetting('research_max_open_positions', 12))));
  const strategyMax = Number(activeStrategy()?.max_open_positions);
  return Math.max(1, Math.min(configured, Number.isFinite(strategyMax) && strategyMax > 0 ? strategyMax : configured));
}

function persistedResearchPositionCount() {
  ensureResearchSchema();
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'open'
  `).get()?.count || 0);
}

export function openResearchPositionCount() {
  return persistedResearchPositionCount() + pendingResearchPositionCount;
}

export function pendingResearchPositions() {
  return pendingResearchPositionCount;
}

export function canOpenResearchPosition() {
  return openResearchPositionCount() < researchPositionCap();
}

export function tryReserveResearchPositionSlot() {
  const max = researchPositionCap();
  if (openResearchPositionCount() >= max) return false;
  pendingResearchPositionCount += 1;
  return true;
}

export function releaseResearchPositionSlot() {
  pendingResearchPositionCount = Math.max(0, pendingResearchPositionCount - 1);
}

export function resetResearchCapacityForTests() {
  pendingResearchPositionCount = 0;
}

export function researchQuoteLadder(referenceNotional = researchReferenceNotionalSol()) {
  const raw = setting('research_quote_ladder_sol', '[0.01,0.025,0.05,0.1]');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = String(raw).split(',').map(value => Number(value.trim()));
  }
  const values = Array.isArray(parsed) ? parsed : [];
  values.push(referenceNotional);
  return [...new Set(values
    .map(value => boundedPositive(value, 0, 0.001, 1))
    .filter(value => value > 0)
    .map(value => Number(value.toFixed(6))))]
    .sort((a, b) => a - b)
    .slice(0, 5);
}

export async function fetchResearchQuoteLadder(candidate, referenceNotional = researchReferenceNotionalSol()) {
  const decimals = Number(candidate?.jupiterAsset?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('Research simulation requires token decimals for executable Jupiter quotes.');
  }
  const mint = candidate?.token?.mint;
  if (!mint) throw new Error('Research simulation requires token mint.');

  const executionProfile = await fetchResearchEntryExecutionProfile({
    mint,
    notionalSol: referenceNotional,
    decimals,
    referencePriceUsd: candidate.metrics?.priceUsd,
    referenceMcapUsd: candidate.metrics?.marketCapUsd,
  });

  const ladder = researchQuoteLadder(referenceNotional);
  const quotes = [];
  for (const notionalSol of ladder) {
    if (Math.abs(notionalSol - referenceNotional) < 1e-9) {
      quotes.push({ notionalSol, quote: executionProfile.fillQuote });
      continue;
    }
    const quote = await fetchDryRunEntryQuote(
      mint,
      notionalSol,
      decimals,
      candidate.metrics?.priceUsd,
      candidate.metrics?.marketCapUsd,
    );
    quotes.push({ notionalSol, quote: quote || null });
  }

  const baselineQuote = quotes.find(item => item.quote?.effectivePriceUsd)?.quote || executionProfile.fillQuote;
  executionProfile.sizeImpactPct = sizeImpactPct(executionProfile.fillQuote, baselineQuote);
  return {
    referenceNotional,
    primary: executionProfile.fillQuote,
    quotes,
    executionProfile,
  };
}

function riskSeverity(candidate) {
  return (candidate?.riskFlags || []).reduce((sum, flag) => sum + Math.max(0, Number(flag?.severity) || 0), 0);
}

export function createResearchPosition(candidateId, candidate, decision, quoteBundle, reason = 'research_zero_capital') {
  ensureResearchSchema();
  const strat = activeStrategy();
  const notionalSol = Number(quoteBundle?.referenceNotional);
  const entryQuote = quoteBundle?.primary;
  if (!Number.isFinite(notionalSol) || notionalSol <= 0 || !entryQuote?.outputAmountRaw) {
    throw new Error('Research position requires positive virtual notional and executable entry quote.');
  }

  const tp = Number(decision?.suggested_tp_percent ?? strat.tp_percent ?? numSetting('default_tp_percent', 50));
  const sl = Number(decision?.suggested_sl_percent ?? strat.sl_percent ?? numSetting('default_sl_percent', -25));
  const plannedRr = plannedRiskReward(tp, sl);
  const executionProfile = quoteBundle?.executionProfile || null;
  const fallbackEntryFeeSol = Math.max(0, numSetting('dry_run_network_fee_sol', DRY_RUN_NETWORK_FEE_SOL))
    + Math.max(0, numSetting('dry_run_priority_fee_sol', DRY_RUN_PRIORITY_FEE_SOL));
    const entryFeeSol = Math.max(0, Number(executionProfile?.entryFees?.totalFeeSol ?? fallbackEntryFeeSol));
  const expectedExitFeeSol = Math.max(0, Number(executionProfile?.expectedExitFees?.totalFeeSol ?? entryFeeSol));
  const riskSol = initialRiskSol({
    notionalSol,
    stopPercent: sl,
    entryFeeSol,
    expectedExitFeeSol,
  });

  const entryPrice = Number(entryQuote.effectivePriceUsd || candidate.metrics?.priceUsd || 0) || null;
  const entryMcap = Number(entryQuote.effectiveMcapUsd || candidate.metrics?.marketCapUsd || candidate.metrics?.graduatedMarketCapUsd || 0) || null;
  if (!entryPrice || !entryMcap) throw new Error('Research executable entry quote could not produce price/mcap reference.');

  const policy = hunterPolicy({
    confidence: decision?.confidence,
    preScore: candidate?.filters?.preScore,
    momentum: candidate?.filters?.momentumScore,
    totalSoftRiskSeverity: riskSeverity(candidate),
    catastrophic: false,
  });
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = Number(strat.trailing_percent ?? numSetting('default_trailing_percent', 20));
  const trailingArmPercent = numSetting('trailing_arm_percent', 15);
  const cooldownMs = Math.max(0, numSetting('research_reentry_cooldown_minutes', 30)) * 60_000;

  return db.transaction(() => {
    assertPaperWalletCapacity(notionalSol, entryFeeSol);
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions
      WHERE mint = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
      LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false, blockedBy: 'position_already_open' };

    if (cooldownMs > 0) {
      const recent = db.prepare(`
        SELECT id FROM dry_run_positions
        WHERE mint = ? AND execution_mode = 'research' AND status = 'closed' AND closed_at_ms > ?
        ORDER BY closed_at_ms DESC LIMIT 1
      `).get(candidate.token.mint, now() - cooldownMs);
      if (recent) return { id: recent.id, isNew: false, blockedBy: 'research_reentry_cooldown' };
    }

    const snapshot = {
      candidate,
      decision,
      reason,
      strategy: strat.id,
      strategyFamily: candidate.signals?.strategyFamily || candidate.strategyFamily || 'edge1',
      simulatorVersion: RESEARCH_SIMULATOR_VERSION,
      executionMode: 'research',
      researchSimulation: true,
      realCapitalSol: 0,
      simNotionalSol: notionalSol,
      entryQuoteMode: executionProfile ? 'latency_requoted_position_sized' : 'position_sized',
      quoteLadder: quoteBundle.quotes,
      executionCost: executionProfile,
      llmConfidence: decision?.confidence ?? null,
      signalRoute: candidate.signals?.route ?? null,
      hunterPolicy: policy,
      broadcast: false,
      walletRequired: false,
    };

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_arm_percent, trailing_armed, llm_decision_id,
        execution_mode, token_amount_raw, strategy_id, entry_fee_sol, snapshot_json,
        real_capital_sol, sim_notional_sol, initial_risk_percent, initial_risk_sol, planned_rr,
        low_water_price, low_water_mcap, mfe_percent, mae_percent, mfe_r, mae_r,
        research_data_quality, research_quote_ladder_json
      ) VALUES (
        ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?,
        'research', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?
      )
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      notionalSol,
      entryPrice,
      entryMcap,
      Number(entryQuote.tokenAmount) > 0 ? Number(entryQuote.tokenAmount) : null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      trailingArmPercent,
      decision?.id || null,
      String(entryQuote.outputAmountRaw),
      strat.id,
      entryFeeSol,
      json(snapshot),
      notionalSol,
      Math.abs(sl),
      riskSol,
      plannedRr,
      entryPrice,
      entryMcap,
      executionProfile?.quality || 'entry_executable',
      json(quoteBundle.quotes),
    );

    const positionId = Number(result.lastInsertRowid);
    if (executionProfile) {
      db.prepare(`
        UPDATE dry_run_positions
        SET research_execution_cost_json = ?, entry_latency_ms = ?,
            entry_quote_deterioration_pct = ?, entry_roundtrip_spread_pct = ?,
            entry_size_impact_pct = ?, entry_priority_fee_sol = ?, entry_jito_tip_sol = ?
        WHERE id = ?
      `).run(
        json(executionProfile),
        executionProfile.measuredQuoteToFillLatencyMs ?? null,
        executionProfile.quoteDeteriorationPct ?? null,
        executionProfile.roundTripSpreadPct ?? null,
        executionProfile.sizeImpactPct ?? null,
        executionProfile.entryFees?.priorityFeeSol ?? 0,
        executionProfile.entryFees?.jitoTipSol ?? 0,
        positionId,
      );
    }

    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      positionId,
      candidate.token.mint,
      now(),
      entryPrice,
      entryMcap,
      notionalSol,
      Number(entryQuote.tokenAmount) > 0 ? Number(entryQuote.tokenAmount) : null,
      reason,
      json({
        candidateId,
        decision,
        realCapitalSol: 0,
        simNotionalSol: notionalSol,
        entryQuote,
        quoteLadder: quoteBundle.quotes,
        executionCost: executionProfile,
        hunterPolicy: policy,
      }),
    );
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());

    return {
      id: positionId,
      isNew: true,
      realCapitalSol: 0,
      simNotionalSol: notionalSol,
      plannedRr,
      initialRiskSol: riskSol,
      executionCost: executionProfile,
      hunterPolicy: policy,
    };
  })();
}

export async function executeResearchEntry(selectedRow, decision, reason = 'research_zero_capital') {
  if (!tryReserveResearchPositionSlot()) {
    return { id: null, isNew: false, blockedBy: 'research_position_cap' };
  }
  try {
    // PAPER uses the same strategy/risk sizing calculation as LIVE. The only
    // difference is that this notional is reserved in the virtual wallet.
    const notional = calculatePositionSizeSol(selectedRow.candidate, decision, activeStrategy());
    if (!Number.isFinite(notional) || notional <= 0) {
      return { id: null, isNew: false, blockedBy: 'below_minimum_economic_size' };
    }
    const quoteBundle = await fetchResearchQuoteLadder(selectedRow.candidate, notional);
    return createResearchPosition(selectedRow.id, selectedRow.candidate, decision, quoteBundle, reason);
  } finally {
    releaseResearchPositionSlot();
  }
}

export function recordResearchObservation(positionId, result, { exitFees = null } = {}) {
  ensureResearchSchema();
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!row || row.execution_mode !== 'research' || !result) return null;

  const executionCost = safeParse(row.research_execution_cost_json, null);
  const expectedExitFees = exitFees || executionCost?.expectedExitFees || executionCost?.entryFees || null;
  const rawPnlPercent = Number(result.pnl_percent ?? result.pnlPercent);
  const rawPnlSol = Number(result.pnl_sol ?? result.pnlSol);
  const closed = row.status === 'closed' || result.status === 'closed' || Boolean(result.exitReason || result.exit_reason);

  let pnlSol = rawPnlSol;
  let pnlPercent = rawPnlPercent;
  let modeledExitFeeSol = Math.max(0, Number(expectedExitFees?.totalFeeSol || 0));

  if (closed) {
    const overlay = applyModeledExitFee({ result, row, exitFees: expectedExitFees });
    if (overlay) {
      pnlSol = overlay.modeledPnlSol;
      pnlPercent = overlay.modeledPnlPercent;
      modeledExitFeeSol = overlay.modeledExitFeeSol;
      db.prepare(`
        UPDATE dry_run_positions
        SET pnl_sol = ?, pnl_percent = ?, exit_fee_sol = ?,
            modeled_exit_fee_sol = ?, modeled_net_pnl_sol = ?, modeled_net_pnl_percent = ?
        WHERE id = ?
      `).run(pnlSol, pnlPercent, modeledExitFeeSol, modeledExitFeeSol, pnlSol, pnlPercent, positionId);
    }
  } else if (Number.isFinite(rawPnlSol)) {
    const entryFeeSol = Math.max(0, Number(row.entry_fee_sol || 0));
    const costBasis = Math.max(0, Number(row.sim_notional_sol || row.size_sol || 0)) + entryFeeSol + modeledExitFeeSol;
    pnlSol = rawPnlSol - entryFeeSol - modeledExitFeeSol;
    pnlPercent = costBasis > 0 ? pnlSol / costBasis * 100 : rawPnlPercent;
  }

  const riskSol = Number(row.initial_risk_sol || 0);
  const ageMs = Math.max(0, now() - Number(row.opened_at_ms || now()));
  const excursion = nextExcursionState({
    pnlPercent,
    pnlSol,
    riskSol,
    previousMfePercent: row.mfe_percent,
    previousMaePercent: row.mae_percent,
    previousMfeR: row.mfe_r,
    previousMaeR: row.mae_r,
    previousTimeToMfeMs: row.time_to_mfe_ms,
    previousTimeToMaeMs: row.time_to_mae_ms,
    ageMs,
  });
  const realizedR = closed ? rMultiple(pnlSol, riskSol) : null;
  const dataQuality = executionCost?.quality
    ? `execution_cost_v2_${executionCost.quality}`
    : (row.token_amount_raw ? 'entry_executable_exit_quote_preferred' : 'degraded');

  db.prepare(`
    UPDATE dry_run_positions
    SET low_water_price = CASE
          WHEN low_water_price IS NULL THEN ?
          WHEN ? IS NULL THEN low_water_price
          ELSE MIN(low_water_price, ?)
        END,
        low_water_mcap = CASE
          WHEN low_water_mcap IS NULL THEN ?
          WHEN ? IS NULL THEN low_water_mcap
          ELSE MIN(low_water_mcap, ?)
        END,
        mfe_percent = ?, mae_percent = ?, mfe_r = ?, mae_r = ?,
        time_to_mfe_ms = ?, time_to_mae_ms = ?,
        realized_r = COALESCE(?, realized_r),
        modeled_exit_fee_sol = COALESCE(?, modeled_exit_fee_sol),
        modeled_net_pnl_sol = ?, modeled_net_pnl_percent = ?,
        research_data_quality = ?
    WHERE id = ?
  `).run(
    result.price ?? null,
    result.price ?? null,
    result.price ?? null,
    result.mcap ?? null,
    result.mcap ?? null,
    result.mcap ?? null,
    excursion.mfePercent,
    excursion.maePercent,
    excursion.mfeR,
    excursion.maeR,
    excursion.timeToMfeMs,
    excursion.timeToMaeMs,
    realizedR,
    modeledExitFeeSol || null,
    Number.isFinite(pnlSol) ? pnlSol : null,
    Number.isFinite(pnlPercent) ? pnlPercent : null,
    dataQuality,
    positionId,
  );

  db.prepare(`
    INSERT INTO research_observations (
      position_id, mint, at_ms, price, mcap, pnl_percent, pnl_sol, r_multiple,
      quote_valid, data_quality, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    positionId,
    row.mint,
    now(),
    result.price ?? null,
    result.mcap ?? null,
    Number.isFinite(pnlPercent) ? pnlPercent : null,
    Number.isFinite(pnlSol) ? pnlSol : null,
    excursion.currentR,
    dataQuality,
    json({
      status: closed ? 'closed' : row.status,
      exitReason: result.exitReason || result.exit_reason || null,
      highWaterMcap: result.high_water_mcap ?? result.highWaterMcap ?? null,
      realCapitalSol: 0,
      simNotionalSol: row.sim_notional_sol,
      modeledExitFeeSol,
      executionCostVersion: executionCost?.version || null,
    }),
  );

  return { ...excursion, realizedR, dataQuality, pnlSol, pnlPercent, modeledExitFeeSol };
}
