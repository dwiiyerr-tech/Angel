import { db } from '../db/connection.js';
import { NEEDLE_SCORE_WEIGHTS } from './needleScore.js';

export const NEEDLE_CALIBRATION_VERSION = 'needle-calibration-v1';

export const NEEDLE_CALIBRATION_DIMENSIONS = Object.freeze([
  'devQuality',
  'holderDistribution',
  'organicFlow',
  'liquidityStructure',
  'narrative',
  'earlyAsymmetry',
  'runnerProbability',
  'expectedR',
]);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function safeParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function average(values) {
  const clean = values.filter(value => finite(value) != null).map(Number);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function ranks(values) {
  const indexed = values.map((value, index) => ({ value: Number(value), index }))
    .sort((a, b) => a.value - b.value);
  const result = Array(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j].value === indexed[i].value) j += 1;
    const rank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k += 1) result[indexed[k].index] = rank;
    i = j;
  }
  return result;
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const meanX = average(xs);
  const meanY = average(ys);
  if (meanX == null || meanY == null) return 0;
  let numerator = 0;
  let x2 = 0;
  let y2 = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = Number(xs[i]) - meanX;
    const dy = Number(ys[i]) - meanY;
    numerator += dx * dy;
    x2 += dx * dx;
    y2 += dy * dy;
  }
  if (x2 <= 0 || y2 <= 0) return 0;
  return numerator / Math.sqrt(x2 * y2);
}

function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  return pearson(ranks(xs), ranks(ys));
}

function outcomeUtility({ realizedR, mfeR, maeR }) {
  const realized = finite(realizedR) ?? 0;
  const mfe = Math.max(0, finite(mfeR) ?? 0);
  const mae = Math.min(0, finite(maeR) ?? 0);
  const tailBonus = (mfe >= 3 ? 0.5 : 0)
    + (mfe >= 5 ? 0.8 : 0)
    + (mfe >= 10 ? 1.5 : 0);
  const utility = realized * 0.35
    + Math.min(mfe, 12) * 0.35
    - Math.min(Math.abs(mae), 4) * 0.20
    + tailBonus;
  return clamp(utility, -5, 12);
}

export function extractNeedleCalibrationSample(row = {}) {
  const snapshot = safeParse(row.snapshot_json, {});
  const candidate = snapshot?.candidate || {};
  const needle = candidate?.needle;
  const realizedR = finite(row.realized_r);
  if (!needle || realizedR == null || !needle.dimensions) return null;
  const dimensionScores = {};
  const dimensionKnown = {};
  for (const key of NEEDLE_CALIBRATION_DIMENSIONS) {
    const dimension = needle.dimensions?.[key];
    const score = finite(dimension?.score);
    if (score == null) return null;
    dimensionScores[key] = clamp(score, 0, 100);
    dimensionKnown[key] = dimension?.known !== false;
  }
  const mfeR = finite(row.mfe_r);
  const maeR = finite(row.mae_r);
  return {
    id: Number(row.id || 0),
    openedAtMs: Number(row.opened_at_ms || 0),
    closedAtMs: Number(row.closed_at_ms || 0),
    executionMode: String(row.execution_mode || 'dry_run'),
    realizedR,
    mfeR,
    maeR,
    utility: outcomeUtility({ realizedR, mfeR, maeR }),
    runner3: mfeR != null && mfeR >= 3 ? 1 : 0,
    runner5: mfeR != null && mfeR >= 5 ? 1 : 0,
    runner10: mfeR != null && mfeR >= 10 ? 1 : 0,
    dimensions: dimensionScores,
    dimensionKnown,
    needleVersion: String(needle.version || 'unknown'),
  };
}

export function loadNeedleCalibrationRows({ limit = 5000 } = {}) {
  const safeLimit = Math.max(1, Math.min(20_000, Math.floor(Number(limit) || 5000)));
  return db.prepare(`
    SELECT id, opened_at_ms, closed_at_ms, execution_mode,
           realized_r, mfe_r, mae_r, snapshot_json
    FROM dry_run_positions
    WHERE status = 'closed'
      AND lower(trim(coalesce(execution_mode, 'dry_run'))) NOT IN ('live', 'confirm')
      AND realized_r IS NOT NULL
      AND snapshot_json IS NOT NULL
    ORDER BY opened_at_ms ASC, id ASC
    LIMIT ?
  `).all(safeLimit);
}

function dimensionSignal(samples, key, minKnownSample) {
  const selected = samples.filter(sample => sample.dimensionKnown[key] === true);
  if (selected.length < minKnownSample) {
    return {
      knownSample: selected.length,
      utilityCorrelation: 0,
      runner3Correlation: 0,
      runner5Correlation: 0,
      runner10Correlation: 0,
      rawSignal: 0,
      shrunkSignal: 0,
    };
  }
  const scores = selected.map(sample => sample.dimensions[key]);
  const utilityCorrelation = spearman(scores, selected.map(sample => sample.utility));
  const runner3Correlation = spearman(scores, selected.map(sample => sample.runner3));
  const runner5Correlation = spearman(scores, selected.map(sample => sample.runner5));
  const runner10Correlation = spearman(scores, selected.map(sample => sample.runner10));
  const rawSignal = utilityCorrelation * 0.35
    + runner3Correlation * 0.20
    + runner5Correlation * 0.20
    + runner10Correlation * 0.25;
  const shrink = selected.length / (selected.length + 60);
  return {
    knownSample: selected.length,
    utilityCorrelation,
    runner3Correlation,
    runner5Correlation,
    runner10Correlation,
    rawSignal,
    shrunkSignal: rawSignal * shrink,
  };
}

function normalizeAdaptiveWeights(rawWeights) {
  const result = { safety: NEEDLE_SCORE_WEIGHTS.safety };
  const adaptiveTotal = NEEDLE_CALIBRATION_DIMENSIONS.reduce((sum, key) => sum + Math.max(0, Number(rawWeights[key]) || 0), 0);
  const target = 100 - NEEDLE_SCORE_WEIGHTS.safety;
  if (adaptiveTotal <= 0) {
    for (const key of NEEDLE_CALIBRATION_DIMENSIONS) result[key] = NEEDLE_SCORE_WEIGHTS[key];
    return result;
  }
  for (const key of NEEDLE_CALIBRATION_DIMENSIONS) {
    result[key] = Math.max(0, Number(rawWeights[key]) || 0) / adaptiveTotal * target;
  }
  const sum = Object.values(result).reduce((total, value) => total + Number(value), 0);
  const last = NEEDLE_CALIBRATION_DIMENSIONS[NEEDLE_CALIBRATION_DIMENSIONS.length - 1];
  result[last] += 100 - sum;
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Number(value.toFixed(4))]));
}

export function fitNeedleChallengerWeights(samples, { minKnownSample = 20 } = {}) {
  const dimensionStats = {};
  const rawWeights = {};
  for (const key of NEEDLE_CALIBRATION_DIMENSIONS) {
    const stats = dimensionSignal(samples, key, minKnownSample);
    dimensionStats[key] = stats;
    const base = Number(NEEDLE_SCORE_WEIGHTS[key]);
    const multiplier = clamp(1 + stats.shrunkSignal * 1.5, 0.5, 1.75);
    rawWeights[key] = base * multiplier;
  }
  return {
    weights: normalizeAdaptiveWeights(rawWeights),
    dimensionStats,
  };
}

export function scoreNeedleDimensions(dimensions = {}, weights = NEEDLE_SCORE_WEIGHTS) {
  return Object.entries(weights).reduce((sum, [key, weight]) => {
    const score = finite(dimensions?.[key]?.score ?? dimensions?.[key]);
    return sum + clamp(score ?? 50, 0, 100) * Number(weight) / 100;
  }, 0);
}

function rankingMetrics(samples, weights) {
  if (!samples.length) {
    return {
      sample: 0,
      rankCorrelation: null,
      topQuartileSample: 0,
      topQuartileExpectancyR: null,
      topQuartileLossRate: null,
      runner3Recall: null,
      runner5Recall: null,
      runner10Recall: null,
    };
  }
  const scored = samples.map(sample => ({
    ...sample,
    score: scoreNeedleDimensions(sample.dimensions, weights),
  })).sort((a, b) => b.score - a.score);
  const topCount = Math.max(1, Math.ceil(scored.length * 0.25));
  const top = scored.slice(0, topCount);
  function recall(field) {
    const total = samples.filter(sample => sample[field] === 1).length;
    if (!total) return null;
    return top.filter(sample => sample[field] === 1).length / total;
  }
  return {
    sample: samples.length,
    rankCorrelation: spearman(scored.map(sample => sample.score), scored.map(sample => sample.utility)),
    topQuartileSample: top.length,
    topQuartileExpectancyR: average(top.map(sample => sample.realizedR)),
    topQuartileLossRate: top.length ? top.filter(sample => sample.realizedR < 0).length / top.length : null,
    runner3Recall: recall('runner3'),
    runner5Recall: recall('runner5'),
    runner10Recall: recall('runner10'),
  };
}

function nonWorse(challenger, active, tolerance = 0) {
  if (active == null || challenger == null) return true;
  return challenger >= active - tolerance;
}

export function calibrateNeedleRows(rows = [], {
  trainFraction = 0.70,
  minTotalSample = 60,
  minTrainSample = 40,
  minHoldoutSample = 20,
  minKnownSample = 20,
  minimumTopQuartileExpectancyDeltaR = 0.05,
} = {}) {
  const samples = rows.map(extractNeedleCalibrationSample)
    .filter(Boolean)
    .sort((a, b) => a.openedAtMs - b.openedAtMs || a.id - b.id);
  const splitIndex = Math.max(0, Math.min(samples.length, Math.floor(samples.length * clamp(trainFraction, 0.5, 0.85))));
  const train = samples.slice(0, splitIndex);
  const holdout = samples.slice(splitIndex);
  const fitted = fitNeedleChallengerWeights(train, { minKnownSample });
  const active = rankingMetrics(holdout, NEEDLE_SCORE_WEIGHTS);
  const challenger = rankingMetrics(holdout, fitted.weights);
  const expectancyDeltaR = active.topQuartileExpectancyR == null || challenger.topQuartileExpectancyR == null
    ? null
    : challenger.topQuartileExpectancyR - active.topQuartileExpectancyR;
  const enoughSample = samples.length >= minTotalSample
    && train.length >= minTrainSample
    && holdout.length >= minHoldoutSample;
  const performancePass = enoughSample
    && expectancyDeltaR != null
    && expectancyDeltaR >= minimumTopQuartileExpectancyDeltaR
    && nonWorse(challenger.rankCorrelation, active.rankCorrelation, 0.02)
    && nonWorse(challenger.runner5Recall, active.runner5Recall, 0.05)
    && nonWorse(challenger.runner10Recall, active.runner10Recall, 0.05);
  return {
    version: NEEDLE_CALIBRATION_VERSION,
    objective: 'expected-R + right-tail runner recall with loss-tail awareness',
    pointInTimeOnly: true,
    safetyImmutable: true,
    sample: samples.length,
    trainSample: train.length,
    holdoutSample: holdout.length,
    enoughSample,
    controlWeights: NEEDLE_SCORE_WEIGHTS,
    challengerWeights: fitted.weights,
    dimensionStats: fitted.dimensionStats,
    holdout: {
      active,
      challenger,
      expectancyDeltaR,
    },
    performancePass,
    promotionReady: performancePass,
    promotionPolicy: 'human-gated challenger only; never auto-promote to LIVE',
  };
}

export function buildNeedleCalibrationReport(options = {}) {
  return calibrateNeedleRows(loadNeedleCalibrationRows(options), options);
}
