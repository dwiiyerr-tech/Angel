import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { ensureLiveSafetySchema } from '../db/liveSafety.js';
import { ensureResearchSchema } from '../research/schema.js';
import { ensureResearchExitSimulatorSchema } from '../research/exitSimulator.js';
import { configuredTradingMode, modeCapabilities } from '../research/policy.js';
import { ensureDecisionIntelligenceSchema } from '../decisionIntelligence/schema.js';
import { ensureControlPlaneSchema } from '../controlPlane/schema.js';

export const READINESS_ENGINE_VERSION = 'prelive-readiness-v1';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clean(values) {
  return values.map(finite).filter(value => value != null);
}

function mean(values) {
  const rows = clean(values);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function median(values) {
  const rows = clean(values).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function maxDrawdownR(values) {
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const value of clean(values)) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    worst = Math.max(worst, peak - cumulative);
  }
  return worst;
}

export function positionRealizedR(row = {}, executionMode = 'research') {
  const stored = finite(row.realized_r);
  if (stored != null) return { value: stored, source: 'stored_realized_r' };

  // Research has a native realized-R pipeline. Missing Research R is missing
  // evidence and must reduce coverage rather than being silently reconstructed.
  // Shadow predates native R persistence, so transparent derivation is allowed.
  if (executionMode !== 'shadow_live') return { value: null, source: 'unavailable' };

  const pnlSol = finite(row.pnl_sol);
  let riskSol = finite(row.initial_risk_sol);
  const sizeSol = finite(row.size_sol);
  const slPercent = finite(row.sl_percent);
  if (!(riskSol > 0) && sizeSol > 0 && slPercent != null && Math.abs(slPercent) > 0) {
    riskSol = sizeSol * Math.abs(slPercent) / 100;
  }
  if (pnlSol != null && riskSol > 0) {
    return { value: pnlSol / riskSol, source: 'derived_pnl_sol_over_risk' };
  }

  const pnlPercent = finite(row.pnl_percent);
  if (pnlPercent != null && slPercent != null && Math.abs(slPercent) > 0) {
    return { value: pnlPercent / Math.abs(slPercent), source: 'derived_pnl_percent_over_sl' };
  }
  return { value: null, source: 'unavailable' };
}

function performanceForMode(executionMode, sinceMs) {
  const rows = db.prepare(`
    SELECT id, opened_at_ms, closed_at_ms, realized_r, mfe_r, mae_r,
           research_data_quality, pnl_sol, pnl_percent, initial_risk_sol,
           size_sol, sl_percent
    FROM dry_run_positions
    WHERE execution_mode = ? AND status = 'closed'
      AND COALESCE(closed_at_ms, opened_at_ms) >= ?
    ORDER BY COALESCE(closed_at_ms, opened_at_ms) ASC, id ASC
  `).all(executionMode, sinceMs);

  const rRows = rows.map(row => positionRealizedR(row, executionMode));
  const realized = clean(rRows.map(row => row.value));
  const winners = realized.filter(value => value > 0);
  const losers = realized.filter(value => value <= 0);
  const grossWinR = winners.reduce((sum, value) => sum + value, 0);
  const grossLossR = Math.abs(losers.reduce((sum, value) => sum + value, 0));
  const firstAt = rows.length ? Math.min(...rows.map(row => Number(row.opened_at_ms || row.closed_at_ms || Date.now()))) : null;
  const lastAt = rows.length ? Math.max(...rows.map(row => Number(row.closed_at_ms || row.opened_at_ms || 0))) : null;
  const capture = rows
    .map((row, index) => {
      const realizedR = finite(rRows[index]?.value);
      const mfeR = finite(row.mfe_r);
      return realizedR != null && mfeR != null && mfeR > 0 ? realizedR / mfeR : null;
    })
    .filter(value => value != null);
  const nativeRealizedRSample = rRows.filter(row => row.source === 'stored_realized_r').length;
  const derivedRealizedRSample = rRows.filter(row => row.value != null && row.source !== 'stored_realized_r').length;

  return {
    executionMode,
    closedTrades: rows.length,
    realizedRSample: realized.length,
    nativeRealizedRSample,
    derivedRealizedRSample,
    realizedRCoverage: ratio(realized.length, rows.length),
    rEvidenceMethod: executionMode === 'shadow_live'
      ? 'stored realized_r, else pnl_sol/risk, else pnl_percent/abs(SL)'
      : 'native realized_r only',
    evidenceSpanHours: firstAt != null && lastAt != null && lastAt >= firstAt ? (lastAt - firstAt) / 3_600_000 : 0,
    wins: winners.length,
    losses: losers.length,
    winRate: ratio(winners.length, realized.length),
    expectancyR: mean(realized),
    medianR: median(realized),
    averageWinnerR: mean(winners),
    averageLoserR: mean(losers),
    profitFactorR: grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? 999 : null),
    profitFactorInfinite: grossLossR === 0 && grossWinR > 0,
    medianMfeR: median(rows.map(row => row.mfe_r)),
    medianMaeR: median(rows.map(row => row.mae_r)),
    averageCaptureEfficiency: mean(capture),
    maxDrawdownR: maxDrawdownR(realized),
    degradedDataRows: rows.filter(row => String(row.research_data_quality || '').startsWith('degraded')).length,
  };
}

function researchExecutionSnapshot(sinceMs, researchClosedTrades) {
  const rows = db.prepare(`
    SELECT id, entry_latency_ms, entry_quote_deterioration_pct,
           entry_roundtrip_spread_pct, entry_size_impact_pct,
           entry_fee_sol, modeled_exit_fee_sol
    FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'closed'
      AND COALESCE(closed_at_ms, opened_at_ms) >= ?
    ORDER BY id ASC
  `).all(sinceMs);

  const finalSettlements = db.prepare(`
    SELECT s.position_id, s.status, s.quality, s.measured_latency_ms,
           s.quote_deterioration_pct, s.fee_sol
    FROM research_exit_settlements s
    JOIN dry_run_positions p ON p.id = s.position_id
    WHERE s.kind = 'final' AND p.execution_mode = 'research' AND p.status = 'closed'
      AND COALESCE(p.closed_at_ms, p.opened_at_ms) >= ?
  `).all(sinceMs);
  const completedFinals = finalSettlements.filter(row => row.status === 'completed');
  const pendingAll = Number(db.prepare("SELECT COUNT(*) AS count FROM research_exit_settlements WHERE status = 'pending'").get()?.count || 0);
  const entryEvidence = rows.filter(row => finite(row.entry_latency_ms) != null);

  return {
    closedTrades: researchClosedTrades,
    entryExecutionCoverage: ratio(entryEvidence.length, researchClosedTrades),
    exitV3Coverage: ratio(new Set(completedFinals.map(row => row.position_id)).size, researchClosedTrades),
    pendingExitSettlements: pendingAll,
    degradedFinalSettlements: completedFinals.filter(row => String(row.quality || '').startsWith('degraded')).length,
    medianEntryLatencyMs: median(rows.map(row => row.entry_latency_ms)),
    medianEntryQuoteDeteriorationPct: median(rows.map(row => row.entry_quote_deterioration_pct)),
    medianRoundtripSpreadPct: median(rows.map(row => row.entry_roundtrip_spread_pct)),
    medianSizeImpactPct: median(rows.map(row => row.entry_size_impact_pct)),
    medianExitLatencyMs: median(completedFinals.map(row => row.measured_latency_ms)),
    medianExitQuoteDeteriorationPct: median(completedFinals.map(row => row.quote_deterioration_pct)),
    averageEntryFeeSol: mean(rows.map(row => row.entry_fee_sol)),
    averageExitFeeSol: mean(completedFinals.map(row => row.fee_sol)),
  };
}

function decisionQualitySnapshot(sinceMs) {
  const rows = db.prepare(`
    SELECT r.id, r.verdict, p.status AS probe_status,
           o.classification, o.final_r, o.sampled_mfe_r, o.sampled_mae_r
    FROM decision_receipts r
    LEFT JOIN decision_execution_probes p ON p.receipt_id = r.id
    LEFT JOIN decision_outcomes o ON o.receipt_id = r.id
    WHERE r.created_at_ms >= ? AND r.mode = 'research'
    ORDER BY r.id ASC
  `).all(sinceMs);

  const finalized = rows.filter(row => row.classification);
  const finalizedBuy = finalized.filter(row => row.verdict === 'BUY');
  const finalizedNonBuy = finalized.filter(row => row.verdict === 'PASS' || row.verdict === 'WATCH');
  const falsePositive = finalizedBuy.filter(row => row.classification === 'FALSE_POSITIVE').length;
  const missedRunnerClasses = new Set(['FALSE_NEGATIVE_RUNNER', 'WATCH_MISSED_RUNNER']);
  const missedUpsideClasses = new Set([
    'FALSE_NEGATIVE',
    'FALSE_NEGATIVE_RUNNER',
    'WATCH_MISSED_UPSIDE',
    'WATCH_MISSED_RUNNER',
  ]);
  const missedRunners = finalizedNonBuy.filter(row => missedRunnerClasses.has(row.classification)).length;
  const missedUpside = finalizedNonBuy.filter(row => missedUpsideClasses.has(row.classification)).length;
  const classifications = {};
  for (const row of finalized) classifications[row.classification] = (classifications[row.classification] || 0) + 1;

  return {
    totalReceipts: rows.length,
    probeReady: rows.filter(row => row.probe_status === 'ready').length,
    probeReadyRate: ratio(rows.filter(row => row.probe_status === 'ready').length, rows.length),
    finalizedOutcomes: finalized.length,
    finalizedOutcomeRate: ratio(finalized.length, rows.length),
    finalizedBuy: finalizedBuy.length,
    finalizedNonBuy: finalizedNonBuy.length,
    falsePositive,
    falsePositiveRate: ratio(falsePositive, finalizedBuy.length),
    missedRunners,
    missedRunnerRate: ratio(missedRunners, finalizedNonBuy.length),
    missedUpside,
    missedUpsideRate: ratio(missedUpside, finalizedNonBuy.length),
    averageFinalR: mean(finalized.map(row => row.final_r)),
    medianFinalR: median(finalized.map(row => row.final_r)),
    medianSampledMfeR: median(finalized.map(row => row.sampled_mfe_r)),
    medianSampledMaeR: median(finalized.map(row => row.sampled_mae_r)),
    classifications,
  };
}

function liveSafetySnapshot() {
  ensureLiveSafetySchema();
  const unresolvedExecutions = Number(db.prepare("SELECT COUNT(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get()?.count || 0);
  const activeReservations = Number(db.prepare("SELECT COUNT(*) AS count FROM live_capital_reservations WHERE status = 'active'").get()?.count || 0);
  const unknownLivePositions = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM dry_run_positions
    WHERE execution_mode = 'live' AND status IN ('entry_unknown', 'exit_unknown', 'partial_exit_unknown')
  `).get()?.count || 0);
  const openInventoryAnomalies = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM dry_run_positions
    WHERE execution_mode = 'live' AND status = 'open'
      AND (token_amount_raw IS NULL OR token_amount_raw = '' OR token_amount_raw = '0'
           OR entry_signature IS NULL OR entry_signature = '')
  `).get()?.count || 0);
  const activeBuyWithoutReservation = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM execution_operations o
    LEFT JOIN live_capital_reservations r ON r.operation_id = o.id AND r.status = 'active'
    WHERE o.side = 'buy' AND COALESCE(o.execution_mode, 'live') = 'live'
      AND o.status IN ('pending', 'outcome_unknown') AND o.position_id IS NULL AND r.id IS NULL
  `).get()?.count || 0);
  const brokenReservationLinks = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM live_capital_reservations r
    LEFT JOIN execution_operations o ON o.id = r.operation_id
    WHERE r.status = 'active' AND COALESCE(o.status, '') NOT IN ('pending', 'outcome_unknown')
  `).get()?.count || 0);
  const duplicateLiveMints = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT mint FROM dry_run_positions
      WHERE execution_mode = 'live' AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
      GROUP BY mint HAVING COUNT(*) > 1
    )
  `).get()?.count || 0);
  const circuitOpen = ['1', 'true'].includes(String(db.prepare("SELECT value FROM settings WHERE key = 'live_circuit_breaker_open'").get()?.value || 'false').toLowerCase());
  const pragmas = {
    journalMode: String(db.pragma('journal_mode', { simple: true }) || '').toLowerCase(),
    synchronous: Number(db.pragma('synchronous', { simple: true })),
    busyTimeoutMs: Number(db.pragma('busy_timeout', { simple: true })),
    foreignKeys: Number(db.pragma('foreign_keys', { simple: true })),
  };
  const pragmaHealthy = pragmas.journalMode === 'wal'
    && pragmas.synchronous >= 2
    && pragmas.busyTimeoutMs >= 1000
    && pragmas.foreignKeys === 1;
  const blockerCount = unresolvedExecutions + activeReservations + unknownLivePositions
    + openInventoryAnomalies + activeBuyWithoutReservation + brokenReservationLinks + duplicateLiveMints
    + (circuitOpen ? 1 : 0) + (pragmaHealthy ? 0 : 1);

  return {
    blockerCount,
    clear: blockerCount === 0,
    circuitOpen,
    unresolvedExecutions,
    activeReservations,
    unknownLivePositions,
    openInventoryAnomalies,
    activeBuyWithoutReservation,
    brokenReservationLinks,
    duplicateLiveMints,
    pragmas,
    pragmaHealthy,
  };
}

function controlPlaneSnapshot() {
  ensureControlPlaneSchema();
  const active = db.prepare("SELECT version, status, config_hash, promoted_at_ms FROM config_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1").get() || null;
  const proposal = db.prepare(`
    SELECT id, status, proposed_version, parent_version, created_at_ms, test_started_at_ms, test_until_ms
    FROM strategy_proposals
    WHERE status IN ('pending_review', 'testing', 'promotion_ready', 'needs_extension')
    ORDER BY id DESC LIMIT 1
  `).get() || null;
  return {
    active,
    openProposal: proposal,
    stableForPreLive: Boolean(active) && !proposal,
  };
}

export function readinessThresholds() {
  return {
    researchMinClosed: Math.max(10, Math.floor(numSetting('readiness_research_min_closed', 50))),
    researchMinSpanHours: Math.max(1, numSetting('readiness_research_min_span_hours', 24)),
    researchMinExpectancyR: numSetting('readiness_research_min_expectancy_r', 0.05),
    researchMinProfitFactor: Math.max(1, numSetting('readiness_research_min_profit_factor', 1.15)),
    researchMinRealizedCoverage: Math.max(0.5, Math.min(1, numSetting('readiness_research_min_realized_coverage', 0.90))),
    researchMinEntryExecutionCoverage: Math.max(0.5, Math.min(1, numSetting('readiness_research_min_entry_execution_coverage', 0.80))),
    researchMinExitV3Coverage: Math.max(0.5, Math.min(1, numSetting('readiness_research_min_exit_v3_coverage', 0.80))),
    researchMaxDrawdownR: Math.max(1, numSetting('readiness_research_max_drawdown_r', 10)),
    maxMedianQuoteDeteriorationPct: Math.max(0, numSetting('readiness_max_median_quote_deterioration_pct', 5)),
    maxMedianRoundtripSpreadPct: Math.max(0, numSetting('readiness_max_median_roundtrip_spread_pct', 20)),
    decisionMinFinalized: Math.max(10, Math.floor(numSetting('readiness_decision_min_finalized', 30))),
    decisionMinProbeReadyRate: Math.max(0.5, Math.min(1, numSetting('readiness_decision_min_probe_ready_rate', 0.80))),
    decisionMaxMissedRunnerRate: Math.max(0, Math.min(1, numSetting('readiness_decision_max_missed_runner_rate', 0.15))),
    decisionMaxFalsePositiveRate: Math.max(0, Math.min(1, numSetting('readiness_decision_max_false_positive_rate', 0.40))),
    shadowMinClosed: Math.max(5, Math.floor(numSetting('readiness_shadow_min_closed', 30))),
    shadowMinSpanHours: Math.max(1, numSetting('readiness_shadow_min_span_hours', 24)),
    shadowMinExpectancyR: numSetting('readiness_shadow_min_expectancy_r', 0),
    shadowMinProfitFactor: Math.max(1, numSetting('readiness_shadow_min_profit_factor', 1.10)),
    shadowMinRealizedCoverage: Math.max(0.5, Math.min(1, numSetting('readiness_shadow_min_realized_coverage', 0.95))),
    shadowMaxDrawdownR: Math.max(1, numSetting('readiness_shadow_max_drawdown_r', 10)),
  };
}

function check(id, label, pass, { value = null, threshold = null, hard = true, detail = null } = {}) {
  return { id, label, pass: Boolean(pass), hard: Boolean(hard), value, threshold, detail };
}

function stageResult(stage, checks, eligibleLabel) {
  const weightedTotal = checks.reduce((sum, row) => sum + (row.hard ? 2 : 1), 0);
  const weightedPass = checks.reduce((sum, row) => sum + (row.pass ? (row.hard ? 2 : 1) : 0), 0);
  const hardBlockers = checks.filter(row => row.hard && !row.pass);
  const warnings = checks.filter(row => !row.hard && !row.pass);
  const eligible = hardBlockers.length === 0;
  return {
    stage,
    eligible,
    status: eligible ? eligibleLabel : 'NOT_READY',
    score: weightedTotal ? Math.round(weightedPass / weightedTotal * 100) : 0,
    hardBlockers,
    warnings,
    checks,
  };
}

export function evaluateReadinessEvidence(evidence, thresholds = readinessThresholds()) {
  const research = evidence.research || {};
  const shadow = evidence.shadow || {};
  const execution = evidence.execution || {};
  const decisions = evidence.decisions || {};
  const safety = evidence.safety || {};
  const controlPlane = evidence.controlPlane || {};
  const currentMode = evidence.currentMode || 'research';

  const researchChecks = [
    check('research_sample', 'Research closed sample', Number(research.closedTrades) >= thresholds.researchMinClosed, { value: research.closedTrades, threshold: `>=${thresholds.researchMinClosed}` }),
    check('research_span', 'Research evidence span', Number(research.evidenceSpanHours) >= thresholds.researchMinSpanHours, { value: research.evidenceSpanHours, threshold: `>=${thresholds.researchMinSpanHours}h` }),
    check('research_expectancy', 'Research expectancy', finite(research.expectancyR) != null && Number(research.expectancyR) >= thresholds.researchMinExpectancyR, { value: research.expectancyR, threshold: `>=${thresholds.researchMinExpectancyR}R` }),
    check('research_profit_factor', 'Research profit factor', finite(research.profitFactorR) != null && Number(research.profitFactorR) >= thresholds.researchMinProfitFactor, { value: research.profitFactorR, threshold: `>=${thresholds.researchMinProfitFactor}` }),
    check('research_r_coverage', 'Research native realized-R coverage', finite(research.realizedRCoverage) != null && Number(research.realizedRCoverage) >= thresholds.researchMinRealizedCoverage, { value: research.realizedRCoverage, threshold: `>=${thresholds.researchMinRealizedCoverage}` }),
    check('entry_execution_coverage', 'Executable entry evidence coverage', finite(execution.entryExecutionCoverage) != null && Number(execution.entryExecutionCoverage) >= thresholds.researchMinEntryExecutionCoverage, { value: execution.entryExecutionCoverage, threshold: `>=${thresholds.researchMinEntryExecutionCoverage}` }),
    check('exit_v3_coverage', 'Exit Simulator V3 coverage', finite(execution.exitV3Coverage) != null && Number(execution.exitV3Coverage) >= thresholds.researchMinExitV3Coverage, { value: execution.exitV3Coverage, threshold: `>=${thresholds.researchMinExitV3Coverage}` }),
    check('pending_research_exit', 'No pending Research exit settlements', Number(execution.pendingExitSettlements || 0) === 0, { value: execution.pendingExitSettlements || 0, threshold: '=0' }),
    check('research_drawdown', 'Research max drawdown', finite(research.maxDrawdownR) != null && Number(research.maxDrawdownR) <= thresholds.researchMaxDrawdownR, { value: research.maxDrawdownR, threshold: `<=${thresholds.researchMaxDrawdownR}R`, hard: false }),
    check('quote_deterioration', 'Median entry quote deterioration', finite(execution.medianEntryQuoteDeteriorationPct) == null || Number(execution.medianEntryQuoteDeteriorationPct) <= thresholds.maxMedianQuoteDeteriorationPct, { value: execution.medianEntryQuoteDeteriorationPct, threshold: `<=${thresholds.maxMedianQuoteDeteriorationPct}%`, hard: false }),
    check('roundtrip_spread', 'Median executable roundtrip spread', finite(execution.medianRoundtripSpreadPct) == null || Number(execution.medianRoundtripSpreadPct) <= thresholds.maxMedianRoundtripSpreadPct, { value: execution.medianRoundtripSpreadPct, threshold: `<=${thresholds.maxMedianRoundtripSpreadPct}%`, hard: false }),
    check('decision_finalized', 'Research Decision Intelligence finalized sample', Number(decisions.finalizedOutcomes || 0) >= thresholds.decisionMinFinalized, { value: decisions.finalizedOutcomes || 0, threshold: `>=${thresholds.decisionMinFinalized}`, hard: false }),
    check('probe_ready_rate', 'Decision executable-probe coverage', finite(decisions.probeReadyRate) != null && Number(decisions.probeReadyRate) >= thresholds.decisionMinProbeReadyRate, { value: decisions.probeReadyRate, threshold: `>=${thresholds.decisionMinProbeReadyRate}`, hard: false }),
    check('missed_runner_rate', 'Missed-runner rate', finite(decisions.missedRunnerRate) == null || Number(decisions.missedRunnerRate) <= thresholds.decisionMaxMissedRunnerRate, { value: decisions.missedRunnerRate, threshold: `<=${thresholds.decisionMaxMissedRunnerRate}`, hard: false }),
    check('false_positive_rate', 'BUY false-positive rate', finite(decisions.falsePositiveRate) == null || Number(decisions.falsePositiveRate) <= thresholds.decisionMaxFalsePositiveRate, { value: decisions.falsePositiveRate, threshold: `<=${thresholds.decisionMaxFalsePositiveRate}`, hard: false }),
  ];
  const researchToShadow = stageResult('research_to_shadow', researchChecks, 'READY_FOR_SHADOW');

  const shadowChecks = [
    check('research_gate', 'Research gate already passes', researchToShadow.eligible, { value: researchToShadow.score, threshold: 'eligible' }),
    check('shadow_sample', 'Shadow closed sample', Number(shadow.closedTrades || 0) >= thresholds.shadowMinClosed, { value: shadow.closedTrades || 0, threshold: `>=${thresholds.shadowMinClosed}` }),
    check('shadow_span', 'Shadow evidence span', Number(shadow.evidenceSpanHours || 0) >= thresholds.shadowMinSpanHours, { value: shadow.evidenceSpanHours || 0, threshold: `>=${thresholds.shadowMinSpanHours}h` }),
    check('shadow_expectancy', 'Shadow expectancy', finite(shadow.expectancyR) != null && Number(shadow.expectancyR) >= thresholds.shadowMinExpectancyR, { value: shadow.expectancyR, threshold: `>=${thresholds.shadowMinExpectancyR}R` }),
    check('shadow_profit_factor', 'Shadow profit factor', finite(shadow.profitFactorR) != null && Number(shadow.profitFactorR) >= thresholds.shadowMinProfitFactor, { value: shadow.profitFactorR, threshold: `>=${thresholds.shadowMinProfitFactor}` }),
    check('shadow_r_coverage', 'Shadow R coverage (native or transparent derived)', finite(shadow.realizedRCoverage) != null && Number(shadow.realizedRCoverage) >= thresholds.shadowMinRealizedCoverage, { value: shadow.realizedRCoverage, threshold: `>=${thresholds.shadowMinRealizedCoverage}`, detail: shadow.rEvidenceMethod || null }),
    check('safety_clear', 'Money-grade safety state clear', Boolean(safety.clear), { value: safety.blockerCount, threshold: '0 blockers' }),
    check('control_plane_stable', 'Stable active config with no challenger/config transition', Boolean(controlPlane.stableForPreLive), { value: controlPlane.openProposal?.status || (controlPlane.active ? 'stable' : 'no_active_config'), threshold: 'stable' }),
    check('shadow_drawdown', 'Shadow max drawdown', finite(shadow.maxDrawdownR) != null && Number(shadow.maxDrawdownR) <= thresholds.shadowMaxDrawdownR, { value: shadow.maxDrawdownR, threshold: `<=${thresholds.shadowMaxDrawdownR}R`, hard: false }),
  ];
  const shadowToConfirm = stageResult('shadow_to_confirm', shadowChecks, 'READY_FOR_CONFIRM');

  const liveChecks = [
    check('shadow_gate', 'Shadow gate already passes', shadowToConfirm.eligible, { value: shadowToConfirm.score, threshold: 'eligible' }),
    check('confirm_mode', 'System is explicitly in Confirm mode', currentMode === 'confirm', { value: currentMode, threshold: 'confirm' }),
    check('live_safety_clear', 'Live safety/ledger state clear', Boolean(safety.clear), { value: safety.blockerCount, threshold: '0 blockers' }),
    check('control_plane_frozen', 'Stable active config for pre-Live review', Boolean(controlPlane.stableForPreLive), { value: controlPlane.openProposal?.status || (controlPlane.active ? 'stable' : 'no_active_config'), threshold: 'stable' }),
    check('no_pending_research_exit', 'No unresolved Research settlement evidence', Number(execution.pendingExitSettlements || 0) === 0, { value: execution.pendingExitSettlements || 0, threshold: '=0' }),
    check('confirm_attribution', 'Confirm performance is not yet separately attributed from Live ledger identity', false, {
      value: 'shared_live_ledger_identity', threshold: 'isolated_confirm_performance', hard: false,
      detail: 'Manager must disclose this caveat; eligibility remains evidence-only and never authorizes Live.',
    }),
  ];
  const confirmToLiveConsideration = stageResult('confirm_to_live_consideration', liveChecks, 'ELIGIBLE_FOR_LIVE_CONSIDERATION');

  let currentStage = researchToShadow;
  if (currentMode === 'shadow_live') currentStage = shadowToConfirm;
  else if (currentMode === 'confirm' || currentMode === 'live') currentStage = confirmToLiveConsideration;

  return {
    researchToShadow,
    shadowToConfirm,
    confirmToLiveConsideration,
    currentStage,
    authority: {
      eligibilityOnly: true,
      canApproveLive: false,
      canEnableLive: false,
      canBroadcast: false,
      humanOwnerIsSoleLiveAuthority: true,
      note: 'ELIGIBLE_FOR_LIVE_CONSIDERATION is evidence eligibility, never authorization.',
    },
  };
}

export function buildReadinessEvidence(windowMs = 7 * 24 * 60 * 60 * 1000) {
  ensureResearchSchema();
  ensureResearchExitSimulatorSchema();
  ensureDecisionIntelligenceSchema();
  ensureControlPlaneSchema();
  ensureLiveSafetySchema();

  const safeWindowMs = Math.max(60 * 60 * 1000, Number(windowMs) || 7 * 24 * 60 * 60 * 1000);
  const sinceMs = Date.now() - safeWindowMs;
  const currentMode = configuredTradingMode();
  const research = performanceForMode('research', sinceMs);
  const shadow = performanceForMode('shadow_live', sinceMs);
  const evidence = {
    version: READINESS_ENGINE_VERSION,
    generatedAtMs: Date.now(),
    windowMs: safeWindowMs,
    sinceMs,
    currentMode,
    modeCapabilities: modeCapabilities(currentMode),
    research,
    shadow,
    execution: researchExecutionSnapshot(sinceMs, research.closedTrades),
    decisions: decisionQualitySnapshot(sinceMs),
    safety: liveSafetySnapshot(),
    controlPlane: controlPlaneSnapshot(),
    telemetryCaveat: {
      confirmTradesSeparatelyAttributed: false,
      reason: 'Confirm currently uses the money-grade Live executor and persisted Live position identity; readiness does not invent a separate Confirm performance sample.',
      shadowRMayBeDerived: true,
      shadowRMethod: 'stored realized_r when present, else pnl_sol / initial risk, else pnl_percent / abs(SL)',
    },
  };
  return evidence;
}

export function preLiveReadinessReport(windowMs = 7 * 24 * 60 * 60 * 1000) {
  const evidence = buildReadinessEvidence(windowMs);
  const thresholds = readinessThresholds();
  const evaluation = evaluateReadinessEvidence(evidence, thresholds);
  return {
    version: READINESS_ENGINE_VERSION,
    generatedAtMs: evidence.generatedAtMs,
    windowMs: evidence.windowMs,
    currentMode: evidence.currentMode,
    thresholds,
    evidence,
    evaluation,
  };
}
