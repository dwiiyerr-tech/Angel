import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { ensureLiveSafetySchema } from '../db/liveSafety.js';
import { ensureResearchSchema } from '../research/schema.js';
import { ensureResearchExitSimulatorSchema } from '../research/exitSimulator.js';
import { configuredTradingMode, modeCapabilities } from '../research/policy.js';
import { ensureDecisionIntelligenceSchema } from '../decisionIntelligence/schema.js';
import { ensureControlPlaneSchema } from '../controlPlane/schema.js';

export const READINESS_ENGINE_VERSION = 'paper-live-readiness-v2';

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

// Historical helper retained because older Shadow rows may still be inspected by
// offline reports. PAPER readiness itself uses native Research/Paper realized R
// only; missing R is missing evidence and is never silently reconstructed.
export function positionRealizedR(row = {}, executionMode = 'research') {
  const stored = finite(row.realized_r);
  if (stored != null) return { value: stored, source: 'stored_realized_r' };
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

function paperPerformance(sinceMs) {
  // New PAPER positions continue to use execution_mode='research' internally.
  // This preserves the mature zero-capital engine and historical evidence while
  // removing Research as a user-facing trading mode.
  const rows = db.prepare(`
    SELECT id, opened_at_ms, closed_at_ms, realized_r, mfe_r, mae_r,
           research_data_quality, pnl_sol, pnl_percent, initial_risk_sol,
           size_sol, sl_percent
    FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'closed'
      AND COALESCE(closed_at_ms, opened_at_ms) >= ?
    ORDER BY COALESCE(closed_at_ms, opened_at_ms) ASC, id ASC
  `).all(sinceMs);

  const rRows = rows.map(row => positionRealizedR(row, 'research'));
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

  return {
    executionMode: 'research',
    publicMode: 'paper',
    closedTrades: rows.length,
    realizedRSample: realized.length,
    nativeRealizedRSample: rRows.filter(row => row.source === 'stored_realized_r').length,
    realizedRCoverage: ratio(realized.length, rows.length),
    rEvidenceMethod: 'native realized_r only',
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

function paperExecutionSnapshot(sinceMs, paperClosedTrades) {
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
    closedTrades: paperClosedTrades,
    entryExecutionCoverage: ratio(entryEvidence.length, paperClosedTrades),
    exitV3Coverage: ratio(new Set(completedFinals.map(row => row.position_id)).size, paperClosedTrades),
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
  // Decision Intelligence still persists PAPER receipts with historical mode
  // label 'research'. It is an internal storage label, not a third runtime mode.
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
  const missedUpsideClasses = new Set(['FALSE_NEGATIVE', 'FALSE_NEGATIVE_RUNNER', 'WATCH_MISSED_UPSIDE', 'WATCH_MISSED_RUNNER']);
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
  // Keep existing setting keys to avoid a dangerous configuration migration.
  return {
    paperMinClosed: Math.max(10, Math.floor(numSetting('readiness_research_min_closed', 50))),
    paperMinSpanHours: Math.max(1, numSetting('readiness_research_min_span_hours', 24)),
    paperMinExpectancyR: numSetting('readiness_research_min_expectancy_r', 0.05),
    paperMinProfitFactor: Math.max(1, numSetting('readiness_research_min_profit_factor', 1.15)),
    paperMinRealizedCoverage: Math.max(0.5, Math.min(1, numSetting('readiness_research_min_realized_coverage', 0.90))),
    paperMinEntryExecutionCoverage: Math.max(0.5, Math.min(1, numSetting('readiness_research_min_entry_execution_coverage', 0.80))),
    paperMinExitV3Coverage: Math.max(0.5, Math.min(1, numSetting('readiness_research_min_exit_v3_coverage', 0.80))),
    paperMaxDrawdownR: Math.max(1, numSetting('readiness_research_max_drawdown_r', 10)),
    maxMedianQuoteDeteriorationPct: Math.max(0, numSetting('readiness_max_median_quote_deterioration_pct', 5)),
    maxMedianRoundtripSpreadPct: Math.max(0, numSetting('readiness_max_median_roundtrip_spread_pct', 20)),
    decisionMinFinalized: Math.max(10, Math.floor(numSetting('readiness_decision_min_finalized', 30))),
    decisionMinProbeReadyRate: Math.max(0.5, Math.min(1, numSetting('readiness_decision_min_probe_ready_rate', 0.80))),
    decisionMaxMissedRunnerRate: Math.max(0, Math.min(1, numSetting('readiness_decision_max_missed_runner_rate', 0.15))),
    decisionMaxFalsePositiveRate: Math.max(0, Math.min(1, numSetting('readiness_decision_max_false_positive_rate', 0.40))),
  };
}

function check(id, label, pass, { value = null, threshold = null, hard = true, detail = null } = {}) {
  return { id, label, pass: Boolean(pass), hard: Boolean(hard), value, threshold, detail };
}

function gateResult(checks) {
  const weightedTotal = checks.reduce((sum, row) => sum + (row.hard ? 2 : 1), 0);
  const weightedPass = checks.reduce((sum, row) => sum + (row.pass ? (row.hard ? 2 : 1) : 0), 0);
  const hardBlockers = checks.filter(row => row.hard && !row.pass);
  const warnings = checks.filter(row => !row.hard && !row.pass);
  const eligible = hardBlockers.length === 0;
  return {
    stage: 'paper_to_live_review',
    eligible,
    status: eligible ? 'READY_FOR_LIVE_REVIEW' : 'NOT_READY',
    score: weightedTotal ? Math.round(weightedPass / weightedTotal * 100) : 0,
    hardBlockers,
    warnings,
    checks,
  };
}

export function evaluateReadinessEvidence(evidence, thresholds = readinessThresholds()) {
  const paper = evidence.paper || evidence.research || {};
  const execution = evidence.execution || {};
  const decisions = evidence.decisions || {};
  const safety = evidence.safety || {};
  const controlPlane = evidence.controlPlane || {};

  const checks = [
    check('paper_sample', 'Paper closed sample', Number(paper.closedTrades) >= thresholds.paperMinClosed, { value: paper.closedTrades, threshold: `>=${thresholds.paperMinClosed}` }),
    check('paper_span', 'Paper evidence span', Number(paper.evidenceSpanHours) >= thresholds.paperMinSpanHours, { value: paper.evidenceSpanHours, threshold: `>=${thresholds.paperMinSpanHours}h` }),
    check('paper_expectancy', 'Paper expectancy', finite(paper.expectancyR) != null && Number(paper.expectancyR) >= thresholds.paperMinExpectancyR, { value: paper.expectancyR, threshold: `>=${thresholds.paperMinExpectancyR}R` }),
    check('paper_profit_factor', 'Paper profit factor', finite(paper.profitFactorR) != null && Number(paper.profitFactorR) >= thresholds.paperMinProfitFactor, { value: paper.profitFactorR, threshold: `>=${thresholds.paperMinProfitFactor}` }),
    check('paper_r_coverage', 'Paper native realized-R coverage', finite(paper.realizedRCoverage) != null && Number(paper.realizedRCoverage) >= thresholds.paperMinRealizedCoverage, { value: paper.realizedRCoverage, threshold: `>=${thresholds.paperMinRealizedCoverage}` }),
    check('entry_execution_coverage', 'Executable entry evidence coverage', finite(execution.entryExecutionCoverage) != null && Number(execution.entryExecutionCoverage) >= thresholds.paperMinEntryExecutionCoverage, { value: execution.entryExecutionCoverage, threshold: `>=${thresholds.paperMinEntryExecutionCoverage}` }),
    check('exit_v3_coverage', 'Realistic exit simulator coverage', finite(execution.exitV3Coverage) != null && Number(execution.exitV3Coverage) >= thresholds.paperMinExitV3Coverage, { value: execution.exitV3Coverage, threshold: `>=${thresholds.paperMinExitV3Coverage}` }),
    check('pending_paper_exit', 'No pending Paper exit settlements', Number(execution.pendingExitSettlements || 0) === 0, { value: execution.pendingExitSettlements || 0, threshold: '=0' }),
    check('live_safety_clear', 'Live safety/ledger state clear', Boolean(safety.clear), { value: safety.blockerCount, threshold: '0 blockers' }),
    check('control_plane_stable', 'Stable active config with no challenger transition', Boolean(controlPlane.stableForPreLive), { value: controlPlane.openProposal?.status || (controlPlane.active ? 'stable' : 'no_active_config'), threshold: 'stable' }),
    check('paper_drawdown', 'Paper max drawdown', finite(paper.maxDrawdownR) != null && Number(paper.maxDrawdownR) <= thresholds.paperMaxDrawdownR, { value: paper.maxDrawdownR, threshold: `<=${thresholds.paperMaxDrawdownR}R`, hard: false }),
    check('quote_deterioration', 'Median entry quote deterioration', finite(execution.medianEntryQuoteDeteriorationPct) == null || Number(execution.medianEntryQuoteDeteriorationPct) <= thresholds.maxMedianQuoteDeteriorationPct, { value: execution.medianEntryQuoteDeteriorationPct, threshold: `<=${thresholds.maxMedianQuoteDeteriorationPct}%`, hard: false }),
    check('roundtrip_spread', 'Median executable roundtrip spread', finite(execution.medianRoundtripSpreadPct) == null || Number(execution.medianRoundtripSpreadPct) <= thresholds.maxMedianRoundtripSpreadPct, { value: execution.medianRoundtripSpreadPct, threshold: `<=${thresholds.maxMedianRoundtripSpreadPct}%`, hard: false }),
    check('decision_finalized', 'Paper Decision Intelligence finalized sample', Number(decisions.finalizedOutcomes || 0) >= thresholds.decisionMinFinalized, { value: decisions.finalizedOutcomes || 0, threshold: `>=${thresholds.decisionMinFinalized}`, hard: false }),
    check('probe_ready_rate', 'Decision executable-probe coverage', finite(decisions.probeReadyRate) != null && Number(decisions.probeReadyRate) >= thresholds.decisionMinProbeReadyRate, { value: decisions.probeReadyRate, threshold: `>=${thresholds.decisionMinProbeReadyRate}`, hard: false }),
    check('missed_runner_rate', 'Missed-runner rate', finite(decisions.missedRunnerRate) == null || Number(decisions.missedRunnerRate) <= thresholds.decisionMaxMissedRunnerRate, { value: decisions.missedRunnerRate, threshold: `<=${thresholds.decisionMaxMissedRunnerRate}`, hard: false }),
    check('false_positive_rate', 'BUY false-positive rate', finite(decisions.falsePositiveRate) == null || Number(decisions.falsePositiveRate) <= thresholds.decisionMaxFalsePositiveRate, { value: decisions.falsePositiveRate, threshold: `<=${thresholds.decisionMaxFalsePositiveRate}`, hard: false }),
  ];

  const paperToLiveConsideration = gateResult(checks);
  return {
    paperToLiveConsideration,
    currentStage: paperToLiveConsideration,
    currentMode: evidence.currentMode || 'paper',
    authority: {
      eligibilityOnly: true,
      canApproveLive: false,
      canEnableLive: false,
      canBroadcast: false,
      humanOwnerIsSoleLiveAuthority: true,
      note: 'READY_FOR_LIVE_REVIEW is evidence eligibility for owner review, never Live authorization.',
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
  const paper = paperPerformance(sinceMs);
  const evidence = {
    version: READINESS_ENGINE_VERSION,
    generatedAtMs: Date.now(),
    windowMs: safeWindowMs,
    sinceMs,
    currentMode,
    modeCapabilities: modeCapabilities(currentMode),
    paper,
    // Temporary compatibility alias for old report consumers. Do not present it
    // as another mode in UI/Manager responses.
    research: paper,
    execution: paperExecutionSnapshot(sinceMs, paper.closedTrades),
    decisions: decisionQualitySnapshot(sinceMs),
    safety: liveSafetySnapshot(),
    controlPlane: controlPlaneSnapshot(),
    storageCompatibility: {
      publicModes: ['paper', 'live'],
      paperPositionExecutionMode: 'research',
      legacyShadowSettingAlias: 'paper',
      legacyConfirmSettingAlias: 'live',
      historicalRowsRewritten: false,
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
