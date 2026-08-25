import { JUPITER_SLIPPAGE_BPS } from '../config.js';
import { db } from '../db/connection.js';
import { fetchTokenExitQuote } from '../enrichment/jupiter.js';
import {
  fetchResearchEntryExecutionProfile,
} from '../research/executionCost.js';
import { researchReferenceNotionalSol } from '../research/engine.js';
import { initialRiskSol } from '../research/rr.js';
import { now } from '../utils.js';
import { ensureDecisionIntelligenceSchema } from './schema.js';

const activeReceipts = new Set();
let runtimeStarted = false;

function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function boundedRetryAt(attempts) {
  const seconds = Math.min(300, 15 * (2 ** Math.max(0, attempts - 1)));
  return now() + seconds * 1000;
}

function probeForReceipt(receiptId) {
  return db.prepare(`
    SELECT r.*, p.status AS probe_status, p.attempt_count AS probe_attempt_count,
           p.requested_at_ms, p.position_id AS probe_position_id
    FROM decision_receipts r
    JOIN decision_execution_probes p ON p.receipt_id = r.id
    WHERE r.id = ?
  `).get(receiptId) || null;
}

function matchingResearchPosition(receipt) {
  return db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE execution_mode = 'research'
      AND (llm_decision_id = ? OR candidate_id = ?)
    ORDER BY CASE WHEN llm_decision_id = ? THEN 0 ELSE 1 END, id DESC
    LIMIT 1
  `).get(receipt.decision_id, receipt.candidate_id, receipt.decision_id) || null;
}

function copyPositionExecutionProfile(receipt, position) {
  const profile = safeJson(position.research_execution_cost_json, null);
  if (!profile || !position.token_amount_raw) return false;
  const at = now();
  db.prepare(`
    UPDATE decision_execution_probes
    SET status = 'ready', started_at_ms = COALESCE(started_at_ms, ?), completed_at_ms = ?,
        attempt_count = attempt_count + 1, next_retry_at_ms = NULL, position_id = ?,
        sim_notional_sol = ?, token_amount_raw = ?, entry_effective_price_usd = ?,
        entry_effective_mcap_usd = ?, quote_to_fill_latency_ms = ?, decision_to_probe_ms = ?,
        quote_deterioration_pct = ?, roundtrip_spread_pct = ?, size_impact_pct = ?,
        entry_fee_sol = ?, expected_exit_fee_sol = ?, slippage_tolerance_bps = ?,
        profile_json = ?, error = NULL
    WHERE receipt_id = ?
  `).run(
    at,
    at,
    position.id,
    Number(position.sim_notional_sol || position.size_sol || 0),
    String(position.token_amount_raw),
    Number(position.entry_price || 0) || null,
    Number(position.entry_mcap || 0) || null,
    profile.measuredQuoteToFillLatencyMs ?? position.entry_latency_ms ?? null,
    Math.max(0, Number(position.opened_at_ms || at) - Number(receipt.created_at_ms || at)),
    profile.quoteDeteriorationPct ?? position.entry_quote_deterioration_pct ?? null,
    profile.roundTripSpreadPct ?? position.entry_roundtrip_spread_pct ?? null,
    profile.sizeImpactPct ?? position.entry_size_impact_pct ?? null,
    Number(profile.entryFees?.totalFeeSol ?? position.entry_fee_sol ?? 0),
    Number(profile.expectedExitFees?.totalFeeSol ?? profile.entryFees?.totalFeeSol ?? 0),
    JUPITER_SLIPPAGE_BPS,
    JSON.stringify({ ...profile, source: 'research_position_reuse', positionId: position.id }),
    receipt.id,
  );
  return true;
}

export async function processDecisionProbe(receiptId) {
  ensureDecisionIntelligenceSchema();
  if (activeReceipts.has(Number(receiptId))) return false;
  const receipt = probeForReceipt(receiptId);
  if (!receipt || receipt.mode !== 'research' || !['pending', 'degraded'].includes(receipt.probe_status)) return false;
  if (receipt.next_retry_at_ms && Number(receipt.next_retry_at_ms) > now()) return false;

  activeReceipts.add(Number(receiptId));
  try {
    const position = matchingResearchPosition(receipt);
    if (position && copyPositionExecutionProfile(receipt, position)) return true;

    // BUY decisions normally create a Research position with the richer quote
    // ladder. Give that path time to finish so Decision Intelligence can reuse it
    // instead of competing with the critical entry path for Jupiter quota.
    const ageMs = now() - Number(receipt.created_at_ms || now());
    if (receipt.verdict === 'BUY' && ageMs < 15_000) {
      db.prepare(`
        UPDATE decision_execution_probes
        SET next_retry_at_ms = ?, error = 'awaiting_research_position_profile'
        WHERE receipt_id = ?
      `).run(now() + 5_000, receipt.id);
      return false;
    }

    const snapshot = safeJson(receipt.snapshot_json, {}) || {};
    const decimals = Number(snapshot.jupiterAsset?.decimals ?? snapshot.marketContext?.jupiterAsset?.decimals);
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new Error('decision probe requires token decimals from decision-time Jupiter evidence');
    }
    const notionalSol = researchReferenceNotionalSol();
    const startedAtMs = now();
    db.prepare(`
      UPDATE decision_execution_probes
      SET status = 'running', started_at_ms = ?, attempt_count = attempt_count + 1,
          next_retry_at_ms = NULL, error = NULL
      WHERE receipt_id = ?
    `).run(startedAtMs, receipt.id);

    const profile = await fetchResearchEntryExecutionProfile({
      mint: receipt.mint,
      notionalSol,
      decimals,
      referencePriceUsd: snapshot.metrics?.priceUsd,
      referenceMcapUsd: snapshot.metrics?.marketCapUsd,
    });
    const completedAtMs = now();
    const fill = profile.fillQuote;
    db.prepare(`
      UPDATE decision_execution_probes
      SET status = 'ready', completed_at_ms = ?, sim_notional_sol = ?,
          token_amount_raw = ?, entry_effective_price_usd = ?, entry_effective_mcap_usd = ?,
          quote_to_fill_latency_ms = ?, decision_to_probe_ms = ?, quote_deterioration_pct = ?,
          roundtrip_spread_pct = ?, size_impact_pct = ?, entry_fee_sol = ?,
          expected_exit_fee_sol = ?, slippage_tolerance_bps = ?, profile_json = ?, error = NULL
      WHERE receipt_id = ?
    `).run(
      completedAtMs,
      notionalSol,
      String(fill.outputAmountRaw),
      Number(fill.effectivePriceUsd || 0) || null,
      Number(fill.effectiveMcapUsd || 0) || null,
      profile.measuredQuoteToFillLatencyMs ?? null,
      Math.max(0, startedAtMs - Number(receipt.created_at_ms || startedAtMs)),
      profile.quoteDeteriorationPct ?? null,
      profile.roundTripSpreadPct ?? null,
      profile.sizeImpactPct ?? null,
      Number(profile.entryFees?.totalFeeSol || 0),
      Number(profile.expectedExitFees?.totalFeeSol || profile.entryFees?.totalFeeSol || 0),
      JUPITER_SLIPPAGE_BPS,
      JSON.stringify({
        ...profile,
        source: 'decision_counterfactual_probe',
        decisionToProbeMs: Math.max(0, startedAtMs - Number(receipt.created_at_ms || startedAtMs)),
      }),
      receipt.id,
    );
    return true;
  } catch (error) {
    const current = db.prepare('SELECT attempt_count FROM decision_execution_probes WHERE receipt_id = ?').get(receipt.id);
    const attempts = Number(current?.attempt_count || 0);
    const terminal = attempts >= 3;
    db.prepare(`
      UPDATE decision_execution_probes
      SET status = ?, next_retry_at_ms = ?, error = ?
      WHERE receipt_id = ?
    `).run(terminal ? 'failed' : 'degraded', terminal ? null : boundedRetryAt(attempts), error.message, receipt.id);
    console.warn(`[decision-intel] probe #${receipt.id} ${terminal ? 'failed' : 'degraded'}: ${error.message}`);
    return false;
  } finally {
    activeReceipts.delete(Number(receiptId));
  }
}

function economicsForObservation(receipt, probe, outSol) {
  const notionalSol = Number(probe.sim_notional_sol || 0);
  const entryFeeSol = Math.max(0, Number(probe.entry_fee_sol || 0));
  const exitFeeSol = Math.max(0, Number(probe.expected_exit_fee_sol || 0));
  const netPnlSol = Number(outSol) - notionalSol - entryFeeSol - exitFeeSol;
  const costBasis = notionalSol + entryFeeSol + exitFeeSol;
  const pnlPercent = costBasis > 0 ? netPnlSol / costBasis * 100 : null;
  const riskSol = initialRiskSol({
    notionalSol,
    stopPercent: Number(receipt.planned_sl_percent),
    entryFeeSol,
    expectedExitFeeSol: exitFeeSol,
  });
  const rMultiple = riskSol > 0 ? netPnlSol / riskSol : null;
  return { netPnlSol, pnlPercent, riskSol, rMultiple };
}

export async function processDueDecisionObservation(observationId) {
  ensureDecisionIntelligenceSchema();
  const row = db.prepare(`
    SELECT o.*, r.mint, r.verdict, r.planned_sl_percent,
           p.status AS probe_status, p.sim_notional_sol, p.token_amount_raw,
           p.entry_fee_sol, p.expected_exit_fee_sol
    FROM decision_outcome_observations o
    JOIN decision_receipts r ON r.id = o.receipt_id
    JOIN decision_execution_probes p ON p.receipt_id = r.id
    WHERE o.id = ?
  `).get(observationId);
  if (!row || row.status === 'ready' || row.status === 'failed') return false;
  if (Number(row.due_at_ms) > now() || row.probe_status !== 'ready') return false;

  try {
    const quote = await fetchTokenExitQuote(row.mint, row.token_amount_raw);
    if (!quote || !Number.isFinite(Number(quote.outSol))) throw new Error('counterfactual exit quote unavailable');
    const observedAtMs = now();
    const economics = economicsForObservation(row, row, Number(quote.outSol));
    db.prepare(`
      UPDATE decision_outcome_observations
      SET observed_at_ms = ?, status = 'ready', attempt_count = attempt_count + 1,
          out_sol = ?, pnl_sol = ?, pnl_percent = ?, r_multiple = ?, quote_json = ?, error = NULL
      WHERE id = ?
    `).run(
      observedAtMs,
      Number(quote.outSol),
      economics.netPnlSol,
      economics.pnlPercent,
      economics.rMultiple,
      JSON.stringify({ ...quote, sampledAtMs: observedAtMs }),
      row.id,
    );
    finalizeDecisionOutcomeIfReady(row.receipt_id);
    return true;
  } catch (error) {
    const attempts = Number(row.attempt_count || 0) + 1;
    db.prepare(`
      UPDATE decision_outcome_observations
      SET attempt_count = ?, observed_at_ms = ?, status = ?, error = ?
      WHERE id = ?
    `).run(attempts, now(), attempts >= 3 ? 'failed' : 'degraded', error.message, row.id);
    finalizeDecisionOutcomeIfReady(row.receipt_id);
    return false;
  }
}

export function classifyDecisionOutcome(verdict, { finalR = null, sampledMfeR = null } = {}) {
  const final = Number(finalR);
  const mfe = Number(sampledMfeR);
  if (!Number.isFinite(final) || !Number.isFinite(mfe)) return 'INCOMPLETE';
  if (verdict === 'BUY') {
    if (final > 0) return 'TRUE_POSITIVE';
    if (mfe >= 1) return 'BUY_EXIT_DEPENDENT';
    return 'FALSE_POSITIVE';
  }
  if (verdict === 'PASS') {
    if (mfe >= 3) return 'FALSE_NEGATIVE_RUNNER';
    if (final >= 1) return 'FALSE_NEGATIVE';
    return 'TRUE_NEGATIVE';
  }
  if (mfe >= 3) return 'WATCH_MISSED_RUNNER';
  if (final >= 1) return 'WATCH_MISSED_UPSIDE';
  return 'WATCH_VALID';
}

export function finalizeDecisionOutcomeIfReady(receiptId) {
  ensureDecisionIntelligenceSchema();
  if (db.prepare('SELECT 1 FROM decision_outcomes WHERE receipt_id = ?').get(receiptId)) return false;
  const receipt = db.prepare('SELECT * FROM decision_receipts WHERE id = ?').get(receiptId);
  if (!receipt || receipt.mode !== 'research') return false;
  const observations = db.prepare(`
    SELECT * FROM decision_outcome_observations
    WHERE receipt_id = ?
    ORDER BY horizon_ms ASC
  `).all(receiptId);
  if (!observations.length) return false;
  const last = observations[observations.length - 1];
  if (Number(last.due_at_ms) > now()) return false;
  if (observations.some(row => !['ready', 'failed'].includes(row.status))) return false;

  const ready = observations.filter(row => row.status === 'ready' && Number.isFinite(Number(row.r_multiple)));
  const finalReady = ready.find(row => row.horizon_ms === last.horizon_ms) || null;
  const rValues = ready.map(row => Number(row.r_multiple));
  const finalR = finalReady ? Number(finalReady.r_multiple) : null;
  const sampledMfeR = rValues.length ? Math.max(...rValues) : null;
  const sampledMaeR = rValues.length ? Math.min(...rValues) : null;
  const classification = classifyDecisionOutcome(receipt.verdict, { finalR, sampledMfeR });
  const dataQuality = ready.length === observations.length ? 'complete_sampled_horizons' : 'degraded_sampled_horizons';
  const summary = {
    version: 'decision-outcome-v1',
    methodology: 'executable_exit_quotes_at_discrete_horizons',
    hindsightSafe: true,
    finalHorizonMs: last.horizon_ms,
    readyHorizons: ready.map(row => row.horizon_ms),
    failedHorizons: observations.filter(row => row.status === 'failed').map(row => row.horizon_ms),
    finalR,
    sampledMfeR,
    sampledMaeR,
    classification,
  };
  db.prepare(`
    INSERT INTO decision_outcomes (
      receipt_id, finalized_at_ms, final_horizon_ms, final_r,
      sampled_mfe_r, sampled_mae_r, classification, data_quality, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receiptId,
    now(),
    last.horizon_ms,
    finalR,
    sampledMfeR,
    sampledMaeR,
    classification,
    dataQuality,
    JSON.stringify(summary),
  );
  return true;
}

export function scheduleDecisionReceipt(receiptId) {
  const receipt = db.prepare('SELECT verdict, mode FROM decision_receipts WHERE id = ?').get(Number(receiptId));
  if (!receipt || receipt.mode !== 'research') return;
  const delayMs = receipt.verdict === 'BUY' ? 8_000 : 750;
  setTimeout(() => {
    processDecisionProbe(receiptId).catch(error => console.warn(`[decision-intel] scheduled probe failed: ${error.message}`));
  }, delayMs);
}

export async function runDecisionIntelligenceCycle() {
  ensureDecisionIntelligenceSchema();
  const at = now();
  const probes = db.prepare(`
    SELECT receipt_id FROM decision_execution_probes
    WHERE status IN ('pending', 'degraded')
      AND (next_retry_at_ms IS NULL OR next_retry_at_ms <= ?)
    ORDER BY requested_at_ms ASC
    LIMIT 2
  `).all(at);
  for (const row of probes) await processDecisionProbe(row.receipt_id);

  const observations = db.prepare(`
    SELECT id FROM decision_outcome_observations
    WHERE status IN ('pending', 'degraded') AND due_at_ms <= ?
      AND attempt_count < 3
    ORDER BY due_at_ms ASC
    LIMIT 4
  `).all(at);
  for (const row of observations) await processDueDecisionObservation(row.id);
}

export function startDecisionIntelligenceRuntime() {
  ensureDecisionIntelligenceSchema();
  if (runtimeStarted) return;
  runtimeStarted = true;
  setTimeout(() => runDecisionIntelligenceCycle().catch(error => console.error(`[decision-intel] startup cycle: ${error.message}`)), 10_000);
  setInterval(() => runDecisionIntelligenceCycle().catch(error => console.error(`[decision-intel] cycle: ${error.message}`)), 30_000);
}

export function resetDecisionIntelligenceRuntimeForTests() {
  runtimeStarted = false;
  activeReceipts.clear();
}
