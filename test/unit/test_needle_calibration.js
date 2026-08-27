import assert from 'node:assert/strict';
import {
  calibrateNeedleRows,
  extractNeedleCalibrationSample,
} from '../../src/edge/needleCalibration.js';
import { SOLANA_TRENCHING_WORKFLOW, SOLANA_TRENCHING_WORKFLOW_STAGES } from '../../src/pipeline/workflow.js';

function syntheticRow(i, outcomeOverride = null) {
  const signal = ((i * 37) % 101) / 100;
  const organicFlow = 15 + signal * 85;
  const earlyAsymmetry = 20 + signal * 78;
  const narrative = 95 - signal * 75;
  const mfeR = signal >= 0.92 ? 10.5 : signal >= 0.80 ? 5.5 : signal >= 0.64 ? 3.4 : signal >= 0.42 ? 1.4 : 0.4;
  const realizedR = -0.9 + signal * 4.2;
  const maeR = -1.7 + signal * 1.2;
  const outcome = outcomeOverride || { mfeR, realizedR, maeR };
  const dimensions = {
    safety: { score: 90, known: true },
    devQuality: { score: 52 + ((i * 11) % 19), known: true },
    holderDistribution: { score: 55 + ((i * 7) % 23), known: true },
    organicFlow: { score: organicFlow, known: true },
    liquidityStructure: { score: 58 + ((i * 5) % 17), known: true },
    narrative: { score: narrative, known: true },
    earlyAsymmetry: { score: earlyAsymmetry, known: true },
    runnerProbability: { score: 40 + signal * 45, known: true },
    expectedR: { score: 35 + signal * 50, known: true },
  };
  return {
    id: i + 1,
    opened_at_ms: 1_700_000_000_000 + i * 60_000,
    closed_at_ms: 1_700_000_030_000 + i * 60_000,
    execution_mode: 'research',
    realized_r: outcome.realizedR,
    mfe_r: outcome.mfeR,
    mae_r: outcome.maeR,
    snapshot_json: JSON.stringify({
      candidate: {
        needle: {
          version: 'needle-score-v1',
          dimensions,
        },
      },
    }),
  };
}

assert.equal(SOLANA_TRENCHING_WORKFLOW_STAGES.length, 13, 'canonical workflow must preserve all requested stages');
assert(SOLANA_TRENCHING_WORKFLOW.includes('Signals → Enrichment → Contract Safety → PreScore/CoS → Momentum ML'));
assert(SOLANA_TRENCHING_WORKFLOW.endsWith('Market Allocator → Fresh Execution Recheck → PAPER/LIVE'));

const rows = Array.from({ length: 120 }, (_, i) => syntheticRow(i));
const report = calibrateNeedleRows(rows);
assert.equal(report.sample, 120);
assert.equal(report.trainSample, 84);
assert.equal(report.holdoutSample, 36);
assert.equal(report.enoughSample, true);
assert.equal(report.safetyImmutable, true);
assert.equal(report.challengerWeights.safety, 20, 'Safety weight must never be learned down');
const totalWeight = Object.values(report.challengerWeights).reduce((sum, value) => sum + Number(value), 0);
assert(Math.abs(totalWeight - 100) < 0.001, `challenger weights must sum to 100, got ${totalWeight}`);
assert(report.challengerWeights.organicFlow > 15, 'predictive Organic Flow should gain weight');
assert(report.challengerWeights.earlyAsymmetry > 13, 'predictive Early Asymmetry should gain weight');
assert(report.challengerWeights.narrative < 7, 'anti-predictive Narrative should lose weight');

const originalWeights = JSON.stringify(report.challengerWeights);
const holdoutMutated = rows.map((row, i) => i < 84 ? row : syntheticRow(i, {
  realizedR: i % 2 ? 20 : -20,
  mfeR: i % 3 ? 0 : 30,
  maeR: -8,
}));
const mutatedReport = calibrateNeedleRows(holdoutMutated);
assert.equal(JSON.stringify(mutatedReport.challengerWeights), originalWeights,
  'future holdout outcomes must not leak into fitted challenger weights');

const sparse = calibrateNeedleRows(rows.slice(0, 25));
assert.equal(sparse.enoughSample, false, 'small PAPER samples must stay evidence-insufficient');
assert.equal(sparse.promotionReady, false, 'small samples must never become promotion-ready');

assert.equal(extractNeedleCalibrationSample({ realized_r: 1, snapshot_json: '{}' }), null,
  'rows without point-in-time Needle evidence must be excluded');

console.log(`[needle-calibration] train=${report.trainSample} holdout=${report.holdoutSample} organic=${report.challengerWeights.organicFlow} asymmetry=${report.challengerWeights.earlyAsymmetry} narrative=${report.challengerWeights.narrative}`);
