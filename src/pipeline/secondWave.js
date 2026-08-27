const DEFAULT_MIN_MCAP_USD = 80_000;
const DEFAULT_MAX_MCAP_USD = 3_000_000;
const DEFAULT_MIN_LIQUIDITY_USD = 25_000;
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function positive(...values) {
  for (const value of values) {
    const number = finite(value);
    if (number != null && number > 0) return number;
  }
  return null;
}

function timestampMs(value) {
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const number = finite(value);
  if (number == null || number <= 0) return null;
  return number < 1e12 ? number * 1000 : number;
}

function candidateCreatedAtMs(candidate) {
  return timestampMs(
    candidate?.jupiterAsset?.firstPool?.createdAt
    ?? candidate?.jupiterAsset?.createdAt
    ?? candidate?.gmgn?.creation_timestamp
    ?? candidate?.gmgn?.created_at
    ?? candidate?.graduation?.graduationDate
    ?? candidate?.graduation?.seenAt
    ?? candidate?.trenchesEntry?.created_timestamp,
  );
}

export function tokenAgeMs(candidate, observedAtMs = Date.now()) {
  const createdAtMs = candidateCreatedAtMs(candidate);
  if (createdAtMs == null) return null;
  return Math.max(0, Number(observedAtMs) - createdAtMs);
}

function availableWindows(candidate) {
  return (Array.isArray(candidate?.chart?.windows) ? candidate.chart.windows : [])
    .filter(window => window?.available === true);
}

function rangeHigh(candidate) {
  const chartHigh = finite(candidate?.chart?.rangeHighNative);
  const windowHigh = availableWindows(candidate)
    .map(window => finite(window.high))
    .filter(value => value != null && value > 0);
  return positive(chartHigh, ...windowHigh);
}

function currentLevel(candidate) {
  return positive(
    candidate?.chart?.currentNative,
    ...availableWindows(candidate).map(window => window.current),
    candidate?.metrics?.priceUsd,
  );
}

function bestWindow(candidate, labels) {
  const windows = availableWindows(candidate);
  return windows.find(window => labels.includes(window.label)) || windows[0] || null;
}

function priorRunScore(candidate) {
  const windows = availableWindows(candidate);
  const expansion = windows.map(window => {
    const change = finite(window.changePercent);
    const low = finite(window.low);
    const high = finite(window.high);
    const rangeMultiple = low > 0 && high > 0 ? high / low : null;
    return Math.max(change ?? -Infinity, rangeMultiple == null ? -Infinity : (rangeMultiple - 1) * 100);
  }).filter(Number.isFinite);
  const strongest = expansion.length ? Math.max(...expansion) : null;
  if (strongest == null) return { score: 0, strength: 'UNKNOWN', strongestExpansionPercent: null };
  if (strongest >= 100) return { score: 2, strength: 'STRONG', strongestExpansionPercent: strongest };
  if (strongest >= 50) return { score: 1, strength: 'MODERATE', strongestExpansionPercent: strongest };
  return { score: 0, strength: 'WEAK', strongestExpansionPercent: strongest };
}

function pullbackScore(candidate) {
  const high = rangeHigh(candidate);
  const current = currentLevel(candidate);
  if (high == null || current == null || high <= 0 || current <= 0) {
    return { score: 0, drawdownPercent: null, quality: 'UNKNOWN' };
  }
  const drawdownPercent = (1 - current / high) * 100;
  if (drawdownPercent >= 50 && drawdownPercent <= 85) {
    return { score: 2, drawdownPercent, quality: 'HEALTHY_RESET' };
  }
  if (drawdownPercent > 85 && drawdownPercent <= 95) {
    return { score: 1, drawdownPercent, quality: 'HIGH_RISK_RESET' };
  }
  if (drawdownPercent >= 35 && drawdownPercent < 50) {
    return { score: 1, drawdownPercent, quality: 'SHALLOW_RESET' };
  }
  return { score: 0, drawdownPercent, quality: drawdownPercent > 95 ? 'CORPSE_RISK' : 'INSUFFICIENT_RESET' };
}

function structureScore(candidate) {
  const window = bestWindow(candidate, ['swing_7d_1h', 'long_30d_4h']);
  if (!window) return { score: 0, base: false, reclaim: false, compression: false, higherLow: null };
  const higherLow = window.higherLow === true;
  const compression = window.rangeCompression != null && window.rangeCompression <= 0.8;
  const reclaim = window.reclaimOfPriorHigh === true;
  const base = higherLow || compression;
  const score = reclaim || (higherLow && compression) ? 2 : base ? 1 : 0;
  return { score, base, reclaim, compression, higherLow };
}

function volumeScore(candidate) {
  const window = bestWindow(candidate, ['swing_7d_1h', 'long_30d_4h', 'ath_context_24h_5m']);
  const acceleration = candidate?.volumeAcceleration;
  const dryup = finite(window?.recentVolumeVsPrior) != null && Number(window.recentVolumeVsPrior) <= 0.8;
  const renewed = finite(window?.lastVolumeVsRecent) != null && Number(window.lastVolumeVsRecent) >= 1.5;
  const accelerating = acceleration?.valid === true && acceleration.accelerating === true;
  if (dryup && (renewed || accelerating)) return { score: 2, dryup, renewed: true };
  if (dryup || renewed || accelerating) return { score: 1, dryup, renewed: renewed || accelerating };
  return { score: 0, dryup: false, renewed: false };
}

function flowScore(candidate) {
  const stats = candidate?.jupiterAsset?.stats5m || {};
  const netBuyers = finite(stats.numNetBuyers);
  const traders = finite(stats.numTraders);
  const netBuyerRatio = netBuyers != null && traders != null && traders > 0 ? netBuyers / traders : null;
  const smartDegens = finite(
    candidate?.metrics?.trendingSmartDegenCount
    ?? candidate?.trending?.smart_degen_count
    ?? candidate?.secondWaveSignal?.smart_degen_count
    ?? candidate?.smartMoneySignal?.smart_degen_count
    ?? candidate?.gmgn?.smart_degen_count,
  );
  const savedWallets = finite(candidate?.savedWalletExposure?.holderCount);
  const signalPresent = Boolean(candidate?.smartMoneySignal || candidate?.gmgnSignal);
  if (netBuyerRatio != null && netBuyerRatio < 0) {
    return { score: 0, netBuyerRatio, smartDegens, savedWallets, signalPresent, state: 'DISTRIBUTION' };
  }
  if (netBuyerRatio != null && netBuyerRatio >= 0.2 && (smartDegens >= 2 || savedWallets >= 1 || signalPresent)) {
    return { score: 2, netBuyerRatio, smartDegens, savedWallets, signalPresent, state: 'ACCUMULATION' };
  }
  if ((netBuyerRatio != null && netBuyerRatio >= 0) || smartDegens > 0 || savedWallets > 0 || signalPresent) {
    return { score: 1, netBuyerRatio, smartDegens, savedWallets, signalPresent, state: 'MIXED' };
  }
  return { score: 0, netBuyerRatio, smartDegens, savedWallets, signalPresent, state: 'UNKNOWN' };
}

function safetyScore(candidate) {
  if (candidate?.contractSafety?.passed === false) return { score: 0, hardReject: true, state: 'REJECTED' };
  if (candidate?.contractSafety?.passed === true && candidate?.contractSafety?.auditComplete === true) {
    return { score: 2, hardReject: false, state: 'VERIFIED' };
  }
  if (candidate?.contractSafety?.passed === true) {
    return { score: 1, hardReject: false, state: 'PASSED_PARTIAL' };
  }
  return { score: 1, hardReject: false, state: 'PENDING_KERNEL' };
}

export function assessSecondWaveCandidate(candidate = {}, options = {}) {
  const minMcapUsd = finite(options.minMcapUsd) ?? DEFAULT_MIN_MCAP_USD;
  const maxMcapUsd = finite(options.maxMcapUsd) ?? DEFAULT_MAX_MCAP_USD;
  const minLiquidityUsd = finite(options.minLiquidityUsd) ?? DEFAULT_MIN_LIQUIDITY_USD;
  const minAgeMs = finite(options.minAgeMs) ?? DEFAULT_MIN_AGE_MS;
  const observedAtMs = finite(options.observedAtMs) ?? Date.now();
  const mcap = positive(candidate?.metrics?.marketCapUsd, candidate?.gmgn?.market_cap, candidate?.gmgn?.mcap);
  const liquidity = positive(candidate?.metrics?.liquidityUsd, candidate?.gmgn?.liquidity, candidate?.jupiterAsset?.liquidity);
  const ageMs = tokenAgeMs(candidate, observedAtMs);
  const priorRun = priorRunScore(candidate);
  const pullback = pullbackScore(candidate);
  const structure = structureScore(candidate);
  const volume = volumeScore(candidate);
  const flow = flowScore(candidate);
  const safety = safetyScore(candidate);
  const hardFailures = [];
  if (mcap == null || mcap < minMcapUsd || mcap > maxMcapUsd) hardFailures.push('mcap_outside_second_wave_universe');
  if (liquidity == null || liquidity < minLiquidityUsd) hardFailures.push('liquidity_below_second_wave_floor');
  if (ageMs == null || ageMs < minAgeMs) hardFailures.push('token_age_below_24h_or_unknown');
  if (priorRun.score === 0) hardFailures.push('prior_runner_not_verified');
  if (safety.hardReject) hardFailures.push('contract_safety_rejected');
  if (flow.state === 'DISTRIBUTION') hardFailures.push('smart_money_distribution');
  if (pullback.quality === 'CORPSE_RISK') hardFailures.push('drawdown_over_95_percent');

  const total = priorRun.score + pullback.score + structure.score + volume.score + flow.score + safety.score;
  const entryMode = structure.reclaim ? 'RECLAIM' : structure.base ? 'BASE_DIP' : null;
  const eligible = hardFailures.length === 0 && total >= 8 && Boolean(entryMode);
  const missing = [];
  if (ageMs == null) missing.push('verified_token_age');
  if (priorRun.score < 2) missing.push('clear_prior_expansion');
  if (structure.score < 2) missing.push('clean_base_or_reclaim');
  if (volume.score < 2) missing.push('dryup_then_renewed_demand');
  if (flow.score < 2) missing.push('quality_smart_money_accumulation');

  return {
    version: 'second-wave-score-v1',
    score: total,
    maxScore: 12,
    scorePercent: Number((total / 12 * 100).toFixed(2)),
    eligible,
    hardReject: hardFailures.length > 0,
    hardFailures,
    entryMode,
    missing,
    market: { mcapUsd: mcap, liquidityUsd: liquidity, ageMs },
    priorRun,
    pullback,
    structure,
    volume,
    flow,
    safety,
    confidence: Number(clamp(total / 12 * 100).toFixed(1)),
  };
}

export function secondWaveDecision(candidate, assessment = assessSecondWaveCandidate(candidate)) {
  if (assessment.hardReject) {
    return {
      verdict: 'REJECT',
      confidence: assessment.confidence,
      reason: `Second-wave hard gate: ${assessment.hardFailures.join(', ')}`,
      entryMode: null,
      suggestedTpPercent: null,
      suggestedSlPercent: null,
    };
  }
  if (!assessment.eligible) {
    return {
      verdict: 'WATCH',
      confidence: assessment.confidence,
      reason: `Second-wave score ${assessment.score}/12 is not entry-ready.`,
      entryMode: assessment.entryMode,
      suggestedTpPercent: null,
      suggestedSlPercent: null,
    };
  }
  return {
    verdict: 'BUY',
    confidence: assessment.confidence,
    reason: `Deterministic second-wave setup ${assessment.entryMode} scored ${assessment.score}/12.`,
    entryMode: assessment.entryMode,
    suggestedTpPercent: 100,
    suggestedSlPercent: -25,
  };
}

export function isSecondWaveStrategy(strategy = {}) {
  return String(strategy?.id || '').toLowerCase() === 'second_wave_smart_money';
}
