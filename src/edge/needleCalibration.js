import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { safeJson } from '../utils.js';
import {
  BASE_NEEDLE_WEIGHTS,
  NEEDLE_ADAPTIVE_KEYS,
  NEEDLE_WEIGHT_BOUNDS,
  parseNeedleWeights,
  scoreNeedleDimensions,
} from './needleWeights.js';

export const NEEDLE_CALIBRATION_VERSION = 'needle-calibration-v1';

const RUNNER_THRESHOLDS = Object.freeze([
  Object.freeze({ r: 3, weight: 0.35 }),
  Object.freeze({ r: 5, weight: 0.35 }),
  Object.freeze({ r: 10, weight: 0.30 }),
]);

let cache = { at: 0, key: '', value: null };

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function observationWeight(dimension = {}) {
  if (dimension?.known === true) return 1;
  const coverage = finite(dimension?.coverage);
  if (coverage == null || coverage <= 0) return 0;
  return clamp(coverage / 100, 0, 1);
}

function weightedMean(rows, valueFn, weightFn) {
  let weighted = 0;
  let weight = 0;
  for (const row of rows) {
    const value = finite(valueFn(row));
    const w = Math.max(0, finite(weightFn(row)) ?? 0);
    if (value == null || w <= 0) continue;
    weighted += value * w;
    weight += w;
  }
  return weight > 0 ? { mean: weighted / weight, weight } : { mean: null, weight: 0 };
}

function dimensionThresholdLift(records, key, thresholdR, priorStrength) {
  const eligible = records.filter(record => finite(record?.dimensions?.[key]?.score) != null
    && observationWeight(record?.dimensions?.[key]) > 0
    && finite(record?.mfeR) != null);
  const positives = eligible.filter(record => Number(record.mfeR) >= thresholdR);
  const negatives = eligible.filter(record => Number(record.mfeR) < thresholdR);
  const positive = weightedMean(positives,
    record => record.dimensions[key].score,
    record => observationWeight(record.dimensions[key]));
  const negative = weightedMean(negatives,
    record => record.dimensions[key].score,
    record => observationWeight(record.dimensions[key]));
  const totalWeight = positive.weight + negative.weight;
  if (positive.mean == null || negative.mean == null || positive.weight < 2 || negative.weight < 2) {
    return {
      thresholdR,
      lift: 0,
      reliability: 0,
      positiveMean: positive.mean,
      negativeMean: negative.mean,
      positiveWeight: positive.weight,
      negativeWeight: negative.weight,
      sampleWeight: totalWeight,
    };
  }
  const eventRate = positive.weight / totalWeight;
  const balance = Math.sqrt(Math.max(0, 4 * eventRate * (1 - eventRate)));
  const reliability = totalWeight / (totalWeight + Math.max(1, Number(priorStrength) || 1));
  const rawLift = (positive.mean - negative.mean) / 100;
  const lift = clamp(rawLift * reliability * balance, -0.5, 0.5);
  return {
    thresholdR,
    lift,
    rawLift,
    reliability,
    eventRate,
    positiveMean: positive.mean,
    negativeMean: negative.mean,
    positiveWeight: positive.weight,
    negativeWeight: negative.weight,
    sampleWeight: totalWeight,
  };
}

function dimensionSkill(records, key, priorStrength) {
  const thresholds = RUNNER_THRESHOLDS.map(definition => ({
    ...dimensionThresholdLift(records, key, definition.r, priorStrength),
    thresholdWeight: definition.weight,
  }));
  const skill = thresholds.reduce((sum, row) => sum + Number(row.lift || 0) * row.thresholdWeight, 0);
  const reliability = thresholds.reduce((sum, row) => sum + Number(row.reliability || 0) * row.thresholdWeight, 0);
  return { key, skill, reliability, thresholds };
}

function rebalanceAdaptive(input, reference = BASE_NEEDLE_WEIGHTS) {
  const weights = { safety: BASE_NEEDLE_WEIGHTS.safety };
  for (const key of NEEDLE_ADAPTIVE_KEYS) {
    const [min, max] = NEEDLE_WEIGHT_BOUNDS[key];
    weights[key] = clamp(finite(input?.[key]) ?? reference[key], min, max);
  }

  const targetTotal = 100 - BASE_NEEDLE_WEIGHTS.safety;
  for (let pass = 0; pass < 12; pass += 1) {
    const current = NEEDLE_ADAPTIVE_KEYS.reduce((sum, key) => sum + weights[key], 0);
    const diff = targetTotal - current;
    if (Math.abs(diff) < 1e-7) break;
    const candidates = NEEDLE_ADAPTIVE_KEYS.filter(key => {
      const [min, max] = NEEDLE_WEIGHT_BOUNDS[key];
      return diff > 0 ? weights[key] < max - 1e-9 : weights[key] > min + 1e-9;
    });
    if (!candidates.length) break;
    const denominator = candidates.reduce((sum, key) => sum + Math.max(0.01, Number(reference[key]) || 0.01), 0);
    for (const key of candidates) {
      const [min, max] = NEEDLE_WEIGHT_BOUNDS[key];
      const share = Math.max(0.01, Number(reference[key]) || 0.01) / denominator;
      weights[key] = clamp(weights[key] + diff * share, min, max);
    }
  }

  const rounded = Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Number(value.toFixed(4))]));
  const residual = 100 - Object.values(rounded).reduce((sum, value) => sum + value, 0);
  if (Math.abs(residual) > 1e-9) {
    const key = NEEDLE_ADAPTIVE_KEYS.find(name => {
      const [min, max] = NEEDLE_WEIGHT_BOUNDS[name];
      const next = rounded[name] + residual;
      return next >= min && next <= max;
    });
    if (key) rounded[key] = Number((rounded[key] + residual).toFixed(4));
  }
  return rounded;
}

function derivedTargetWeights(training, priorWeights, priorStrength) {
  const diagnostics = {};
  const raw = {};
  for (const key of NEEDLE_ADAPTIVE_KEYS) {
    const skill = dimensionSkill(training, key, priorStrength);
    diagnostics[key] = skill;
    const factor = clamp(1 + skill.skill * 2.5, 0.60, 1.60);
    raw[key] = Number(priorWeights[key]) * factor;
  }
  return {
    weights: rebalanceAdaptive(raw, priorWeights),
    diagnostics,
  };
}

function blendWeights(priorWeights, targetWeights, blend) {
  const mixed = {};
  for (const key of NEEDLE_ADAPTIVE_KEYS) {
    mixed[key] = Number(priorWeights[key]) * (1 - blend) + Number(targetWeights[key]) * blend;
  }
  return rebalanceAdaptive(mixed, priorWeights);
}

export function runnerOutcomeUtility(record = {}) {
  const mfeR = finite(record.mfeR);
  if (mfeR == null) return null;
  let runnerUtility = 0;
  if (mfeR >= 10) runnerUtility = 1;
  else if (mfeR >= 5) runnerUtility = 0.72;
  else if (mfeR >= 3) runnerUtility = 0.42;

  const maeR = finite(record.maeR);
  let pathQuality = 1;
  if (maeR != null && maeR < -1) pathQuality = clamp(1 - (Math.abs(maeR) - 1) * 0.15, 0.55, 1);
  return runnerUtility * pathQuality;
}

function rankingStats(records, weights, topFraction = 0.25) {
  const scored = records
    .filter(record => record?.dimensions && finite(record.mfeR) != null)
    .map(record => ({ ...record, needleScore: scoreNeedleDimensions(record.dimensions, weights) }))
    .sort((a, b) => b.needleScore - a.needleScore || Number(a.closedAtMs || 0) - Number(b.closedAtMs || 0));
  if (!scored.length) {
    return {
      sample: 0,
      topSample: 0,
      runner3Rate: null,
      runner5Rate: null,
      runner10Rate: null,
      weightedRunnerIndex: null,
      meanUtility: null,
      expectancyR: null,
      meanMfeR: null,
    };
  }
  const topCount = Math.min(scored.length, Math.max(5, Math.ceil(scored.length * topFraction)));
  const top = scored.slice(0, topCount);
  const runnerRate = threshold => top.filter(row => Number(row.mfeR) >= threshold).length / top.length;
  const utilities = top.map(runnerOutcomeUtility).filter(value => value != null);
  const realized = top.map(row => finite(row.realizedR)).filter(value => value != null);
  const mfes = top.map(row => finite(row.mfeR)).filter(value => value != null);
  const runner3Rate = runnerRate(3);
  const runner5Rate = runnerRate(5);
  const runner10Rate = runnerRate(10);
  return {
    sample: scored.length,
    topSample: top.length,
    runner3Rate,
    runner5Rate,
    runner10Rate,
    weightedRunnerIndex: runner3Rate * 0.35 + runner5Rate * 0.35 + runner10Rate * 0.30,
    meanUtility: utilities.length ? utilities.reduce((sum, value) => sum + value, 0) / utilities.length : null,
    expectancyR: realized.length ? realized.reduce((sum, value) => sum + value, 0) / realized.length : null,
    meanMfeR: mfes.length ? mfes.reduce((sum, value) => sum + Math.min(20, value), 0) / mfes.length : null,
  };
}

function comparableLift(challenger, active, key) {
  const c = finite(challenger?.[key]);
  const a = finite(active?.[key]);
  return c == null || a == null ? null : c - a;
}

export function evaluateNeedleWeightComparison(records = [], activeWeights = BASE_NEEDLE_WEIGHTS, challengerWeights = BASE_NEEDLE_WEIGHTS, {
  minSample = 30,
  minAgeMs = 24 * 60 * 60 * 1000,
  startedAtMs = 0,
  nowMs = Date.now(),
  minUtilityLift = 0.01,
} = {}) {
  const active = rankingStats(records, activeWeights);
  const challenger = rankingStats(records, challengerWeights);
  const utilityLift = comparableLift(challenger, active, 'meanUtility');
  const runner3Lift = comparableLift(challenger, active, 'runner3Rate');
  const runner5Lift = comparableLift(challenger, active, 'runner5Rate');
  const runner10Lift = comparableLift(challenger, active, 'runner10Rate');
  const weightedRunnerLift = comparableLift(challenger, active, 'weightedRunnerIndex');
  const expectancyDeltaR = comparableLift(challenger, active, 'expectancyR');
  const enoughSample = challenger.sample >= minSample;
  const oldEnough = nowMs - Number(startedAtMs || 0) >= minAgeMs;
  const performancePass = utilityLift != null
    && utilityLift >= minUtilityLift
    && (runner3Lift == null || runner3Lift >= -0.02)
    && (weightedRunnerLift == null || weightedRunnerLift >= 0)
    && (expectancyDeltaR == null || expectancyDeltaR >= -0.15);
  return {
    active,
    challenger,
    utilityLift,
    runner3Lift,
    runner5Lift,
    runner10Lift,
    weightedRunnerLift,
    expectancyDeltaR,
    minSample,
    enoughSample,
    oldEnough,
    performancePass,
    promotionReady: enoughSample && oldEnough && performancePass,
  };
}

export function calibrateNeedleWeightsFromRecords(records = [], priorWeights = BASE_NEEDLE_WEIGHTS, {
  minSample = 80,
  minValidation = 20,
  trainFraction = 0.70,
  priorStrength = 60,
  maxBlend = 0.45,
  minUtilityLift = 0.015,
} = {}) {
  const prior = parseNeedleWeights(priorWeights, BASE_NEEDLE_WEIGHTS);
  const usable = records
    .filter(record => record?.dimensions && finite(record.mfeR) != null)
    .sort((a, b) => Number(a.closedAtMs || 0) - Number(b.closedAtMs || 0));
  const enoughSample = usable.length >= minSample;
  const minimumTrain = Math.max(20, minSample - minValidation);
  let trainCount = Math.floor(usable.length * clamp(trainFraction, 0.5, 0.85));
  trainCount = Math.max(minimumTrain, trainCount);
  trainCount = Math.min(Math.max(0, usable.length - minValidation), trainCount);
  const training = usable.slice(0, trainCount);
  const validation = usable.slice(trainCount);

  if (!enoughSample || training.length < 20 || validation.length < minValidation) {
    return {
      version: NEEDLE_CALIBRATION_VERSION,
      usableSample: usable.length,
      trainingSample: training.length,
      validationSample: validation.length,
      minSample,
      minValidation,
      enoughSample: false,
      suggestionReady: false,
      promotionReady: false,
      blend: 0,
      priorWeights: prior,
      targetWeights: prior,
      challengerWeights: prior,
      diagnostics: {},
      validation: evaluateNeedleWeightComparison(validation, prior, prior, { minSample: minValidation, minAgeMs: 0 }),
    };
  }

  const target = derivedTargetWeights(training, prior, priorStrength);
  const reliability = training.length / (training.length + Math.max(1, priorStrength));
  const blend = Math.min(clamp(maxBlend, 0.05, 0.75), clamp(maxBlend, 0.05, 0.75) * reliability);
  const challengerWeights = blendWeights(prior, target.weights, blend);
  const maxWeightChange = Math.max(...NEEDLE_ADAPTIVE_KEYS.map(key => Math.abs(challengerWeights[key] - prior[key])));
  const validationEvaluation = evaluateNeedleWeightComparison(validation, prior, challengerWeights, {
    minSample: minValidation,
    minAgeMs: 0,
    minUtilityLift,
  });
  const suggestionReady = maxWeightChange >= 0.20;

  return {
    version: NEEDLE_CALIBRATION_VERSION,
    usableSample: usable.length,
    trainingSample: training.length,
    validationSample: validation.length,
    minSample,
    minValidation,
    enoughSample: true,
    suggestionReady,
    promotionReady: suggestionReady && validationEvaluation.performancePass,
    blend: Number(blend.toFixed(4)),
    maxWeightChange: Number(maxWeightChange.toFixed(4)),
    priorWeights: prior,
    targetWeights: target.weights,
    challengerWeights,
    diagnostics: target.diagnostics,
    validation: validationEvaluation,
    historyStartMs: Number(usable[0]?.closedAtMs || 0) || null,
    historyEndMs: Number(usable[usable.length - 1]?.closedAtMs || 0) || null,
  };
}

function calibrationRecords(limit) {
  const rows = db.prepare(`
    SELECT id, closed_at_ms, mfe_r, mae_r, realized_r, snapshot_json
    FROM dry_run_positions
    WHERE execution_mode = 'research'
      AND status = 'closed'
      AND mfe_r IS NOT NULL
      AND snapshot_json IS NOT NULL
    ORDER BY COALESCE(closed_at_ms, opened_at_ms) DESC
    LIMIT ?
  `).all(limit).reverse();

  return rows.map(row => {
    const snapshot = safeJson(row.snapshot_json, {});
    const needle = snapshot?.candidate?.needle;
    const dimensions = needle?.dimensions;
    if (!dimensions || typeof dimensions !== 'object') return null;
    return {
      id: Number(row.id),
      closedAtMs: Number(row.closed_at_ms || 0),
      mfeR: finite(row.mfe_r),
      maeR: finite(row.mae_r),
      realizedR: finite(row.realized_r),
      needleVersion: needle?.version || null,
      dimensions,
    };
  }).filter(Boolean);
}

export function needleCalibrationSnapshot(priorWeights = BASE_NEEDLE_WEIGHTS) {
  const prior = parseNeedleWeights(priorWeights, BASE_NEEDLE_WEIGHTS);
  const settings = {
    historyLimit: Math.max(100, Math.min(5000, Math.floor(numSetting('needle_calibration_history_limit', 2000)))),
    minSample: Math.max(40, Math.floor(numSetting('needle_calibration_min_sample', 80))),
    minValidation: Math.max(10, Math.floor(numSetting('needle_calibration_min_validation', 20))),
    trainFraction: clamp(numSetting('needle_calibration_train_fraction', 0.70), 0.5, 0.85),
    priorStrength: Math.max(10, numSetting('needle_calibration_prior_strength', 60)),
    maxBlend: clamp(numSetting('needle_calibration_max_blend', 0.45), 0.05, 0.75),
    minUtilityLift: clamp(numSetting('needle_calibration_min_utility_lift', 0.015), 0, 0.20),
  };
  const ttl = Math.max(0, Math.min(5 * 60_000, Math.floor(numSetting('needle_calibration_cache_ms', 30_000))));
  const key = JSON.stringify({ prior, settings });
  if (cache.value && cache.key === key && ttl > 0 && Date.now() - cache.at <= ttl) return cache.value;
  try {
    const value = calibrateNeedleWeightsFromRecords(calibrationRecords(settings.historyLimit), prior, settings);
    cache = { at: Date.now(), key, value };
    return value;
  } catch (error) {
    const value = {
      version: NEEDLE_CALIBRATION_VERSION,
      usableSample: 0,
      enoughSample: false,
      suggestionReady: false,
      promotionReady: false,
      blend: 0,
      priorWeights: prior,
      targetWeights: prior,
      challengerWeights: prior,
      diagnostics: {},
      error: error.message,
    };
    cache = { at: Date.now(), key, value };
    return value;
  }
}

export function resetNeedleCalibrationCacheForTests() {
  cache = { at: 0, key: '', value: null };
}
