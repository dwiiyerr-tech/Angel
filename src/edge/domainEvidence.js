function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function scale(value, low, high, inverse = false) {
  const number = finite(value);
  if (number == null) return null;
  const normalized = clamp((number - low) / Math.max(0.000001, high - low) * 100);
  return inverse ? 100 - normalized : normalized;
}

function logScale(value, low, high) {
  const number = finite(value);
  if (number == null || number <= 0) return null;
  return scale(Math.log(number), Math.log(Math.max(1, low)), Math.log(Math.max(low + 1, high)));
}

function domain(name, inputs, weights = []) {
  const known = inputs
    .map((item, index) => ({ ...item, weight: Number(weights[index] ?? 1) }))
    .filter(item => Number.isFinite(item.score));
  const weight = known.reduce((sum, item) => sum + item.weight, 0);
  const score = weight > 0
    ? known.reduce((sum, item) => sum + item.score * item.weight, 0) / weight
    : null;
  return {
    name,
    score: score == null ? null : Number(clamp(score).toFixed(2)),
    knownInputs: known.length,
    totalInputs: inputs.length,
    dataQuality: known.length >= Math.ceil(inputs.length * 0.75) ? 'HIGH'
      : known.length >= Math.ceil(inputs.length * 0.4) ? 'MEDIUM' : 'LOW',
    evidence: Object.fromEntries(inputs.map(item => [item.key, item.value ?? null])),
  };
}

function netBuyerRatio(candidate) {
  const net = finite(candidate?.jupiterAsset?.stats5m?.numNetBuyers);
  const traders = finite(candidate?.jupiterAsset?.stats5m?.numTraders);
  return net != null && traders > 0 ? net / traders : null;
}

function buySellRatio(candidate) {
  const buys = finite(candidate?.jupiterAsset?.stats5m?.numBuys ?? candidate?.trending?.buys);
  const sells = finite(candidate?.jupiterAsset?.stats5m?.numSells ?? candidate?.trending?.sells);
  if (buys == null || sells == null) return null;
  return buys / Math.max(1, sells);
}

export function buildDomainEvidence(candidate = {}) {
  const liquidity = finite(candidate?.metrics?.liquidityUsd ?? candidate?.jupiterAsset?.liquidity);
  const holders = finite(candidate?.metrics?.holderCount ?? candidate?.jupiterAsset?.holderCount);
  const impact = finite(candidate?.executionProfile?.priceImpactPct ?? candidate?.quote?.priceImpactPct);
  const market = domain('market', [
    { key: 'liquidityUsd', value: liquidity, score: logScale(liquidity, 2_000, 40_000) },
    { key: 'holderCount', value: holders, score: logScale(holders, 30, 1_500) },
    { key: 'priceImpactPct', value: impact, score: scale(impact, 0.2, 8, true) },
  ], [1.5, 1, 0.75]);

  const audit = candidate?.jupiterAsset?.audit || {};
  const botPct = finite(audit.botHoldersPercentage);
  const topPct = finite(audit.topHoldersPercentage);
  const devPct = finite(audit.devBalancePercentage);
  const devMigrations = finite(audit.devMigrations);
  const bundler = finite(candidate?.trending?.bundler_rate);
  const onchain = domain('onchain', [
    { key: 'botHoldersPct', value: botPct, score: scale(botPct, 10, 65, true) },
    { key: 'topHoldersPct', value: topPct, score: scale(topPct, 15, 55, true) },
    { key: 'devBalancePct', value: devPct, score: scale(devPct, 3, 25, true) },
    { key: 'devMigrations', value: devMigrations, score: scale(devMigrations, 1, 15, true) },
    { key: 'bundlerRate', value: bundler, score: scale(bundler, 0.05, 0.65, true) },
  ]);

  const buyerRatio = netBuyerRatio(candidate);
  const pressure = buySellRatio(candidate);
  const priceChange1h = finite(candidate?.jupiterAsset?.stats1h?.priceChange);
  const smartCount = finite(
    candidate?.smartMoneySignal?.smart_money_count
      ?? candidate?.smartMoneySignal?.wallet_count
      ?? (candidate?.smartMoneySignal ? 1 : null)
      ?? candidate?.metrics?.trendingSmartDegenCount
      ?? candidate?.trending?.smart_degen_count,
  );
  const savedWallets = finite(candidate?.savedWalletExposure?.holderCount);
  const flow = domain('flow', [
    { key: 'netBuyerRatio5m', value: buyerRatio, score: scale(buyerRatio, -0.25, 0.6) },
    { key: 'buySellRatio5m', value: pressure, score: scale(pressure, 0.5, 2.5) },
    { key: 'priceChange1h', value: priceChange1h, score: scale(priceChange1h, -20, 55) },
    { key: 'buyerAcceleration', value: finite(candidate?.volumeAcceleration?.buyerAcceleration), score: scale(candidate?.volumeAcceleration?.buyerAcceleration, 0.5, 2.5) },
    { key: 'smartMoneyCount', value: smartCount, score: scale(smartCount, 0, 5) },
    { key: 'savedWalletCount', value: savedWallets, score: scale(savedWallets, 0, 3) },
  ], [1.5, 1, 1, 0.75, 1.25, 1]);

  const organic = finite(candidate?.trending?.organic_score ?? candidate?.jupiterAsset?.organicScore ?? candidate?.gmgn?.organic_score);
  const followers = finite(candidate?.twitterNarrative?.metrics?.authorFollowers);
  const engagement = finite(candidate?.twitterNarrative?.virality?.engagementPerFollower);
  const narrative = domain('narrative', [
    { key: 'organicScore', value: organic, score: scale(organic, 15, 80) },
    { key: 'authorFollowers', value: followers, score: logScale(followers, 50, 20_000) },
    { key: 'engagementPerFollower', value: engagement, score: scale(engagement, 0.25, 8) },
  ], [1.5, 0.5, 1]);

  const domains = { market, onchain, flow, narrative };
  const core = [market, onchain, flow];
  const strongThreshold = 60;
  const coreStrongCount = core.filter(item => item.score != null && item.score >= strongThreshold).length;
  const independentKnownCount = core.filter(item => item.score != null).length;
  const weightedKnown = [
    [market, 0.35], [onchain, 0.30], [flow, 0.30], [narrative, 0.05],
  ].filter(([item]) => item.score != null);
  const totalWeight = weightedKnown.reduce((sum, [, weight]) => sum + weight, 0);
  const composite = totalWeight
    ? weightedKnown.reduce((sum, [item, weight]) => sum + item.score * weight, 0) / totalWeight
    : null;

  return {
    version: 'four-domain-evidence-v1',
    ...domains,
    compositeScore: composite == null ? null : Number(composite.toFixed(2)),
    coreStrongCount,
    independentKnownCount,
    confirmation: coreStrongCount >= 2 ? 'CONFIRMED' : independentKnownCount < 2 ? 'INSUFFICIENT' : 'WEAK',
    safetySeparated: true,
  };
}
