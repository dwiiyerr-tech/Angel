import assert from 'node:assert/strict';
import { qualityScoreCandidate } from '../../src/edge/qualityScore.js';
import { runnerFeatureSnapshot } from '../../src/edge/runnerModel.js';
import { marketRegimeKey } from '../../src/edge/routeEdgeModel.js';

const candidate = {
  signals: { route: 'pumpportal_graduated' },
  metrics: { liquidityUsd: 12000, holderCount: 300 },
  filters: { momentumScore: -1, preScore: 60 },
  trending: { bundler_rate: 0.1 },
  jupiterAsset: {
    stats1h: { priceChange: 12 },
    stats5m: { numNetBuyers: 25, numTraders: 100 },
    audit: { botHoldersPercentage: 10, topHoldersPercentage: 20, devBalancePercentage: 5 },
  },
};

const quality = qualityScoreCandidate(candidate);
const features = runnerFeatureSnapshot(candidate, quality);
assert.equal(features.momentum, null);
assert.equal(features.buckets.momentum, 'unknown');
assert.equal(marketRegimeKey(candidate), 'neutral', 'ML-unavailable sentinel must not become weak/bearish regime evidence');

console.log('[edge-unknown-momentum] unavailable ML evidence stays neutral');
