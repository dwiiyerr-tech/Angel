import assert from 'node:assert/strict';
import { qualityScoreCandidate } from '../../src/edge/qualityScore.js';
import {
  runnerLabelFromPosition,
  estimateRunnerProbabilityFromRecords,
  runnerFeatureSnapshot,
} from '../../src/edge/runnerModel.js';
import { estimateRouteEdgeFromRecords, marketRegimeKey } from '../../src/edge/routeEdgeModel.js';
import { combineEdgeAssessment, assessCandidateEdge } from '../../src/edge/edgeAssessment.js';

const strongCandidate = {
  signals: { route: 'pumpportal_graduated' },
  metrics: { liquidityUsd: 22000, holderCount: 800 },
  filters: { preScore: 78, momentumScore: 0.82 },
  trending: { organic_score: 75, bundler_rate: 0.08 },
  jupiterAsset: {
    stats1h: { priceChange: 18 },
    stats5m: { numNetBuyers: 42, numTraders: 100 },
    audit: { botHoldersPercentage: 8, topHoldersPercentage: 18, devBalancePercentage: 3 },
  },
};
const weakCandidate = {
  signals: { route: 'trending' },
  metrics: { liquidityUsd: 2500, holderCount: 35 },
  filters: { preScore: 25, momentumScore: 0.2 },
  trending: { organic_score: 10, bundler_rate: 0.65 },
  jupiterAsset: {
    stats1h: { priceChange: -20 },
    stats5m: { numNetBuyers: -20, numTraders: 100 },
    audit: { botHoldersPercentage: 60, topHoldersPercentage: 50, devBalancePercentage: 20 },
  },
};

const strongQuality = qualityScoreCandidate(strongCandidate);
const weakQuality = qualityScoreCandidate(weakCandidate);
assert.ok(strongQuality.score > weakQuality.score, 'market quality must rank stronger evidence higher');
assert.equal(strongQuality.dataQuality, 'HIGH');
assert.equal(qualityScoreCandidate({}).dataQuality, 'LOW', 'missing quality data must stay missing, not become zeros');

// Integration invariant: whatever Research history happens to exist in the shared
// test DB, the live assessment path must always return a finite opportunity state
// and must degrade unavailable probability models instead of throwing/vetoing.
const integrationAssessment = assessCandidateEdge(structuredClone(strongCandidate));
assert.equal(integrationAssessment.quality.dataQuality, 'HIGH');
assert.ok(Number.isFinite(integrationAssessment.combined.opportunityProbability));
assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(integrationAssessment.combined.evidenceQuality));
if (!integrationAssessment.runner.decisionEligible) assert.equal(integrationAssessment.runner.quality, 'LOW');
if (!integrationAssessment.route.decisionEligible) assert.equal(integrationAssessment.route.quality, 'LOW');

assert.deepEqual(
  runnerLabelFromPosition({ mfe_r: 4.2, mae_r: -0.4, time_to_mfe_ms: 600000 }),
  { label: 'runner', isRunner: true },
);
assert.deepEqual(
  runnerLabelFromPosition({ mfe_r: 4.2, mae_r: -1.6, time_to_mfe_ms: 600000 }),
  { label: 'messy_runner', isRunner: false },
);
assert.deepEqual(
  runnerLabelFromPosition({ mfe_r: 1.2, mae_r: -0.2, time_to_mfe_ms: 600000 }),
  { label: 'non_runner', isRunner: false },
);
assert.deepEqual(
  runnerLabelFromPosition({ mfe_r: 4.2, mae_r: -0.4, time_to_mfe_ms: null }),
  { label: 'unknown', isRunner: null },
  'missing time-to-MFE must never be silently promoted to runner',
);

const strongFeatures = runnerFeatureSnapshot(strongCandidate, strongQuality);
const runnerRecords = [];
for (let i = 0; i < 30; i += 1) {
  runnerRecords.push({
    isRunner: i < 23,
    features: {
      route: 'pumpportal_graduated', momentum: 'high', quality: 'high',
      liquidity: 'deep', holders: 'broad', flow: 'strong',
    },
  });
}
for (let i = 0; i < 30; i += 1) {
  runnerRecords.push({
    isRunner: i < 6,
    features: {
      route: 'trending', momentum: 'low', quality: 'low',
      liquidity: 'thin', holders: 'early', flow: 'weak',
    },
  });
}
const runnerEstimate = estimateRunnerProbabilityFromRecords(runnerRecords, strongFeatures, { minSample: 20, priorStrength: 12 });
assert.equal(runnerEstimate.decisionEligible, true);
assert.ok(runnerEstimate.probability > 0.55, 'runner-like evidence should produce elevated P(runner)');

const routeRecords = [];
for (let i = 0; i < 40; i += 1) {
  routeRecords.push({ route: 'pumpportal_graduated', regime: 'hot', realizedR: i < 27 ? 1.2 : -1 });
}
for (let i = 0; i < 40; i += 1) {
  routeRecords.push({ route: 'trending', regime: 'weak', realizedR: i < 8 ? 1 : -1 });
}
const routeEdge = estimateRouteEdgeFromRecords(routeRecords, {
  route: 'pumpportal_graduated', regime: 'hot', minRouteSample: 20, minRegimeSample: 10, priorStrength: 20,
});
assert.equal(routeEdge.decisionEligible, true);
assert.equal(routeEdge.sourceLevel, 'route_regime');
assert.ok(routeEdge.pWin > 0.5);
assert.ok(routeEdge.expectedR > 0);
assert.equal(marketRegimeKey(strongCandidate), 'hot');
assert.equal(marketRegimeKey(weakCandidate), 'weak');

const combined = combineEdgeAssessment({
  quality: strongQuality,
  runner: runnerEstimate,
  route: routeEdge,
  momentumScore: 0.82,
});
assert.equal(combined.decisionEligible, true);
assert.ok(combined.opportunityProbability > 0.6);
assert.ok(combined.expectedR > 0);

const insufficient = combineEdgeAssessment({
  quality: strongQuality,
  runner: { probability: 0.9, decisionEligible: false, quality: 'LOW' },
  route: { pWin: 0.9, expectedR: 2, decisionEligible: false, quality: 'LOW' },
  momentumScore: 0.5,
});
assert.equal(insufficient.decisionEligible, false, 'insufficient history must remain advisory/neutral');

console.log('[edge-probability-models] quality -> runner probability -> route edge verified');
