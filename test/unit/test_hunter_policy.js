import assert from 'node:assert/strict';
import {
  confidenceSizeMultiplier,
  softRiskSizeMultiplier,
  opportunityTier,
  hunterPolicy,
} from '../../src/pipeline/hunterPolicy.js';

assert.equal(confidenceSizeMultiplier(95), 1);
assert.equal(confidenceSizeMultiplier(80), 0.85);
assert.equal(confidenceSizeMultiplier(60), 0.60);
assert.equal(confidenceSizeMultiplier(40), 0.30);
assert.equal(confidenceSizeMultiplier(20), 0);

assert.equal(softRiskSizeMultiplier(0), 1);
assert.equal(softRiskSizeMultiplier(2), 0.70);
assert.equal(softRiskSizeMultiplier(4), 0.40);
assert.equal(softRiskSizeMultiplier(6), 0.25);

assert.equal(opportunityTier({ confidence: 95, preScore: 90, momentum: 0.9 }).tier, 'A+');

const normal = hunterPolicy({ confidence: 80, preScore: 70, momentum: 0.7, totalSoftRiskSeverity: 0 });
assert.equal(normal.action, 'TRADE');
assert.equal(normal.sizeMultiplier, 0.85);

const risky = hunterPolicy({ confidence: 80, preScore: 70, momentum: 0.7, totalSoftRiskSeverity: 4 });
assert.equal(risky.action, 'TRADE');
assert.equal(risky.reason, 'yes_but_smaller');
assert.ok(risky.sizeMultiplier > 0);
assert.ok(risky.sizeMultiplier < normal.sizeMultiplier);

const catastrophic = hunterPolicy({ confidence: 99, catastrophic: true });
assert.equal(catastrophic.action, 'REJECT');
assert.equal(catastrophic.sizeMultiplier, 0);

console.log('[hunter-policy] yes-but-smaller and catastrophic reject invariants passed');
