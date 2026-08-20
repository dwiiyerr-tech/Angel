const MIN_SCORE = 8;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function ageMs(candidate) {
  const created = candidate?.jupiterAsset?.firstPool?.createdAt
    || candidate?.jupiterAsset?.createdAt
    || candidate?.gmgn?.created_at
    || candidate?.graduation?.graduationDate;
  const parsed = typeof created === 'number' ? created : Date.parse(created || '');
  return Number.isFinite(parsed) ? Date.now() - (parsed < 10 ** 12 ? parsed * 1000 : parsed) : null;
}

function chartFeatures(candidate) {
  const chart = candidate?.chart;
  const windows = Array.isArray(chart?.windows) ? chart.windows : [];
  const ath = windows.find(row => row.label === 'swing_7d_1h') || windows.find(row => row.label === 'long_30d_4h') || windows[0];
  const base = windows.find(row => row.label === 'ath_context_24h_5m') || windows[0];
  const current = finite(chart?.currentNative ?? ath?.current);
  const priorHigh = finite(chart?.rangeHighNative ?? ath?.high);
  const drawdownPercent = current != null && priorHigh > 0 ? (1 - current / priorHigh) * 100 : null;
  const structureVerified = Boolean(base?.candleDataQuality === 'verified' && ath?.candleDataQuality === 'verified');
  const baseHealthy = structureVerified && base?.higherLow === true && Number(base?.recentVolumeVsPrior) > 0.2 && Number(base?.recentVolumeVsPrior) < 1.5;
  const reclaim = structureVerified && current >= Number(base?.recentHigh || 0) && Number(base?.recentVolumeVsPrior) >= 1;
  const volumeDryUp = structureVerified && Number(base?.recentVolumeVsPrior) < 0.8;
  return {
    current, priorHigh, drawdownPercent, structureVerified, baseHealthy, reclaim, volumeDryUp,
    recentVolumeVsPrior: finite(base?.recentVolumeVsPrior),
  };
}

export function assessSecondWave(candidate) {
  const mcap = finite(candidate?.metrics?.marketCapUsd);
  const liquidity = finite(candidate?.metrics?.liquidityUsd);
  const age = ageMs(candidate);
  const audit = candidate?.jupiterAsset?.audit;
  const stats = candidate?.jupiterAsset?.stats5m || {};
  const chart = chartFeatures(candidate);
  const buyTax = finite(audit?.buyTax ?? audit?.buy_tax ?? candidate?.jupiterAsset?.buyTax);
  const sellTax = finite(audit?.sellTax ?? audit?.sell_tax ?? candidate?.jupiterAsset?.sellTax);
  const honeypot = audit?.honeypot ?? audit?.isHoneypot ?? candidate?.jupiterAsset?.honeypot;
  const dexBuys = finite(stats.numBuys ?? stats.buys ?? candidate?.metrics?.dexBuys5m);
  const dexSells = finite(stats.numSells ?? stats.sells ?? candidate?.metrics?.dexSells5m);
  const failures = [];
  if (mcap == null || mcap < 80_000 || mcap > 3_000_000) failures.push('market cap outside 80k-3m');
  if (liquidity == null || liquidity < 25_000) failures.push('liquidity below 25k');
  if (age == null || age < 24 * 60 * 60 * 1000) failures.push('token age below 24h or unknown');
  if (!chart.structureVerified) failures.push('chart structure data unverified');
  if (chart.drawdownPercent == null || chart.drawdownPercent < 50 || chart.drawdownPercent > 85) failures.push('drawdown outside 50-85%');
  if (chart.priorHigh == null || chart.current == null || chart.priorHigh / Math.max(chart.current, Number.EPSILON) < 2) failures.push('no meaningful prior expansion');
  if (!chart.baseHealthy && !chart.reclaim) failures.push('no verified base, higher-low, or reclaim');
  if (chart.volumeDryUp == null || chart.recentVolumeVsPrior == null) failures.push('volume sequence unknown');
  else if (!chart.volumeDryUp) failures.push('volume did not dry up before base/reclaim');
  if (audit?.mintAuthorityDisabled !== true) failures.push('mint authority not verified disabled');
  if (audit?.freezeAuthorityDisabled !== true) failures.push('freeze authority not verified disabled');
  if (finite(audit?.topHoldersPercentage) == null || Number(audit.topHoldersPercentage) > 45) failures.push('top-holder concentration unsafe');
  if (buyTax == null || sellTax == null) failures.push('buy/sell tax unknown');
  else if (buyTax > 5 || sellTax > 5) failures.push('buy/sell tax above 5%');
  if (honeypot == null) failures.push('honeypot status unknown');
  else if (honeypot === true) failures.push('honeypot detected');
  if (dexBuys == null || dexSells == null) failures.push('DEX buy/sell activity unknown');
  else if (dexBuys <= 0) failures.push('no meaningful DEX buys');
  if (candidate?.dataQuality?.jupiterAsset?.available === false) failures.push('market safety data unavailable');
  const flowVerified = finite(candidate?.metrics?.trendingSmartDegenCount) >= 2
    || finite(candidate?.savedWalletExposure?.holderCount) >= 2;
  if (!flowVerified) failures.push('smart-money flow not verified');

  const dimensions = {
    priorRun: chart.priorHigh > 0 && chart.current > 0 && chart.priorHigh / chart.current >= 2 ? 2 : 0,
    drawdown: chart.drawdownPercent >= 50 && chart.drawdownPercent <= 85 ? 2 : 0,
    structure: chart.baseHealthy || chart.reclaim ? 2 : chart.structureVerified ? 1 : 0,
    volume: chart.volumeDryUp && (chart.reclaim || chart.baseHealthy) ? 2 : chart.volumeDryUp ? 1 : 0,
    flow: flowVerified ? 2 : 0,
    safety: buyTax != null && sellTax != null && buyTax <= 5 && sellTax <= 5 && honeypot === false
      && audit?.mintAuthorityDisabled === true && audit?.freezeAuthorityDisabled === true
      && finite(audit?.topHoldersPercentage) != null && Number(audit.topHoldersPercentage) <= 45 ? 2 : 0,
  };
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  return {
    family: 'second_wave_v2',
    eligible: failures.length === 0 && score >= MIN_SCORE,
    score,
    minScore: MIN_SCORE,
    hardFailures: failures,
    safetyVerified: failures.every(failure => !/authority|holder|safety|tax|honeypot|DEX|market safety/i.test(failure)),
    dataQuality: failures.length === 0 ? 'verified' : 'insufficient',
    dimensions,
    metrics: { mcap, liquidity, ageMs: age, ...chart },
  };
}

export function attachSecondWaveAssessment(candidate) {
  const assessment = assessSecondWave(candidate);
  return {
    ...candidate,
    secondWave: assessment,
    signals: { ...candidate.signals, strategyFamily: 'second_wave_v2' },
  };
}
