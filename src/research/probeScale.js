import { db } from '../db/connection.js';
import { boolSetting, numSetting } from '../db/settings.js';
import { fetchDryRunEntryQuote, fetchJupiterAsset } from '../enrichment/jupiter.js';
import { evaluateRunnerLifecycle, marketFlowSnapshot } from '../execution/runnerLifecycle.js';
import { initialRiskSol } from './rr.js';
import { assertPaperWalletCapacity } from './virtualWallet.js';
import { json, now, safeJson } from '../utils.js';

function lifecycleOptions() {
  return {
    validationMinMs: Math.max(5, numSetting('probe_validation_min_seconds', 30)) * 1000,
    validationMaxMs: Math.max(10, numSetting('probe_validation_max_seconds', 90)) * 1000,
    confirmationPnlPercent: numSetting('probe_confirmation_pnl_percent', 3),
    thesisLossPercent: numSetting('probe_thesis_loss_percent', -10),
    catastrophicLossPercent: numSetting('catastrophic_loss_percent', -25),
    catastrophicLiquidityRetention: numSetting('catastrophic_liquidity_retention', 0.35),
    minimumBuyerRatio: numSetting('probe_min_buyer_ratio', 0.10),
    weakeningBuyerRatio: numSetting('runner_weakening_buyer_ratio', -0.15),
  };
}

function weightedAverage(oldValue, oldWeight, newValue, newWeight) {
  const total = Number(oldWeight) + Number(newWeight);
  if (!Number.isFinite(total) || total <= 0) return Number(newValue) || Number(oldValue) || null;
  return ((Number(oldValue) || 0) * Number(oldWeight) + (Number(newValue) || 0) * Number(newWeight)) / total;
}

export async function maybeScaleResearchProbe(position, {
  assetFn = fetchJupiterAsset,
  quoteFn = fetchDryRunEntryQuote,
} = {}) {
  if (!position || position.execution_mode !== 'research' || position.status !== 'open') return null;
  if (!boolSetting('probe_scale_paper_enabled', true)) return null;
  if (String(position.position_stage || 'LEGACY').toUpperCase() !== 'PROBE') return null;

  const snapshot = safeJson(position.snapshot_json, {});
  const candidate = snapshot?.candidate || {};
  const asset = await assetFn(position.mint, { useCache: false, ttlMs: 3000 });
  const currentMcap = Number(asset?.mcap || asset?.fdv || 0);
  const entryMcap = Number(position.entry_mcap || 0);
  const pnlPercent = currentMcap > 0 && entryMcap > 0
    ? (currentMcap / entryMcap - 1) * 100
    : Number(position.mark_pnl_percent || 0);
  const peakPnl = entryMcap > 0 && Number(position.high_water_mcap) > 0
    ? (Number(position.high_water_mcap) / entryMcap - 1) * 100
    : Math.max(0, pnlPercent);
  const entryLiquidityUsd = Number(candidate?.metrics?.liquidityUsd || candidate?.jupiterAsset?.liquidity || 0) || null;
  const flow = marketFlowSnapshot(asset, { entryLiquidityUsd });
  const lateEvidence = safeJson(position.late_evidence_json, null);
  flow.lateFlowScore = Number.isFinite(Number(lateEvidence?.domainEvidence?.flow?.score))
    ? Number(lateEvidence.domainEvidence.flow.score)
    : null;
  flow.sourceCount = Number(lateEvidence?.sourceCount || candidate?.signals?.sourceCount || 1);
  const lifecycle = evaluateRunnerLifecycle({
    persistedState: 'PROBE',
    ageMs: now() - Number(position.opened_at_ms),
    pnlPercent,
    peakPnl,
    flow,
  }, lifecycleOptions());

  if (lifecycle.action !== 'SCALE') {
    if (lifecycle.state !== 'PROBE') {
      db.prepare('UPDATE dry_run_positions SET position_stage = ? WHERE id = ? AND position_stage = ?')
        .run(lifecycle.state, position.id, 'PROBE');
    }
    return { scaled: false, lifecycle, pnlPercent, flow };
  }

  const targetSizeSol = Math.max(Number(position.size_sol), Number(position.target_size_sol || position.size_sol));
  const deltaSizeSol = targetSizeSol - Number(position.size_sol);
  const minimumEconomic = Math.max(0.001, numSetting('min_executable_position_sol', 0.001));
  if (deltaSizeSol < minimumEconomic) {
    db.prepare("UPDATE dry_run_positions SET position_stage = 'CONFIRMED' WHERE id = ? AND position_stage = 'PROBE'")
      .run(position.id);
    return { scaled: false, lifecycle: { ...lifecycle, reason: 'target_already_reached' }, pnlPercent, flow };
  }

  const feeSol = Math.max(0, numSetting('dry_run_network_fee_sol', 0.000005))
    + Math.max(0, numSetting('dry_run_priority_fee_sol', 0));
  assertPaperWalletCapacity(deltaSizeSol, feeSol);
  const decimals = Number(candidate?.jupiterAsset?.decimals ?? asset?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('Probe scale requires token decimals.');
  const quote = await quoteFn(
    position.mint,
    deltaSizeSol,
    decimals,
    asset?.usdPrice || candidate?.metrics?.priceUsd,
    currentMcap || candidate?.metrics?.marketCapUsd,
  );
  if (!quote?.outputAmountRaw || !(Number(quote?.tokenAmount) > 0)) {
    throw new Error('Probe scale requires an executable position-sized quote.');
  }

  const oldTokenEstimate = Math.max(0, Number(position.token_amount_est || 0));
  const addedTokenEstimate = Number(quote.tokenAmount);
  let totalRaw;
  try {
    totalRaw = (BigInt(String(position.token_amount_raw || '0')) + BigInt(String(quote.outputAmountRaw))).toString();
  } catch {
    throw new Error('Probe scale received invalid raw token inventory.');
  }
  const newEntryPrice = weightedAverage(position.entry_price, oldTokenEstimate, quote.effectivePriceUsd, addedTokenEstimate);
  const newEntryMcap = weightedAverage(position.entry_mcap, oldTokenEstimate, quote.effectiveMcapUsd, addedTokenEstimate);
  const newSizeSol = Number(position.size_sol) + deltaSizeSol;
  const newEntryFeeSol = Number(position.entry_fee_sol || 0) + feeSol;
  const newInitialRiskSol = initialRiskSol({
    notionalSol: newSizeSol,
    stopPercent: position.sl_percent,
    entryFeeSol: newEntryFeeSol,
    expectedExitFeeSol: feeSol,
  });
  snapshot.lifecycle = {
    ...(snapshot.lifecycle || {}),
    stage: 'CONFIRMED',
    scaledAtMs: now(),
    probeNotionalSol: Number(position.sim_notional_sol || position.size_sol),
    targetNotionalSol: targetSizeSol,
    scaleQuote: quote,
    confirmation: { pnlPercent, flow, reason: lifecycle.reason },
  };

  db.transaction(() => {
    const updated = db.prepare(`
      UPDATE dry_run_positions
      SET size_sol = ?, sim_notional_sol = ?, entry_price = ?, entry_mcap = ?,
          token_amount_est = ?, token_amount_raw = ?, entry_fee_sol = ?, initial_risk_sol = ?,
          position_stage = 'CONFIRMED', scale_count = scale_count + 1, last_scale_at_ms = ?, snapshot_json = ?
      WHERE id = ? AND execution_mode = 'research' AND status = 'open' AND position_stage = 'PROBE'
    `).run(
      newSizeSol, newSizeSol, newEntryPrice, newEntryMcap,
      oldTokenEstimate + addedTokenEstimate, totalRaw, newEntryFeeSol, newInitialRiskSol,
      now(), json(snapshot), position.id,
    );
    if (updated.changes !== 1) throw new Error('Probe scale lost its atomic stage claim.');
    db.prepare(`
      INSERT INTO dry_run_trades
        (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'PROBE_SCALE_CONFIRMED', ?)
    `).run(
      position.id, position.mint, now(), quote.effectivePriceUsd, quote.effectiveMcapUsd,
      deltaSizeSol, addedTokenEstimate,
      json({ lifecycle, flow, pnlPercent, quote, targetSizeSol }),
    );
  })();

  return { scaled: true, lifecycle, deltaSizeSol, newSizeSol, pnlPercent, flow, quote };
}
