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

function logScale(value, low, high) {
  const n = finite(value);
  if (n == null || n <= 0) return null;
  const safeLow = Math.max(1, low);
  const safeHigh = Math.max(safeLow + 1, high);
  return scale(Math.log(n), Math.log(safeLow), Math.log(safeHigh));
}

function averageKnown(values, fallback = 50) {
  const known = values.filter(value => Number.isFinite(value));
  if (!known.length) return fallback;
  return known.reduce((sum, value) => sum + value, 0) / known.length;
}

export function netBuyerRatio(candidate = {}) {
  const net = finite(candidate?.jupiterAsset?.stats5m?.numNetBuyers);
  const traders = finite(candidate?.jupiterAsset?.stats5m?.numTraders);
  if (net == null || traders == null || traders <= 0) return null;
  return net / traders;
}

export function qualityScoreCandidate(candidate = {}) {
  const liquidityUsd = finite(candidate?.metrics?.liquidityUsd ?? candidate?.jupiterAsset?.liquidity);
  const holderCount = finite(candidate?.metrics?.holderCount ?? candidate?.jupiterAsset?.holderCount);
  const organicScore = finite(candidate?.trending?.organic_score ?? candidate?.jupiterAsset?.organicScore);
  const priceChange1h = finite(candidate?.jupiterAsset?.stats1h?.priceChange);
  const buyerRatio = netBuyerRatio(candidate);
  const botPct = finite(candidate?.jupiterAsset?.audit?.botHoldersPercentage);
  const topPct = finite(candidate?.jupiterAsset?.audit?.topHoldersPercentage);
  const devPct = finite(candidate?.jupiterAsset?.audit?.devBalancePercentage);
  const bundlerRate = finite(candidate?.trending?.bundler_rate);

  const market = averageKnown([
    logScale(liquidityUsd, 2_000, 30_000),
    logScale(holderCount, 20, 1_200),
    organicScore == null ? null : clamp(organicScore),
  ]);

  const flow = averageKnown([
    priceChange1h == null ? null : scale(priceChange1h, -25, 60),
    buyerRatio == null ? null : scale(buyerRatio, -0.5, 0.75),
  ]);

  const audit = averageKnown([
    botPct == null ? null : 100 - scale(botPct, 10, 70),
    topPct == null ? null : 100 - scale(topPct, 15, 55),
    devPct == null ? null : 100 - scale(devPct, 5, 25),
    bundlerRate == null ? null : 100 - scale(bundlerRate, 0.1, 0.7),
  ]);

  const knownInputs = [liquidityUsd, holderCount, organicScore, priceChange1h, buyerRatio, botPct, topPct, devPct, bundlerRate]
    .filter(value => value != null).length;
  const dataQuality = knownInputs >= 7 ? 'HIGH' : knownInputs >= 4 ? 'MEDIUM' : 'LOW';

  // Quality deliberately does not decide safety or alpha. Contract Safety remains
  // a separate pass/reject authority; Momentum/Runner/Route models own edge.
  const score = clamp(market * 0.50 + flow * 0.25 + audit * 0.25);

  return {
    version: 'quality-v1',
    score: Number(score.toFixed(2)),
    dataQuality,
    components: {
      market: Number(market.toFixed(2)),
      flow: Number(flow.toFixed(2)),
      audit: Number(audit.toFixed(2)),
    },
    features: {
      liquidityUsd,
      holderCount,
      organicScore,
      priceChange1h,
      netBuyerRatio5m: buyerRatio,
      botHoldersPct: botPct,
      topHoldersPct: topPct,
      devBalancePct: devPct,
      bundlerRate,
    },
  };
}
