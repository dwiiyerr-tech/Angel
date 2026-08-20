import assert from 'node:assert/strict';
import { assessSecondWave } from '../../src/pipeline/secondWaveScreening.js';

const window = (label, current, high, low, ratio, higherLow = true) => ({
  label, available: true, current, high, low, recentHigh: high, recentLow: low,
  recentVolumeVsPrior: ratio, higherLow, candleDataQuality: 'verified',
});

const candidate = {
  metrics: { marketCapUsd: 500_000, liquidityUsd: 40_000, trendingSmartDegenCount: 3 },
  jupiterAsset: {
    firstPool: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
  },
  chart: {
    currentNative: 50,
    rangeHighNative: 100,
    windows: [window('ath_context_24h_5m', 50, 55, 45, 0.5), window('swing_7d_1h', 50, 100, 40, 1.2)],
  },
  dataQuality: { jupiterAsset: { available: true } },
};

const result = assessSecondWave(candidate);
assert.equal(result.family, 'second_wave_v2');
assert.equal(result.eligible, true);
assert.ok(result.score >= 8);
assert.equal(assessSecondWave({ ...candidate, metrics: { ...candidate.metrics, liquidityUsd: 10_000 } }).eligible, false);
console.log('[test_second_wave_screening] hard gates and score verified');
