import assert from 'node:assert/strict';
import {
  calibrateNeedleWeightsFromRecords,
  evaluateNeedleWeightComparison,
} from '../../src/edge/needleCalibration.js';
import {
  BASE_NEEDLE_WEIGHTS,
  validateNeedleWeights,
} from '../../src/edge/needleWeights.js';

function dimension(score) {
  return { score, known: true, coverage: 100 };
}

function record(index) {
  const cycle = index % 10;
  const predictor = 10 + cycle * 10;
  const anti = 110 - predictor;
  const mfeR = predictor >= 90 ? 12 : predictor >= 70 ? 6 : predictor >= 60 ? 3.5 : 1;
  return {
    id: index + 1,
    closedAtMs: 1_000_000 + index * 60_000,
    mfeR,
    maeR: -0.4,
    realizedR: mfeR >= 3 ? Math.min(4, mfeR / 2) : -0.6,
    dimensions: {
      safety: dimension(90),
      devQuality: dimension(anti),
      holderDistribution: dimension(50),
      organicFlow: dimension(anti),
      liquidityStructure: dimension(50),
      narrative: dimension(50),
      earlyAsymmetry: dimension(anti),
      runnerProbability: dimension(predictor),
      expectedR: dimension(predictor),
    },
  };
}

const records = Array.from({ length: 120 }, (_, index) => record(index));
const calibrated = calibrateNeedleWeightsFromRecords(records, BASE_NEEDLE_WEIGHTS, {
  minSample: 60,
  minValidation: 20,
  trainFraction: 0.70,
  priorStrength: 20,
  maxBlend: 0.60,
  minUtilityLift: 0.001,
});

assert.equal(calibrated.enoughSample, true);
assert.equal(calibrated.suggestionReady, true);
assert.equal(calibrated.challengerWeights.safety, 20, 'Safety weight must never self-calibrate downward');
assert.equal(Number(Object.values(calibrated.challengerWeights).reduce((sum, value) => sum + value, 0).toFixed(4)), 100);
assert(calibrated.challengerWeights.runnerProbability > BASE_NEEDLE_WEIGHTS.runnerProbability,
  'predictive runner probability should gain weight');
assert(calibrated.challengerWeights.expectedR > BASE_NEEDLE_WEIGHTS.expectedR,
  'predictive expected-R evidence should gain weight');
assert(calibrated.challengerWeights.organicFlow < BASE_NEEDLE_WEIGHTS.organicFlow,
  'anti-predictive flow evidence should lose weight');
assert(calibrated.challengerWeights.earlyAsymmetry < BASE_NEEDLE_WEIGHTS.earlyAsymmetry,
  'anti-predictive asymmetry evidence should lose weight');
assert(calibrated.validation.challenger.meanUtility >= calibrated.validation.active.meanUtility,
  'out-of-sample challenger must not rank worse on runner utility');

const comparison = evaluateNeedleWeightComparison(
  records.slice(-40),
  BASE_NEEDLE_WEIGHTS,
  calibrated.challengerWeights,
  {
    minSample: 30,
    minAgeMs: 1,
    startedAtMs: 1,
    nowMs: 10_000,
    minUtilityLift: 0,
  },
);
assert.equal(comparison.enoughSample, true);
assert.equal(comparison.oldEnough, true);
assert(comparison.challenger.weightedRunnerIndex >= comparison.active.weightedRunnerIndex);

const sparse = calibrateNeedleWeightsFromRecords(records.slice(0, 15), BASE_NEEDLE_WEIGHTS, {
  minSample: 60,
  minValidation: 10,
});
assert.equal(sparse.enoughSample, false);
assert.deepEqual(sparse.challengerWeights, BASE_NEEDLE_WEIGHTS, 'small samples must shrink fully to prior weights');

assert.throws(() => validateNeedleWeights({ ...BASE_NEEDLE_WEIGHTS, safety: 19, devQuality: 11 }), /Safety|sum|within/);
assert.throws(() => validateNeedleWeights({ ...BASE_NEEDLE_WEIGHTS, narrative: 99 }), /narrative/);

console.log(`[needle-calibration] sample=${calibrated.usableSample} runnerWeight=${calibrated.challengerWeights.runnerProbability.toFixed(2)} expectedRWeight=${calibrated.challengerWeights.expectedR.toFixed(2)} utilityLift=${Number(calibrated.validation.utilityLift || 0).toFixed(4)}`);
