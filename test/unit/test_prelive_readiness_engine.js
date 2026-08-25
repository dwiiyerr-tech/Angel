import assert from 'node:assert/strict';
import { evaluateReadinessEvidence, positionRealizedR } from '../../src/readiness/engine.js';

const thresholds = {
  paperMinClosed: 50,
  paperMinSpanHours: 24,
  paperMinExpectancyR: 0.05,
  paperMinProfitFactor: 1.15,
  paperMinRealizedCoverage: 0.90,
  paperMinEntryExecutionCoverage: 0.80,
  paperMinExitV3Coverage: 0.80,
  paperMaxDrawdownR: 10,
  maxMedianQuoteDeteriorationPct: 5,
  maxMedianRoundtripSpreadPct: 20,
  decisionMinFinalized: 30,
  decisionMinProbeReadyRate: 0.80,
  decisionMaxMissedRunnerRate: 0.15,
  decisionMaxFalsePositiveRate: 0.40,
};

function strongEvidence(mode = 'paper') {
  return {
    currentMode: mode,
    paper: {
      closedTrades: 80,
      evidenceSpanHours: 72,
      expectancyR: 0.31,
      profitFactorR: 1.8,
      realizedRCoverage: 0.98,
      maxDrawdownR: 4.2,
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

// PAPER uses native realized-R evidence. Missing native R remains missing even
// if a generic PnL/risk ratio could be reconstructed.
const paperMissingR = positionRealizedR({
  pnl_sol: 0.01,
  initial_risk_sol: 0.01,
  pnl_percent: 20,
  sl_percent: -20,
}, 'research');
assert.equal(paperMissingR.value, null);
assert.equal(paperMissingR.source, 'unavailable');

// Historical Shadow derivation remains available only for offline compatibility.
const legacyShadow = positionRealizedR({
  pnl_sol: 0.01,
  initial_risk_sol: 0.005,
  pnl_percent: 20,
  sl_percent: -20,
}, 'shadow_live');
assert.equal(legacyShadow.value, 2);
assert.equal(legacyShadow.source, 'derived_pnl_sol_over_risk');

const ready = evaluateReadinessEvidence(strongEvidence('paper'), thresholds);
assert.equal(ready.paperToLiveConsideration.eligible, true);
assert.equal(ready.paperToLiveConsideration.status, 'READY_FOR_LIVE_REVIEW');
assert.equal(ready.currentStage.stage, 'paper_to_live_review');
assert.equal(ready.authority.canApproveLive, false);
assert.equal(ready.authority.canEnableLive, false);
assert.equal(ready.authority.canBroadcast, false);
assert.match(ready.authority.note, /never Live authorization/i);
assert.equal('researchToShadow' in ready, false);
assert.equal('shadowToConfirm' in ready, false);
assert.equal('confirmToLiveConsideration' in ready, false);

const unsafeEvidence = strongEvidence('paper');
unsafeEvidence.safety = { clear: false, blockerCount: 2 };
const unsafe = evaluateReadinessEvidence(unsafeEvidence, thresholds);
assert.equal(unsafe.paperToLiveConsideration.eligible, false);
assert.ok(unsafe.paperToLiveConsideration.hardBlockers.some(row => row.id === 'live_safety_clear'));

const movingConfig = strongEvidence('paper');
movingConfig.controlPlane = { stableForPreLive: false, active: { version: 1 }, openProposal: { id: 7, status: 'testing' } };
const unstable = evaluateReadinessEvidence(movingConfig, thresholds);
assert.equal(unstable.paperToLiveConsideration.eligible, false);
assert.ok(unstable.paperToLiveConsideration.hardBlockers.some(row => row.id === 'control_plane_stable'));

const weakPaper = strongEvidence('paper');
weakPaper.paper.closedTrades = 12;
weakPaper.paper.expectancyR = -0.15;
weakPaper.execution.exitV3Coverage = 0.2;
const weak = evaluateReadinessEvidence(weakPaper, thresholds);
assert.equal(weak.paperToLiveConsideration.eligible, false);
assert.ok(weak.paperToLiveConsideration.hardBlockers.some(row => row.id === 'paper_sample'));
assert.ok(weak.paperToLiveConsideration.hardBlockers.some(row => row.id === 'paper_expectancy'));
assert.ok(weak.paperToLiveConsideration.hardBlockers.some(row => row.id === 'exit_v3_coverage'));

// Being already in LIVE does not turn readiness into authority. The report is
// evidence-only in either public mode.
const liveView = evaluateReadinessEvidence(strongEvidence('live'), thresholds);
assert.equal(liveView.currentMode, 'live');
assert.equal(liveView.authority.canApproveLive, false);
assert.equal(liveView.authority.canBroadcast, false);

console.log('[two-mode-readiness] single PAPER->LIVE review gate and owner-only authority verified');
