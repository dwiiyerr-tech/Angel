import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { safeJson } from '../utils.js';
import { netBuyerRatio } from './qualityScore.js';

const MODEL_VERSION = 'runner-path-bayes-v1';

function finite(value) {
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
  const reachedInTime = maxTimeToMfeMs <= 0 || timeToMfeMs == null || timeToMfeMs <= maxTimeToMfeMs;
  if (!reachedRunnerMove || !reachedInTime) return { label: 'non_runner', isRunner: false };
  if (maeR < -Math.abs(maxMaeR)) return { label: 'messy_runner', isRunner: false };
  return { label: 'runner', isRunner: true };
}

export function runnerFeatureSnapshot(candidate = {}, quality = null) {
  const momentum = finite(candidate?.filters?.momentumScore);
  const preScore = finite(candidate?.filters?.preScore);
  const qualityScore = finite(quality?.score ?? candidate?.filters?.qualityScore ?? candidate?.edge?.quality?.score);
  const liquidityUsd = finite(candidate?.metrics?.liquidityUsd ?? candidate?.jupiterAsset?.liquidity);
  const holderCount = finite(candidate?.metrics?.holderCount ?? candidate?.jupiterAsset?.holderCount);
  const buyerRatio = netBuyerRatio(candidate);
  const priceChange1h = finite(candidate?.jupiterAsset?.stats1h?.priceChange);
  return {
    route: String(candidate?.signals?.route || 'unknown'),
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
  const quality = sample >= Math.max(60, minSample * 3) ? 'HIGH' : sample >= minSample ? 'MEDIUM' : 'LOW';
  return {
    version: MODEL_VERSION,
    probability: Number(probability.toFixed(4)),
    globalRawProbability: Number(globalRaw.toFixed(4)),
    sample,
    minimumSample: minSample,
    decisionEligible: sample >= minSample,
    quality,
    evidence,
  };
}

function recordsFromResearchHistory({ runnerMfeR, maxMaeR, maxTimeToMfeMs, limit }) {
  const rows = db.prepare(`
    SELECT id, mfe_r, mae_r, time_to_mfe_ms, snapshot_json
    FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'closed'
      AND mfe_r IS NOT NULL AND mae_r IS NOT NULL
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(limit);

  return rows.map(row => {
    const snapshot = safeJson(row.snapshot_json, {});
    const candidate = snapshot?.candidate || {};
    const features = runnerFeatureSnapshot(candidate, candidate?.edge?.quality || null);
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
