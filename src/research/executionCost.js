import { DRY_RUN_NETWORK_FEE_SOL, DRY_RUN_PRIORITY_FEE_SOL, JITO_ENABLED, SOLANA_RPC_URL } from '../config.js';
import { boolSetting, numSetting } from '../db/settings.js';
import { fetchDryRunEntryQuote, fetchTokenExitQuote } from '../enrichment/jupiter.js';
import { now, sleep } from '../utils.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;
const DEFAULT_JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

function finiteNonNegative(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function percentile(values = [], percentileValue = 0.75) {
  const clean = values.map(Number).filter(Number.isFinite).filter(value => value >= 0).sort((a, b) => a - b);
  if (!clean.length) return null;
  const p = Math.max(0, Math.min(1, Number(percentileValue) || 0));
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil(p * clean.length) - 1));
  return clean[index];
}

export function priorityFeeSolFromMicroLamportsPerCu(microLamportsPerCu, computeUnitLimit) {
  const price = finiteNonNegative(microLamportsPerCu, 0);
  const cu = finiteNonNegative(computeUnitLimit, 0);
  if (price <= 0 || cu <= 0) return 0;
  const lamports = Math.ceil(price * cu / MICRO_LAMPORTS_PER_LAMPORT);
  return lamports / LAMPORTS_PER_SOL;
}

export function quoteDeteriorationPct(signalQuote, fillQuote) {
  const signal = Number(signalQuote?.tokenAmount);
  const fill = Number(fillQuote?.tokenAmount);
  if (!Number.isFinite(signal) || signal <= 0 || !Number.isFinite(fill) || fill <= 0) return null;
  return (signal - fill) / signal * 100;
}

export function roundTripExecutableSpreadPct(notionalSol, immediateExitSol) {
  const input = Number(notionalSol);
  const output = Number(immediateExitSol);
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output < 0) return null;
  return (input - output) / input * 100;
}

export function sizeImpactPct(referenceQuote, baselineQuote) {
  const referencePrice = Number(referenceQuote?.effectivePriceUsd);
  const baselinePrice = Number(baselineQuote?.effectivePriceUsd);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(baselinePrice) || baselinePrice <= 0) return null;
  return (referencePrice / baselinePrice - 1) * 100;
}

export function expectedFailureFeeOverheadSol(transactionFeeSol, failureProbability, expectedRetries = 1) {
  const fee = finiteNonNegative(transactionFeeSol, 0);
  const probability = Math.max(0, Math.min(1, Number(failureProbability) || 0));
  const retries = Math.max(0, Number(expectedRetries) || 0);
  return fee * probability * retries;
}

async function postJson(url, body, timeoutMs = 5000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(500, timeoutMs)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchPriorityFeeEstimate() {
  const fallbackSol = Math.max(0, numSetting('dry_run_priority_fee_sol', DRY_RUN_PRIORITY_FEE_SOL));
  if (!boolSetting('research_dynamic_priority_fee_enabled', true)) {
    return { feeSol: fallbackSol, source: 'configured_fallback', quality: 'configured' };
  }

  const computeUnitLimit = Math.max(1, Math.min(1_400_000, Math.floor(numSetting('research_compute_unit_limit', 400_000))));
  const pct = Math.max(0, Math.min(1, numSetting('research_priority_fee_percentile', 0.75)));
  const capSol = Math.max(0, numSetting('research_max_priority_fee_sol', 0.01));

  try {
    const data = await postJson(SOLANA_RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getRecentPrioritizationFees',
      params: [[]],
    }, numSetting('research_fee_rpc_timeout_ms', 5000));
    const samples = Array.isArray(data?.result)
      ? data.result.map(row => Number(row?.prioritizationFee)).filter(Number.isFinite)
      : [];
    const selected = percentile(samples, pct);
    if (!Number.isFinite(selected)) throw new Error('no prioritization fee samples');
    const modeled = priorityFeeSolFromMicroLamportsPerCu(selected, computeUnitLimit);
    return {
      feeSol: Math.min(capSol, modeled),
      source: 'solana_getRecentPrioritizationFees',
      quality: 'dynamic',
      microLamportsPerCu: selected,
      computeUnitLimit,
      percentile: pct,
      sampleCount: samples.length,
    };
  } catch (error) {
    return {
      feeSol: fallbackSol,
      source: 'configured_fallback',
      quality: 'degraded',
      error: error.message,
      computeUnitLimit,
      percentile: pct,
    };
  }
}

export async function fetchJitoTipEstimate() {
  const includeJito = boolSetting('research_include_jito_tip', JITO_ENABLED);
  if (!includeJito) return { feeSol: 0, source: 'disabled', quality: 'disabled' };

  const fallbackSol = Math.max(0, numSetting('research_jito_tip_fallback_sol', 0.000001));
  const percentileName = String(numSetting('research_jito_tip_percentile', 50));
  const fieldMap = {
    '25': 'landed_tips_25th_percentile',
    '50': 'landed_tips_50th_percentile',
    '75': 'landed_tips_75th_percentile',
    '95': 'landed_tips_95th_percentile',
    '99': 'landed_tips_99th_percentile',
  };
  const field = fieldMap[percentileName] || fieldMap['50'];
  const capSol = Math.max(fallbackSol, numSetting('research_max_jito_tip_sol', 0.01));
  const endpoint = process.env.JITO_TIP_FLOOR_URL || DEFAULT_JITO_TIP_FLOOR_URL;

  try {
    const response = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(500, numSetting('research_fee_rpc_timeout_ms', 5000))),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    const tip = Number(Array.isArray(rows) ? rows[0]?.[field] : null);
    if (!Number.isFinite(tip) || tip < 0) throw new Error('invalid Jito tip floor response');
    return {
      feeSol: Math.min(capSol, Math.max(fallbackSol, tip)),
      source: 'jito_tip_floor',
      quality: 'dynamic',
      percentile: Number(percentileName) || 50,
      field,
    };
  } catch (error) {
    return { feeSol: fallbackSol, source: 'configured_fallback', quality: 'degraded', error: error.message };
  }
}

export async function estimateResearchTransactionFees(side = 'entry') {
  const baseFeeSol = Math.max(0, numSetting('dry_run_network_fee_sol', DRY_RUN_NETWORK_FEE_SOL));
  const [priority, jito] = await Promise.all([
    fetchPriorityFeeEstimate(),
    fetchJitoTipEstimate(),
  ]);
  const transactionFeeSol = baseFeeSol + finiteNonNegative(priority?.feeSol) + finiteNonNegative(jito?.feeSol);
  const failureProbability = Math.max(0, Math.min(1, numSetting('research_tx_failure_probability', 0)));
  const expectedRetries = Math.max(0, numSetting('research_expected_retries', 1));
  const expectedFailureOverheadSol = expectedFailureFeeOverheadSol(transactionFeeSol, failureProbability, expectedRetries);
  const totalFeeSol = transactionFeeSol + expectedFailureOverheadSol;
  const degraded = priority?.quality === 'degraded' || jito?.quality === 'degraded';
  return {
    side,
    baseFeeSol,
    priorityFeeSol: finiteNonNegative(priority?.feeSol),
    jitoTipSol: finiteNonNegative(jito?.feeSol),
    expectedFailureOverheadSol,
    failureProbability,
    expectedRetries,
    totalFeeSol,
    priority,
    jito,
    quality: degraded ? 'degraded' : 'dynamic',
    measuredAtMs: now(),
  };
}

export async function fetchResearchEntryExecutionProfile({
  mint,
  notionalSol,
  decimals,
  referencePriceUsd,
  referenceMcapUsd,
  quoteFn = fetchDryRunEntryQuote,
  exitQuoteFn = fetchTokenExitQuote,
  sleepFn = sleep,
} = {}) {
  const signalQuote = await quoteFn(mint, notionalSol, decimals, referencePriceUsd, referenceMcapUsd);
  if (!signalQuote?.outputAmountRaw) throw new Error('Execution Cost V2 requires an executable signal quote.');

  const signalReadyAtMs = now();
  const feePromise = estimateResearchTransactionFees('entry');
  const configuredLatencyMs = Math.max(0, Math.min(10_000, Math.floor(numSetting('research_quote_to_submit_latency_ms', 500))));
  if (configuredLatencyMs > 0) await sleepFn(configuredLatencyMs);

  const fillQuote = await quoteFn(mint, notionalSol, decimals, referencePriceUsd, referenceMcapUsd);
  if (!fillQuote?.outputAmountRaw) throw new Error('Execution Cost V2 requires an executable post-latency fill quote.');
  const fillReadyAtMs = now();

  const [immediateExitQuote, entryFees] = await Promise.all([
    exitQuoteFn(mint, fillQuote.outputAmountRaw),
    feePromise,
  ]);
  const immediateExitSol = Number(immediateExitQuote?.outSol);
  return {
    version: 'execution_cost_v2',
    signalQuote,
    fillQuote,
    immediateExitQuote: immediateExitQuote || null,
    configuredLatencyMs,
    measuredQuoteToFillLatencyMs: Math.max(0, fillReadyAtMs - signalReadyAtMs),
    quoteDeteriorationPct: quoteDeteriorationPct(signalQuote, fillQuote),
    roundTripSpreadPct: Number.isFinite(immediateExitSol)
      ? roundTripExecutableSpreadPct(notionalSol, immediateExitSol)
      : null,
    entryFees,
    expectedExitFees: { ...entryFees, side: 'exit_expected_at_entry' },
    quality: immediateExitQuote ? 'executable_roundtrip' : 'entry_executable_roundtrip_degraded',
  };
}

export function applyModeledExitFee({ result, row, exitFees }) {
  const rawPnlSol = Number(result?.pnl_sol ?? result?.pnlSol);
  if (!Number.isFinite(rawPnlSol)) return null;
  const legacyExitFeeSol = Math.max(0, Number(row?.exit_fee_sol || 0));
  const modeledExitFeeSol = Math.max(0, Number(exitFees?.totalFeeSol || 0));
  const modeledPnlSol = rawPnlSol + legacyExitFeeSol - modeledExitFeeSol;
  const costBasis = Math.max(0, Number(row?.sim_notional_sol || row?.size_sol || 0))
    + Math.max(0, Number(row?.entry_fee_sol || 0))
    + Math.max(0, Number(row?.realized_fee_sol || 0))
    + modeledExitFeeSol;
  const modeledPnlPercent = costBasis > 0 ? modeledPnlSol / costBasis * 100 : null;
  return { modeledPnlSol, modeledPnlPercent, modeledExitFeeSol, legacyExitFeeSol };
}
