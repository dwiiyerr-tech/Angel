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
  return { current, priorHigh, drawdownPercent, structureVerified, baseHealthy, reclaim, volumeDryUp };
}

export function assessSecondWave(candidate) {
  const mcap = finite(candidate?.metrics?.marketCapUsd);
  const liquidity = finite(candidate?.metrics?.liquidityUsd);
  const age = ageMs(candidate);
  const audit = candidate?.jupiterAsset?.audit;
  const chart = chartFeatures(candidate);
  const failures = [];
  if (mcap == null || mcap < 80_000 || mcap > 3_000_000) failures.push('market cap outside 80k-3m');
  if (liquidity == null || liquidity < 25_000) failures.push('liquidity below 25k');
  if (age == null || age < 24 * 60 * 60 * 1000) failures.push('token age below 24h or unknown');
  if (!chart.structureVerified) failures.push('chart structure data unverified');
  if (chart.drawdownPercent == null || chart.drawdownPercent < 50 || chart.drawdownPercent > 85) failures.push('drawdown outside 50-85%');
  if (audit?.mintAuthorityDisabled !== true) failures.push('mint authority not verified disabled');
  if (audit?.freezeAuthorityDisabled !== true) failures.push('freeze authority not verified disabled');
  if (finite(audit?.topHoldersPercentage) == null || Number(audit.topHoldersPercentage) > 45) failures.push('top-holder concentration unsafe');
  if (candidate?.dataQuality?.jupiterAsset?.available === false) failures.push('market safety data unavailable');

  const dimensions = {
    priorRun: chart.priorHigh > 0 ? 2 : 0,
    drawdown: chart.drawdownPercent >= 50 && chart.drawdownPercent <= 85 ? 2 : 0,
    structure: chart.baseHealthy || chart.reclaim ? 2 : chart.structureVerified ? 1 : 0,
    volume: chart.volumeDryUp && (chart.reclaim || chart.baseHealthy) ? 2 : chart.volumeDryUp ? 1 : 0,
    flow: finite(candidate?.metrics?.trendingSmartDegenCount) >= 2 || finite(candidate?.savedWalletExposure?.holderCount) >= 2 ? 2 : 0,
    safety: failures.filter(failure => failure.includes('authority') || failure.includes('holder') || failure.includes('safety')).length === 0 ? 2 : 0,
  };
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  return {
    family: 'second_wave_v2',
    eligible: failures.length === 0 && score >= MIN_SCORE,
    score,
    minScore: MIN_SCORE,
    hardFailures: failures,
    safetyVerified: failures.every(failure => !failure.includes('authority') && !failure.includes('holder') && !failure.includes('safety')),
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
