import assert from 'node:assert/strict';
import { assessMutationObservation, LEARNING_OBSERVATION_POLICY as P } from '../../src/learning/rollbackMonitor.js';

const stats = (total, wins, pnlSum) => ({ total, wins, pnl_sum: pnlSum });

assert.equal(assessMutationObservation({
  ageMs: P.emergencyAfterMs,
  beforeStats: stats(3, 3, 30),
  afterStats: stats(3, 0, -60),
}).action, 'observe', '12h must not make a normal decision from three trades');

assert.equal(assessMutationObservation({
  ageMs: P.emergencyAfterMs,
  beforeStats: stats(10, 8, 200),
  afterStats: stats(10, 2, -100),
}).action, 'rollback', 'severe damage can trigger the 12h emergency brake');

assert.equal(assessMutationObservation({
  ageMs: P.decisionAfterMs,
  beforeStats: stats(50, 30, 250),
  afterStats: stats(49, 35, 400),
}).action, 'observe', 'seven days without 50 post-change trades remains observing');

assert.equal(assessMutationObservation({
  ageMs: P.decisionAfterMs,
  beforeStats: stats(50, 30, 250),
  afterStats: stats(50, 31, 300),
}).action, 'keep', 'adequate non-degraded evidence can pass');

assert.equal(assessMutationObservation({
  ageMs: P.decisionAfterMs,
  beforeStats: stats(50, 35, 500),
  afterStats: stats(50, 20, -100),
}).action, 'rollback', 'adequate degraded evidence rolls back');

console.log('learning observation policy tests passed');
process.exit(0);
