import assert from 'node:assert/strict';
import { assessSecondWaveCandidate, secondWaveDecision, tokenAgeMs } from '../../src/pipeline/secondWave.js';

const observedAtMs = Date.parse('2026-08-27T12:00:00.000Z');

function candidate(overrides = {}) {
  return {
    metrics: { marketCapUsd: 250000, liquidityUsd: 50000 },
    jupiterAsset: {
      firstPool: { createdAt: '2026-08-24T12:00:00.000Z' },
      stats5m: { numNetBuyers: 30, numTraders: 100 },
    },
    gmgn: { smart_degen_count: 3 },
    gmgnSignal: { source: 'gmgn-smart-money' },
    savedWalletExposure: { holderCount: 0 },
    contractSafety: { passed: true, auditComplete: true },
    chart: {
      currentNative: 0.5,
      rangeHighNative: 1.4,
      windows: [{
        label: 'swing_7d_1h',
        available: true,
        high: 1.4,
        low: 0.4,
        current: 0.5,
        changePercent: 200,
        priorHigh: 0.8,
        priorLow: 0.45,
        recentHigh: 0.55,
        recentLow: 0.48,
        recentVolumeVsPrior: 0.6,
        lastVolumeVsRecent: 2,
        rangeCompression: 0.5,
        higherLow: true,
        reclaimOfPriorHigh: false,
      }],
    },
    ...overrides,
  };
}

const strong = assessSecondWaveCandidate(candidate(), { observedAtMs });
assert.equal(tokenAgeMs(candidate(), observedAtMs), 3 * 24 * 60 * 60 * 1000);
assert.equal(strong.eligible, true);
assert.equal(strong.score, 12);
assert.equal(strong.entryMode, 'BASE_DIP');
assert.equal(secondWaveDecision(candidate(), strong).verdict, 'BUY');

const young = assessSecondWaveCandidate(candidate({
  jupiterAsset: { firstPool: { createdAt: '2026-08-27T00:00:00.000Z' }, stats5m: { numNetBuyers: 30, numTraders: 100 } },
}), { observedAtMs });
assert.equal(young.eligible, false);
assert.ok(young.hardFailures.includes('token_age_below_24h_or_unknown'));
assert.equal(secondWaveDecision(candidate(), young).verdict, 'REJECT');

const distribution = assessSecondWaveCandidate(candidate({
  jupiterAsset: {
    firstPool: { createdAt: '2026-08-24T12:00:00.000Z' },
    stats5m: { numNetBuyers: -30, numTraders: 100 },
  },
}), { observedAtMs });
assert.equal(distribution.flow.state, 'DISTRIBUTION');
assert.equal(distribution.flow.score, 0);
assert.equal(distribution.eligible, false);
assert.equal(secondWaveDecision(candidate(), distribution).verdict, 'REJECT');

console.log('[second-wave] deterministic score, age gate, and distribution gate passed');
