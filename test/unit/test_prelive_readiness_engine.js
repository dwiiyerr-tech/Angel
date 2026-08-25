import assert from 'node:assert/strict';
import { evaluateReadinessEvidence, positionRealizedR } from '../../src/readiness/engine.js';

const thresholds = {
  researchMinClosed: 50,
  researchMinSpanHours: 24,
  researchMinExpectancyR: 0.05,
  researchMinProfitFactor: 1.15,
  researchMinRealizedCoverage: 0.90,
  researchMinEntryExecutionCoverage: 0.80,
  researchMinExitV3Coverage: 0.80,
  researchMaxDrawdownR: 10,
  maxMedianQuoteDeteriorationPct: 5,
  maxMedianRoundtripSpreadPct: 20,
  decisionMinFinalized: 30,
  decisionMinProbeReadyRate: 0.80,
  decisionMaxMissedRunnerRate: 0.15,
  decisionMaxFalsePositiveRate: 0.40,
  shadowMinClosed: 30,
  shadowMinSpanHours: 24,
  shadowMinExpectancyR: 0,
  shadowMinProfitFactor: 1.10,
  shadowMinRealizedCoverage: 0.95,
  shadowMaxDrawdownR: 10,
};

function strongEvidence(mode = 'research') {
  return {
    currentMode: mode,
    research: {
      closedTrades: 80,
      evidenceSpanHours: 72,
      expectancyR: 0.31,
      profitFactorR: 1.8,
      realizedRCoverage: 0.98,
      maxDrawdownR: 4.2,
    },
    shadow: {
      closedTrades: 40,
      evidenceSpanHours: 48,
      expectancyR: 0.14,
      profitFactorR: 1.35,
      realizedRCoverage: 1,
      maxDrawdownR: 3.4,
      rEvidenceMethod: 'stored realized_r, else pnl_sol/risk, else pnl_percent/abs(SL)',
    },
    execution: {
      entryExecutionCoverage: 0.94,
      exitV3Coverage: 0.91,
      pendingExitSettlements: 0,
      medianEntryQuoteDeteriorationPct: 1.2,
      medianRoundtripSpreadPct: 7.5,
    },
    decisions: {
      finalizedOutcomes: 55,
      probeReadyRate: 0.92,
      missedRunnerRate: 0.08,
      falsePositiveRate: 0.23,
    },
    safety: {
      clear: true,
      blockerCount: 0,
    },
    controlPlane: {
      stableForPreLive: true,
      active: { version: 1 },
      openProposal: null,
    },
  };
}

// Research has native realized-R accounting. Missing native R must remain
// missing evidence even if a generic PnL/risk ratio could be reconstructed.
const researchMissingR = positionRealizedR({
  pnl_sol: 0.01,
  initial_risk_sol: 0.01,
  pnl_percent: 20,
  sl_percent: -20,
}, 'research');
assert.equal(researchMissingR.value, null);
assert.equal(researchMissingR.source, 'unavailable');

// Legacy Shadow rows may transparently derive R without rewriting history.
const shadowFromRisk = positionRealizedR({
  pnl_sol: 0.01,
  initial_risk_sol: 0.005,
  pnl_percent: 20,
  sl_percent: -20,
}, 'shadow_live');
assert.equal(shadowFromRisk.value, 2);
assert.equal(shadowFromRisk.source, 'derived_pnl_sol_over_risk');
const shadowFromPercent = positionRealizedR({
  pnl_sol: null,
  initial_risk_sol: null,
  size_sol: null,
  pnl_percent: 30,
  sl_percent: -15,
}, 'shadow_live');
assert.equal(shadowFromPercent.value, 2);
assert.equal(shadowFromPercent.source, 'derived_pnl_percent_over_sl');

const research = evaluateReadinessEvidence(strongEvidence('research'), thresholds);
assert.equal(research.researchToShadow.eligible, true);
assert.equal(research.researchToShadow.status, 'READY_FOR_SHADOW');
assert.equal(research.currentStage.stage, 'research_to_shadow');
assert.equal(research.authority.canApproveLive, false);
assert.equal(research.authority.canEnableLive, false);
assert.equal(research.authority.canBroadcast, false);

const shadow = evaluateReadinessEvidence(strongEvidence('shadow_live'), thresholds);
assert.equal(shadow.shadowToConfirm.eligible, true);
assert.equal(shadow.shadowToConfirm.status, 'READY_FOR_CONFIRM');
assert.equal(shadow.currentStage.stage, 'shadow_to_confirm');

const confirm = evaluateReadinessEvidence(strongEvidence('confirm'), thresholds);
assert.equal(confirm.confirmToLiveConsideration.eligible, true);
assert.equal(confirm.confirmToLiveConsideration.status, 'ELIGIBLE_FOR_LIVE_CONSIDERATION');
assert.equal(confirm.currentStage.stage, 'confirm_to_live_consideration');
assert.match(confirm.authority.note, /never authorization/i);
assert.ok(confirm.confirmToLiveConsideration.warnings.some(row => row.id === 'confirm_attribution'));

const notConfirm = evaluateReadinessEvidence(strongEvidence('shadow_live'), thresholds);
assert.equal(notConfirm.confirmToLiveConsideration.eligible, false);
assert.ok(notConfirm.confirmToLiveConsideration.hardBlockers.some(row => row.id === 'confirm_mode'));

const unsafeEvidence = strongEvidence('confirm');
unsafeEvidence.safety = { clear: false, blockerCount: 2 };
const unsafe = evaluateReadinessEvidence(unsafeEvidence, thresholds);
assert.equal(unsafe.shadowToConfirm.eligible, false);
assert.equal(unsafe.confirmToLiveConsideration.eligible, false);
assert.ok(unsafe.confirmToLiveConsideration.hardBlockers.some(row => row.id === 'live_safety_clear'));

const movingConfig = strongEvidence('confirm');
movingConfig.controlPlane = { stableForPreLive: false, active: { version: 1 }, openProposal: { id: 7, status: 'testing' } };
const unstable = evaluateReadinessEvidence(movingConfig, thresholds);
assert.equal(unstable.shadowToConfirm.eligible, false);
assert.ok(unstable.shadowToConfirm.hardBlockers.some(row => row.id === 'control_plane_stable'));
assert.equal(unstable.confirmToLiveConsideration.eligible, false);

const weakResearch = strongEvidence('research');
weakResearch.research.closedTrades = 12;
weakResearch.research.expectancyR = -0.15;
weakResearch.execution.exitV3Coverage = 0.2;
const weak = evaluateReadinessEvidence(weakResearch, thresholds);
assert.equal(weak.researchToShadow.eligible, false);
assert.ok(weak.researchToShadow.hardBlockers.some(row => row.id === 'research_sample'));
assert.ok(weak.researchToShadow.hardBlockers.some(row => row.id === 'research_expectancy'));
assert.ok(weak.researchToShadow.hardBlockers.some(row => row.id === 'exit_v3_coverage'));

console.log('[prelive-readiness] staged eligibility, R provenance, safety, config stability, and owner-only Live authority verified');
