const WEIGHTS = Object.freeze({
  safety: 20,
  devQuality: 10,
  holderDistribution: 10,
  organicFlow: 15,
  liquidityStructure: 10,
  narrative: 7,
  earlyAsymmetry: 13,
  runnerProbability: 10,
  expectedR: 5,
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function scale(value, low, high) {
  const n = finite(value);
  if (n == null) return null;
  if (high <= low) return 0;
  return clamp((n - low) / (high - low) * 100);
}

function inverseScale(value, good, bad) {
  const scaled = scale(value, good, bad);
  return scaled == null ? null : 100 - scaled;
}

function logScale(value, low, high) {
  const n = finite(value);
  if (n == null || n <= 0) return null;
  const safeLow = Math.max(1e-9, low);
  const safeHigh = Math.max(safeLow * 1.001, high);
  return scale(Math.log(n), Math.log(safeLow), Math.log(safeHigh));
}

function weightedAverage(parts, fallback = 50) {
  const known = parts.filter(part => finite(part.value) != null && Number(part.weight) > 0);
  if (!known.length) return { score: fallback, known: false, coverage: 0 };
  const weight = known.reduce((sum, part) => sum + Number(part.weight), 0);
  const score = known.reduce((sum, part) => sum + clamp(part.value) * Number(part.weight), 0) / weight;
  const total = parts.reduce((sum, part) => sum + Math.max(0, Number(part.weight) || 0), 0);
  return { score: clamp(score), known: true, coverage: total > 0 ? weight / total : 0 };
}

function boolScore(value, { unknown = 50 } = {}) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 100;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return unknown;
}

function migrationQuality(value) {
  const n = finite(value);
  if (n == null) return null;
  if (n <= 1) return 70;
  if (n <= 5) return 100;
  if (n <= 15) return 90;
  if (n <= 30) return 65;
  if (n <= 60) return 35;
  if (n < 100) return 10;
  return 0;
}

function mcapAsymmetryScore(value) {
  const n = finite(value);
  if (n == null || n <= 0) return null;
  if (n < 5_000) return 45;
  if (n < 20_000) return 100;
  if (n < 75_000) return 92;
  if (n < 200_000) return 72;
  if (n < 500_000) return 42;
  if (n < 1_000_000) return 22;
  return 8;
}

function earlyHolderScore(value) {
  const n = finite(value);
  if (n == null) return null;
  if (n < 20) return 65;
  if (n <= 120) return 100;
  if (n <= 350) return 85;
  if (n <= 1_000) return 55;
  return 25;
}

function athRoomScore(value) {
  const n = finite(value);
  if (n == null) return null;
  const distance = Math.max(0, n);
  if (distance < 10) return 35;
  if (distance < 35) return 72;
  if (distance <= 80) return 100;
  return 70;
}

function classification(score, hardReject = false) {
  if (hardReject || score < 40) return 'HARD_REJECT';
  if (score < 55) return 'WEAK';
  if (score < 65) return 'OBSERVE';
  if (score < 75) return 'WATCH';
  if (score < 85) return 'ENTRY_CANDIDATE';
  if (score < 93) return 'HIGH_CONVICTION';
  return 'EXCEPTIONAL_NEEDLE';
}

export function scoreSafety(candidate = {}) {
  const audit = candidate?.jupiterAsset?.audit || {};
  const safety = candidate?.contractSafety || null;
  const rugScore = finite(safety?.rugcheck?.scoreNormalised);
  const mcap = finite(candidate?.metrics?.marketCapUsd);
  const lpBurned = audit?.lpBurned ?? candidate?.lpBurned;
  const result = weightedAverage([
    { value: boolScore(audit?.mintAuthorityDisabled), weight: 10 },
    { value: boolScore(audit?.freezeAuthorityDisabled), weight: 10 },
    { value: inverseScale(audit?.topHoldersPercentage, 12, 50), weight: 15 },
    { value: inverseScale(audit?.devBalancePercentage, 2, 20), weight: 10 },
    { value: inverseScale(audit?.botHoldersPercentage, 10, 70), weight: 10 },
    { value: inverseScale(audit?.sniperPct, 10, 70), weight: 10 },
    { value: rugScore == null ? null : inverseScale(rugScore, 0, 500), weight: 15 },
    { value: safety ? (safety.auditComplete ? 100 : 55) : null, weight: 10 },
    { value: mcap != null && mcap < 50_000 ? boolScore(lpBurned, { unknown: 55 }) : 80, weight: 10 },
  ]);
  if (safety?.passed === false) return { ...result, score: 0, hardReject: true };
  return { ...result, hardReject: false };
}

export function scoreDevQuality(candidate = {}) {
  const audit = candidate?.jupiterAsset?.audit || {};
  return weightedAverage([
    { value: inverseScale(audit?.devBalancePercentage, 1, 20), weight: 55 },
    { value: migrationQuality(audit?.devMigrations), weight: 45 },
  ]);
}

export function scoreHolderDistribution(candidate = {}) {
  const audit = candidate?.jupiterAsset?.audit || {};
  return weightedAverage([
    { value: inverseScale(audit?.topHoldersPercentage, 10, 50), weight: 45 },
    { value: inverseScale(candidate?.holders?.maxHolderPercent, 2, 20), weight: 35 },
    { value: inverseScale(candidate?.holders?.top20Percent, 18, 70), weight: 20 },
  ]);
}

export function scoreOrganicFlow(candidate = {}) {
  const organic = finite(candidate?.trending?.organic_score ?? candidate?.jupiterAsset?.organicScore);
  const netBuyers = finite(candidate?.jupiterAsset?.stats5m?.numNetBuyers);
  const traders = finite(candidate?.jupiterAsset?.stats5m?.numTraders);
  const buyerRatio = netBuyers != null && traders != null && traders > 0 ? netBuyers / traders : null;
  const smartDegens = finite(candidate?.metrics?.trendingSmartDegenCount
    ?? candidate?.trending?.smart_degen_count
    ?? candidate?.gmgn?.smart_degen_count);
  const acceleration = candidate?.volumeAcceleration;
  let accelerationScore = null;
  if (acceleration?.valid) {
    const buyerAcceleration = finite(acceleration?.buyerAcceleration);
    const sellerAcceleration = finite(acceleration?.sellerAcceleration);
    if (buyerAcceleration != null && sellerAcceleration != null) {
      accelerationScore = scale(buyerAcceleration - sellerAcceleration, -1, 2);
    } else {
      accelerationScore = acceleration?.accelerating ? 80 : 45;
    }
  }
  return weightedAverage([
    { value: organic == null ? null : clamp(organic), weight: 30 },
    { value: buyerRatio == null ? null : scale(buyerRatio, -0.2, 0.6), weight: 30 },
    { value: smartDegens == null ? null : scale(smartDegens, 0, 10), weight: 25 },
    { value: accelerationScore, weight: 15 },
  ]);
}

export function scoreLiquidityStructure(candidate = {}) {
  const liquidity = finite(candidate?.metrics?.liquidityUsd ?? candidate?.jupiterAsset?.liquidity);
  const mcap = finite(candidate?.metrics?.marketCapUsd ?? candidate?.jupiterAsset?.mcap);
  const ratio = liquidity != null && mcap != null && mcap > 0 ? liquidity / mcap : null;
  const lpBurned = candidate?.jupiterAsset?.audit?.lpBurned ?? candidate?.lpBurned;
  return weightedAverage([
    { value: liquidity == null ? null : logScale(liquidity, 2_000, 30_000), weight: 45 },
    { value: ratio == null ? null : scale(ratio, 0.03, 0.25), weight: 40 },
    { value: boolScore(lpBurned, { unknown: 60 }), weight: 15 },
  ]);
}

export function scoreNarrative(candidate = {}) {
  const narrative = candidate?.twitterNarrative;
  const token = candidate?.token || {};
  const hasText = Boolean(narrative?.text);
  const hasProfile = Boolean(narrative?.profileOnly || narrative?.url || token?.twitter);
  const hasOtherSocial = Boolean(token?.website || token?.telegram);
  const presence = hasText ? 100 : hasProfile ? 55 : hasOtherSocial ? 35 : 0;
  const engagementPerView = finite(narrative?.virality?.engagementPerView);
  const engagementPerFollower = finite(narrative?.virality?.engagementPerFollower);
  const followers = finite(narrative?.metrics?.authorFollowers);
  const verified = narrative?.metrics?.authorVerified === true;
  const trust = followers == null
    ? (verified ? 75 : null)
    : clamp((logScale(followers, 100, 100_000) ?? 0) * 0.8 + (verified ? 20 : 0));
  return weightedAverage([
    { value: presence, weight: 30 },
    { value: engagementPerView == null ? null : scale(engagementPerView, 0.05, 3), weight: 35 },
    { value: engagementPerFollower == null ? null : scale(engagementPerFollower, 0.02, 2), weight: 20 },
    { value: trust, weight: 15 },
  ], presence * 0.5);
}

export function scoreEarlyAsymmetry(candidate = {}) {
  const mcap = finite(candidate?.metrics?.marketCapUsd ?? candidate?.jupiterAsset?.mcap);
  const holders = finite(candidate?.metrics?.holderCount ?? candidate?.jupiterAsset?.holderCount);
  const route = String(candidate?.signals?.route || '');
  const freshRoute = ['pumpfun_pregrad', 'pumpportal_graduated', 'trenches_completed'].some(value => route.includes(value));
  const distanceFromAth = finite(candidate?.chart?.distanceFromAthPercent
    ?? candidate?.chart?.belowRangeHighPercent);
  const topBlastRisk = candidate?.chart?.topBlastRisk;
  return weightedAverage([
    { value: mcapAsymmetryScore(mcap), weight: 45 },
    { value: earlyHolderScore(holders), weight: 20 },
    { value: freshRoute ? 100 : 55, weight: 10 },
    { value: athRoomScore(distanceFromAth), weight: 15 },
    { value: topBlastRisk === true ? 10 : topBlastRisk === false ? 100 : 60, weight: 10 },
  ]);
}

export function scoreRunnerProbability(candidate = {}) {
  const runner = candidate?.edge?.runner;
  const probability = finite(runner?.probability);
  if (!runner?.decisionEligible || probability == null) return { score: 45, known: false, coverage: 0 };
  return { score: clamp(probability * 100), known: true, coverage: 1 };
}

export function scoreExpectedR(candidate = {}) {
  const route = candidate?.edge?.route;
  const expectedR = finite(route?.expectedR);
  if (!route?.decisionEligible || expectedR == null) return { score: 45, known: false, coverage: 0 };
  return { score: clamp((expectedR + 1) / 3 * 100), known: true, coverage: 1 };
}

export function calculateNeedleScore(candidate = {}) {
  const dimensions = {
    safety: scoreSafety(candidate),
    devQuality: scoreDevQuality(candidate),
    holderDistribution: scoreHolderDistribution(candidate),
    organicFlow: scoreOrganicFlow(candidate),
    liquidityStructure: scoreLiquidityStructure(candidate),
    narrative: scoreNarrative(candidate),
    earlyAsymmetry: scoreEarlyAsymmetry(candidate),
    runnerProbability: scoreRunnerProbability(candidate),
    expectedR: scoreExpectedR(candidate),
  };

  const hardReject = dimensions.safety.hardReject === true;
  const score = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => (
    sum + clamp(dimensions[key]?.score ?? 50) * weight / 100
  ), 0);
  const evidenceCoverage = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => (
    sum + (dimensions[key]?.known ? weight : weight * clamp(dimensions[key]?.coverage ?? 0, 0, 1))
  ), 0);
  const finalScore = hardReject ? 0 : clamp(score);

  return {
    version: 'needle-score-v1',
    score: Number(finalScore.toFixed(2)),
    classification: classification(finalScore, hardReject),
    hardReject,
    evidenceCoveragePercent: Number(clamp(evidenceCoverage).toFixed(1)),
    weights: WEIGHTS,
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([key, value]) => [key, {
      score: Number(clamp(value?.score ?? 50).toFixed(2)),
      known: Boolean(value?.known),
      coverage: Number(clamp((value?.coverage ?? 0) * 100).toFixed(1)),
    }])),
  };
}

export { WEIGHTS as NEEDLE_SCORE_WEIGHTS };
