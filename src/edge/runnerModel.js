import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { safeJson } from '../utils.js';
import { ensureResearchSchema } from '../research/schema.js';
import { netBuyerRatio, qualityScoreCandidate } from './qualityScore.js';
import { counterfactualOutcomeRecords } from '../decisionIntelligence/learning.js';

const MODEL_VERSION = 'runner-path-bayes-v1';
let historyCache = { at: 0, key: '', records: null };

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function bucket(value, cuts, labels) {
  const n = finite(value);
  if (n == null) return 'unknown';
  for (let i = 0; i < cuts.length; i += 1) {
    if (n < cuts[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

function historyCacheMs() {
  return Math.max(0, Math.min(5 * 60_000, Math.floor(numSetting('edge_model_cache_ms', 30_000))));
}

function blendHistory(primary, supplemental, limit) {
  const supplementCount = Math.min(supplemental.length, Math.max(1, Math.floor(limit * 0.35)));
  const primaryCount = Math.min(primary.length, limit - supplementCount);
  const remaining = Math.max(0, limit - primaryCount - supplementCount);
  return [
    ...primary.slice(0, primaryCount + remaining),
    ...supplemental.slice(0, supplementCount),
  ].slice(0, limit);
}

export function resetRunnerModelCacheForTests() {
  historyCache = { at: 0, key: '', records: null };
}

export function runnerLabelFromPosition(position, {
  runnerMfeR = 3,
  maxMaeR = 1,
  maxTimeToMfeMs = 30 * 60 * 1000,
} = {}) {
  const mfeR = finite(position?.mfe_r);
  const maeR = finite(position?.mae_r);
  const timeToMfeMs = finite(position?.time_to_mfe_ms);
  if (mfeR == null || maeR == null) return { label: 'unknown', isRunner: null };

  const reachedRunnerMove = mfeR >= runnerMfeR;
  if (!reachedRunnerMove) return { label: 'non_runner', isRunner: false };
  if (maxTimeToMfeMs > 0 && timeToMfeMs == null) return { label: 'unknown', isRunner: null };
  if (maxTimeToMfeMs > 0 && timeToMfeMs > maxTimeToMfeMs) return { label: 'non_runner', isRunner: false };
  if (maeR < -Math.abs(maxMaeR)) return { label: 'messy_runner', isRunner: false };
  return { label: 'runner', isRunner: true };
}

export function runnerFeatureSnapshot(candidate = {}, quality = null) {
  const rawMomentum = finite(candidate?.filters?.momentumScore);
  const momentum = rawMomentum != null && rawMomentum >= 0 ? rawMomentum : null;
  const preScore = finite(candidate?.filters?.preScore);
  const qualityScore = finite(quality?.score ?? candidate?.filters?.qualityScore ?? candidate?.edge?.quality?.score);
  const liquidityUsd = finite(candidate?.metrics?.liquidityUsd ?? candidate?.jupiterAsset?.liquidity);
  const holderCount = finite(candidate?.metrics?.holderCount ?? candidate?.jupiterAsset?.holderCount);
  const buyerRatio = netBuyerRatio(candidate);
  const priceChange1h = finite(candidate?.jupiterAsset?.stats1h?.priceChange);
  return {
    route: String(candidate?.signals?.primaryRoute || candidate?.signals?.route || 'unknown'),
    momentum,
    preScore,
    qualityScore,
    liquidityUsd,
    holderCount,
    netBuyerRatio5m: buyerRatio,
    priceChange1h,
    buckets: {
      momentum: bucket(momentum, [0.35, 0.65], ['low', 'mid', 'high']),
      preScore: bucket(preScore, [35, 65], ['low', 'mid', 'high']),
      quality: bucket(qualityScore, [45, 70], ['low', 'mid', 'high']),
      liquidity: bucket(liquidityUsd, [6_000, 15_000], ['thin', 'mid', 'deep']),
      holders: bucket(holderCount, [150, 600], ['early', 'mid', 'broad']),
      flow: bucket(buyerRatio, [0.1, 0.35], ['weak', 'balanced', 'strong']),
    },
  };
}

function posteriorProbability(records, priorProbability, priorStrength) {
  const labeled = records.filter(row => row.isRunner === true || row.isRunner === false);
  const wins = labeled.filter(row => row.isRunner === true).length;
  const n = labeled.length;
  const prior = clamp01(priorProbability);
  const strength = Math.max(0, Number(priorStrength) || 0);
  return {
    probability: (wins + prior * strength) / Math.max(1, n + strength),
    wins,
    sample: n,
  };
}

export function estimateRunnerProbabilityFromRecords(records = [], featureSnapshot = {}, {
  priorStrength = 12,
  minSample = 20,
} = {}) {
  const labeled = records.filter(row => row.isRunner === true || row.isRunner === false);
  const globalRaw = labeled.length ? labeled.filter(row => row.isRunner).length / labeled.length : 0.30;
  const globalPosterior = posteriorProbability(labeled, 0.30, priorStrength);
  const baseP = globalPosterior.probability;

  const dimensions = [
    ['route', featureSnapshot.route],
    ['momentum', featureSnapshot?.buckets?.momentum],
    ['quality', featureSnapshot?.buckets?.quality],
    ['liquidity', featureSnapshot?.buckets?.liquidity],
    ['holders', featureSnapshot?.buckets?.holders],
    ['flow', featureSnapshot?.buckets?.flow],
  ];

  const evidence = [];
  let weighted = baseP * 1.5;
  let totalWeight = 1.5;
  for (const [key, value] of dimensions) {
    if (!value || value === 'unknown') continue;
    const subset = labeled.filter(row => row?.features?.[key] === value);
    if (!subset.length) continue;
    const posterior = posteriorProbability(subset, baseP, priorStrength);
    const reliability = posterior.sample / (posterior.sample + priorStrength);
    const weight = Math.max(0.15, reliability);
    weighted += posterior.probability * weight;
    totalWeight += weight;
    evidence.push({ key, value, ...posterior, reliability });
  }

  const probability = weighted / totalWeight;
  const sample = labeled.length;
  const modelQuality = sample >= Math.max(60, minSample * 3) ? 'HIGH' : sample >= minSample ? 'MEDIUM' : 'LOW';
  return {
    version: MODEL_VERSION,
    probability: Number(probability.toFixed(4)),
    globalRawProbability: Number(globalRaw.toFixed(4)),
    sample,
    minimumSample: minSample,
    decisionEligible: sample >= minSample,
    quality: modelQuality,
    evidence,
  };
}

function recordsFromResearchHistory({ runnerMfeR, maxMaeR, maxTimeToMfeMs, limit }) {
  ensureResearchSchema();
  const key = `${runnerMfeR}|${maxMaeR}|${maxTimeToMfeMs}|${limit}`;
  const ttl = historyCacheMs();
  if (historyCache.records && historyCache.key === key && ttl > 0 && Date.now() - historyCache.at <= ttl) {
    return historyCache.records;
  }

  const rows = db.prepare(`
    SELECT id, mfe_r, mae_r, time_to_mfe_ms, snapshot_json
    FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'closed'
      AND mfe_r IS NOT NULL AND mae_r IS NOT NULL
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(limit);

  const positionRecords = rows.map(row => {
    const snapshot = safeJson(row.snapshot_json, {});
    const candidate = snapshot?.candidate || {};
    const historicalQuality = candidate?.edge?.quality || qualityScoreCandidate(candidate);
    const features = runnerFeatureSnapshot(candidate, historicalQuality);
    const label = runnerLabelFromPosition(row, { runnerMfeR, maxMaeR, maxTimeToMfeMs });
    return {
      id: Number(row.id),
      isRunner: label.isRunner,
      label: label.label,
      features: {
        route: features.route,
        momentum: features.buckets.momentum,
        quality: features.buckets.quality,
        liquidity: features.buckets.liquidity,
        holders: features.buckets.holders,
        flow: features.buckets.flow,
      },
    };
  });
  const counterfactualRecords = counterfactualOutcomeRecords(limit).map(row => {
    const candidate = row.candidate || {};
    const historicalQuality = candidate?.edge?.quality || qualityScoreCandidate(candidate);
    const features = runnerFeatureSnapshot(candidate, historicalQuality);
    const label = runnerLabelFromPosition({
      mfe_r: row.sampledMfeR,
      mae_r: row.sampledMaeR,
      time_to_mfe_ms: runnerMfeR === 3 ? row.first3rHorizonMs : null,
    }, { runnerMfeR, maxMaeR, maxTimeToMfeMs });
    return {
      id: `decision:${row.id}`,
      isRunner: label.isRunner,
      label: label.label,
      counterfactual: true,
      features: {
        route: features.route,
        momentum: features.buckets.momentum,
        quality: features.buckets.quality,
        liquidity: features.buckets.liquidity,
        holders: features.buckets.holders,
        flow: features.buckets.flow,
      },
    };
  });
  const records = blendHistory(positionRecords, counterfactualRecords, limit);
  historyCache = { at: Date.now(), key, records };
  return records;
}

export function estimateRunnerProbability(candidate, quality = null) {
  const runnerMfeR = Math.max(1, numSetting('runner_label_mfe_r', 3));
  const maxMaeR = Math.max(0.25, numSetting('runner_label_max_mae_r', 1));
  const maxTimeToMfeMs = Math.max(0, numSetting('runner_label_max_time_minutes', 30)) * 60_000;
  const minSample = Math.max(10, Math.floor(numSetting('runner_model_min_sample', 20)));
  const limit = Math.max(100, Math.min(5000, Math.floor(numSetting('runner_model_history_limit', 1500))));
  const priorStrength = Math.max(1, numSetting('runner_model_prior_strength', 12));
  const featureSnapshot = runnerFeatureSnapshot(candidate, quality);
  const records = recordsFromResearchHistory({ runnerMfeR, maxMaeR, maxTimeToMfeMs, limit });
  return {
    ...estimateRunnerProbabilityFromRecords(records, featureSnapshot, { priorStrength, minSample }),
    labelDefinition: { runnerMfeR, maxMaeR, maxTimeToMfeMs },
    features: featureSnapshot,
  };
}

export const RUNNER_MODEL_VERSION = MODEL_VERSION;
