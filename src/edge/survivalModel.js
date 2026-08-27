import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { safeJson } from '../utils.js';
import { ensureResearchSchema } from '../research/schema.js';
import { qualityScoreCandidate } from './qualityScore.js';
import { runnerFeatureSnapshot } from './runnerModel.js';
import { counterfactualSurvivalRecords } from '../decisionIntelligence/learning.js';

const MODEL_VERSION = 'survival-path-bayes-v1';
let historyCache = { at: 0, key: '', records: null };

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
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

export function resetSurvivalModelCacheForTests() {
  historyCache = { at: 0, key: '', records: null };
}

/**
 * Survival is deliberately different from "win". A token survives when its
 * executable path avoids the configured failure R during the early validation
 * horizon. A profitable early close also counts as survived; an early losing
 * close is a failed thesis even if it did not reach the catastrophic boundary.
 */
export function survivalLabelFromPath({
  openedAtMs,
  closedAtMs = null,
  realizedR = null,
  observations = [],
} = {}, {
  horizonMs = 2 * 60_000,
  failureR = 1,
} = {}) {
  const opened = finite(openedAtMs);
  if (opened == null) return { label: 'unknown', survived: null };
  const horizonAt = opened + Math.max(1, Number(horizonMs) || 1);
  const path = observations
    .map(row => ({ atMs: finite(row?.atMs ?? row?.at_ms), r: finite(row?.r ?? row?.r_multiple) }))
    .filter(row => row.atMs != null && row.r != null && row.atMs >= opened && row.atMs <= horizonAt)
    .sort((a, b) => a.atMs - b.atMs);
  const minR = path.length ? Math.min(...path.map(row => row.r)) : null;
  if (minR != null && minR <= -Math.abs(Number(failureR) || 1)) {
    return { label: 'early_failure', survived: false, minR, horizonAt };
  }

  const closed = finite(closedAtMs);
  const realized = finite(realizedR);
  if (closed != null && closed <= horizonAt) {
    if (realized == null) return { label: 'unknown', survived: null, minR, horizonAt };
    return {
      label: realized >= 0 ? 'survived_profitable_close' : 'early_failed_thesis',
      survived: realized >= 0,
      minR,
      horizonAt,
    };
  }

  const observedThroughHorizon = path.some(row => row.atMs >= horizonAt - 5_000);
  const remainedOpenThroughHorizon = closed != null && closed > horizonAt;
  if (!observedThroughHorizon && !remainedOpenThroughHorizon) {
    return { label: 'unknown', survived: null, minR, horizonAt };
  }
  return { label: 'survived', survived: true, minR, horizonAt };
}

function posterior(records, priorProbability, priorStrength) {
  const labeled = records.filter(row => row.survived === true || row.survived === false);
  const survived = labeled.filter(row => row.survived === true).length;
  const strength = Math.max(1, Number(priorStrength) || 1);
  return {
    probability: (survived + clamp01(priorProbability) * strength) / Math.max(1, labeled.length + strength),
    survived,
    sample: labeled.length,
  };
}

export function survivalFeatureSnapshot(candidate = {}, quality = null) {
  const base = runnerFeatureSnapshot(candidate, quality);
  return {
    route: base.route,
    qualityScore: base.qualityScore,
    liquidityUsd: base.liquidityUsd,
    holderCount: base.holderCount,
    netBuyerRatio5m: base.netBuyerRatio5m,
    buckets: {
      quality: base.buckets.quality,
      liquidity: base.buckets.liquidity,
      holders: base.buckets.holders,
      flow: base.buckets.flow,
    },
  };
}

export function estimateSurvivalProbabilityFromRecords(records = [], featureSnapshot = {}, {
  priorStrength = 16,
  minSample = 30,
} = {}) {
  const labeled = records.filter(row => row.survived === true || row.survived === false);
  const raw = labeled.length ? labeled.filter(row => row.survived).length / labeled.length : 0.5;
  const globalPosterior = posterior(labeled, 0.5, priorStrength);
  const dimensions = [
    ['route', featureSnapshot.route],
    ['quality', featureSnapshot?.buckets?.quality],
    ['liquidity', featureSnapshot?.buckets?.liquidity],
    ['holders', featureSnapshot?.buckets?.holders],
    ['flow', featureSnapshot?.buckets?.flow],
  ];
  let weighted = globalPosterior.probability * 1.5;
  let totalWeight = 1.5;
  const evidence = [];
  for (const [key, value] of dimensions) {
    if (!value || value === 'unknown') continue;
    const subset = labeled.filter(row => row?.features?.[key] === value);
    if (!subset.length) continue;
    const segment = posterior(subset, globalPosterior.probability, priorStrength);
    const reliability = segment.sample / (segment.sample + priorStrength);
    const weight = Math.max(0.15, reliability);
    weighted += segment.probability * weight;
    totalWeight += weight;
    evidence.push({ key, value, ...segment, reliability });
  }
  const sample = labeled.length;
  return {
    version: MODEL_VERSION,
    probability: Number((weighted / totalWeight).toFixed(4)),
    globalRawProbability: Number(raw.toFixed(4)),
    sample,
    minimumSample: minSample,
    decisionEligible: sample >= minSample,
    quality: sample >= Math.max(90, minSample * 3) ? 'HIGH' : sample >= minSample ? 'MEDIUM' : 'LOW',
    evidence,
  };
}

function recordsFromResearchHistory({ horizonMs, failureR, limit }) {
  ensureResearchSchema();
  const key = `${horizonMs}|${failureR}|${limit}`;
  const ttl = historyCacheMs();
  if (historyCache.records && historyCache.key === key && ttl > 0 && Date.now() - historyCache.at <= ttl) {
    return historyCache.records;
  }
  const positions = db.prepare(`
    SELECT id, opened_at_ms, closed_at_ms, realized_r, snapshot_json
    FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'closed'
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(limit);
  const observationsForPosition = db.prepare(`
    SELECT at_ms, r_multiple
    FROM research_observations
    WHERE position_id = ? AND at_ms <= ?
    ORDER BY at_ms ASC
  `);
  const positionRecords = positions.map(position => {
    const snapshot = safeJson(position.snapshot_json, {});
    const candidate = snapshot?.candidate || {};
    const quality = candidate?.edge?.quality || qualityScoreCandidate(candidate);
    const features = survivalFeatureSnapshot(candidate, quality);
    const label = survivalLabelFromPath({
      openedAtMs: position.opened_at_ms,
      closedAtMs: position.closed_at_ms,
      realizedR: position.realized_r,
      observations: observationsForPosition.all(position.id, Number(position.opened_at_ms) + horizonMs),
    }, { horizonMs, failureR });
    return {
      id: Number(position.id),
      survived: label.survived,
      label: label.label,
      features: {
        route: features.route,
        quality: features.buckets.quality,
        liquidity: features.buckets.liquidity,
        holders: features.buckets.holders,
        flow: features.buckets.flow,
      },
    };
  });
  const counterfactualRecords = counterfactualSurvivalRecords({ horizonMs, failureR, limit }).map(row => {
    const candidate = row.candidate || {};
    const quality = candidate?.edge?.quality || qualityScoreCandidate(candidate);
    const features = survivalFeatureSnapshot(candidate, quality);
    return {
      id: `decision:${row.id}`,
      survived: row.survived,
      label: row.label,
      counterfactual: true,
      features: {
        route: features.route,
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

export function estimateSurvivalProbability(candidate, quality = null) {
  const horizonMs = Math.max(30, numSetting('survival_horizon_seconds', 120)) * 1000;
  const failureR = Math.max(0.5, numSetting('survival_failure_r', 1));
  const minSample = Math.max(10, Math.floor(numSetting('survival_model_min_sample', 30)));
  const priorStrength = Math.max(1, numSetting('survival_model_prior_strength', 16));
  const limit = Math.max(100, Math.min(5000, Math.floor(numSetting('survival_model_history_limit', 1500))));
  const features = survivalFeatureSnapshot(candidate, quality);
  return {
    ...estimateSurvivalProbabilityFromRecords(
      recordsFromResearchHistory({ horizonMs, failureR, limit }),
      features,
      { priorStrength, minSample },
    ),
    labelDefinition: { horizonMs, failureR },
    features,
  };
}

export const SURVIVAL_MODEL_VERSION = MODEL_VERSION;
