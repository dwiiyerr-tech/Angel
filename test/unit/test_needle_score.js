import assert from 'node:assert/strict';
import { calculateNeedleScore, NEEDLE_SCORE_WEIGHTS } from '../../src/edge/needleScore.js';

const strong = {
  token: {
    mint: 'NeedleStrong111111111111111111111111111111',
    twitter: 'https://x.com/needle/status/123',
    website: 'https://needle.example',
  },
  metrics: {
    marketCapUsd: 28_000,
    liquidityUsd: 11_000,
    holderCount: 96,
    trendingSmartDegenCount: 8,
  },
  signals: { route: 'pumpportal_graduated' },
  holders: { maxHolderPercent: 5, top20Percent: 24 },
  jupiterAsset: {
    liquidity: 11_000,
    mcap: 28_000,
    organicScore: 82,
    stats5m: { numNetBuyers: 42, numTraders: 80 },
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 18,
      devBalancePercentage: 2,
      botHoldersPercentage: 12,
      sniperPct: 8,
      devMigrations: 5,
      lpBurned: true,
    },
  },
  contractSafety: {
    passed: true,
    auditComplete: true,
    rugcheck: { scoreNormalised: 80 },
  },
  twitterNarrative: {
    text: 'A coherent launch narrative with real engagement.',
    virality: { engagementPerView: 1.8, engagementPerFollower: 0.9 },
    metrics: { authorFollowers: 12_000, authorVerified: true },
  },
  volumeAcceleration: {
    valid: true,
    accelerating: true,
    buyerAcceleration: 1.5,
    sellerAcceleration: 0.2,
  },
  chart: { distanceFromAthPercent: 42, topBlastRisk: false },
  edge: {
    runner: { decisionEligible: true, probability: 0.74 },
    route: { decisionEligible: true, expectedR: 1.25 },
  },
};

const weak = {
  token: { mint: 'NeedleWeak1111111111111111111111111111111' },
  metrics: {
    marketCapUsd: 720_000,
    liquidityUsd: 2_300,
    holderCount: 1_800,
    trendingSmartDegenCount: 0,
  },
  signals: { route: 'trending' },
  holders: { maxHolderPercent: 17, top20Percent: 64 },
  trending: { organic_score: 12 },
  jupiterAsset: {
    liquidity: 2_300,
    mcap: 720_000,
    stats5m: { numNetBuyers: -20, numTraders: 100 },
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 46,
      devBalancePercentage: 17,
      botHoldersPercentage: 62,
      sniperPct: 55,
      devMigrations: 58,
      lpBurned: true,
    },
  },
  contractSafety: {
    passed: true,
    auditComplete: true,
    rugcheck: { scoreNormalised: 420 },
  },
  volumeAcceleration: {
    valid: true,
    accelerating: false,
    buyerAcceleration: -0.4,
    sellerAcceleration: 1.2,
  },
  chart: { distanceFromAthPercent: 3, topBlastRisk: true },
  edge: {
    runner: { decisionEligible: true, probability: 0.16 },
    route: { decisionEligible: true, expectedR: -0.55 },
  },
};

const strongScore = calculateNeedleScore(strong);
const weakScore = calculateNeedleScore(weak);
assert.equal(Object.values(NEEDLE_SCORE_WEIGHTS).reduce((a, b) => a + b, 0), 100, 'Needle weights must sum to 100');
assert(strongScore.score >= 75, `strong asymmetric candidate should reach ENTRY_CANDIDATE+, got ${strongScore.score}`);
assert(strongScore.score > weakScore.score + 25, `strong candidate must materially outrank weak one (${strongScore.score} vs ${weakScore.score})`);
assert(['ENTRY_CANDIDATE', 'HIGH_CONVICTION', 'EXCEPTIONAL_NEEDLE'].includes(strongScore.classification));
assert(['HARD_REJECT', 'WEAK', 'OBSERVE', 'WATCH'].includes(weakScore.classification));
assert.equal(strongScore.dimensions.runnerProbability.score, 74);
assert(strongScore.dimensions.expectedR.score > 70, 'positive expected R should be rewarded');

const unsafe = structuredClone(strong);
unsafe.contractSafety = { passed: false, auditComplete: true, rugcheck: { scoreNormalised: 20 } };
const unsafeScore = calculateNeedleScore(unsafe);
assert.equal(unsafeScore.score, 0, 'catastrophic safety failure must dominate every opportunity signal');
assert.equal(unsafeScore.classification, 'HARD_REJECT');
assert.equal(unsafeScore.hardReject, true);

const sparse = calculateNeedleScore({
  token: { mint: 'Sparse1111111111111111111111111111111111' },
  signals: { route: 'pumpfun_pregrad' },
  contractSafety: { passed: true, auditComplete: false, rugcheck: null },
  edge: {
    runner: { decisionEligible: false, probability: null },
    route: { decisionEligible: false, expectedR: null },
  },
});
assert(Number.isFinite(sparse.score), 'missing evidence must degrade gracefully rather than produce NaN');
assert(sparse.evidenceCoveragePercent < strongScore.evidenceCoveragePercent, 'sparse candidate must expose lower evidence coverage');

console.log(`[needle-score] strong=${strongScore.score} ${strongScore.classification} weak=${weakScore.score} ${weakScore.classification} sparseCoverage=${sparse.evidenceCoveragePercent}%`);
