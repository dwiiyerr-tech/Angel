import assert from 'node:assert/strict';
import { LIVE_SETTING_KEYS } from '../../src/db/liveConfig.js';
import { validateProposalChanges } from '../../src/controlPlane/registry.js';
import { evaluateEntryPolicy } from '../../src/controlPlane/challenger.js';
import { BASE_NEEDLE_WEIGHTS } from '../../src/edge/needleWeights.js';

const challengerWeights = {
  ...BASE_NEEDLE_WEIGHTS,
  organicFlow: 11,
  runnerProbability: 12,
  expectedR: 7,
};

const validated = validateProposalChanges([{
  key: 'needle_weights_json',
  value: JSON.stringify(challengerWeights),
  rationale: 'test empirical runner weighting',
}]);
assert.equal(validated.length, 1);
assert.equal(validated[0].key, 'needle_weights_json');
assert.deepEqual(JSON.parse(validated[0].value), challengerWeights);
assert.equal(LIVE_SETTING_KEYS.has('needle_weights_json'), true, 'promoted Needle weights must invalidate stale LIVE approvals');

assert.throws(() => validateProposalChanges([{
  key: 'needle_weights_json',
  value: JSON.stringify({ ...BASE_NEEDLE_WEIGHTS, safety: 19, devQuality: 11 }),
}]), /Safety|sum|within/);

const dimension = score => ({ score, known: true, coverage: 100 });
const candidate = {
  token: { mint: 'NeedleControlPlane11111111111111111111111111' },
  signals: { route: 'pumpportal_graduated' },
  metrics: { liquidityUsd: 20_000 },
  filters: { sourceWeight: 1 },
  needle: {
    dimensions: {
      safety: dimension(90),
      devQuality: dimension(50),
      holderDistribution: dimension(50),
      organicFlow: dimension(0),
      liquidityStructure: dimension(50),
      narrative: dimension(50),
      earlyAsymmetry: dimension(50),
      runnerProbability: dimension(100),
      expectedR: dimension(100),
    },
  },
};
const decision = { verdict: 'BUY', confidence: 80 };
const commonSettings = {
  blocked_routes: '[]',
  llm_min_confidence: '40',
  min_opportunity_size_multiplier: '0.25',
  min_liquidity_usd: '5000',
  flow_hard_price_change_pct: '-20',
  flow_hard_net_buyer_ratio: '-0.5',
};
const active = evaluateEntryPolicy(candidate, decision, { settings: commonSettings });
const challenger = evaluateEntryPolicy(candidate, decision, {
  settings: { ...commonSettings, needle_weights_json: JSON.stringify(challengerWeights) },
});
assert.equal(active.eligible, true);
assert.equal(challenger.eligible, true);
assert(Number.isFinite(active.evidence.needleScore));
assert(Number.isFinite(challenger.evidence.needleScore));
assert(challenger.evidence.needleScore > active.evidence.needleScore,
  'challenger control-plane config must produce a shadow Needle score without mutating active eligibility');

console.log(`[needle-control-plane] active=${active.evidence.needleScore.toFixed(2)} challenger=${challenger.evidence.needleScore.toFixed(2)} protected-live-setting=yes`);
