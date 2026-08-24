import assert from 'node:assert/strict';
import {
  plannedRiskReward,
  initialRiskSol,
  rMultiple,
  percentRMultiple,
  nextExcursionState,
  captureEfficiency,
} from '../../src/research/rr.js';

assert.equal(plannedRiskReward(60, -15), 4);
assert.equal(plannedRiskReward(30, -15), 2);
assert.equal(plannedRiskReward(0, -15), 0);

const risk = initialRiskSol({
  notionalSol: 0.05,
  stopPercent: -15,
  entryFeeSol: 0.000005,
  expectedExitFeeSol: 0.000005,
});
assert.ok(risk > 0.0075);
assert.ok(risk < 0.0076);
assert.equal(percentRMultiple(45, -15), 3);
assert.ok(rMultiple(0.015, risk) > 1.9);

let state = nextExcursionState({
  pnlPercent: -9,
  pnlSol: -0.0045,
  riskSol: risk,
  ageMs: 30_000,
});
assert.equal(state.mfePercent, 0);
assert.equal(state.maePercent, -9);
assert.ok(state.maeR < 0);
assert.equal(state.timeToMaeMs, 30_000);

state = nextExcursionState({
  pnlPercent: 45,
  pnlSol: 0.0225,
  riskSol: risk,
  previousMfePercent: state.mfePercent,
  previousMaePercent: state.maePercent,
  previousMfeR: state.mfeR,
  previousMaeR: state.maeR,
  previousTimeToMfeMs: state.timeToMfeMs,
  previousTimeToMaeMs: state.timeToMaeMs,
  ageMs: 120_000,
});
assert.equal(state.mfePercent, 45);
assert.equal(state.maePercent, -9);
assert.ok(state.mfeR > 2.9);
assert.equal(state.timeToMfeMs, 120_000);
assert.equal(state.timeToMaeMs, 30_000);
assert.equal(captureEfficiency(3, 6), 0.5);

console.log('[research-rr] R and excursion invariants passed');
