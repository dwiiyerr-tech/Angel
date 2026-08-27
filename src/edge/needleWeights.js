export const BASE_NEEDLE_WEIGHTS = Object.freeze({
  safety: 20,
  devQuality: 10,
  holderDistribution: 10,
  organicFlow: 15,
  liquidityStructure: 10,
  narrative: 7,
  earlyAsymmetry: 13,
  runnerProbability: 10,
  expectedR: 5,
});

export const NEEDLE_DIMENSION_KEYS = Object.freeze(Object.keys(BASE_NEEDLE_WEIGHTS));
export const NEEDLE_ADAPTIVE_KEYS = Object.freeze(NEEDLE_DIMENSION_KEYS.filter(key => key !== 'safety'));

export const NEEDLE_WEIGHT_BOUNDS = Object.freeze({
  safety: Object.freeze([20, 20]),
  devQuality: Object.freeze([4, 18]),
  holderDistribution: Object.freeze([4, 18]),
  organicFlow: Object.freeze([7, 25]),
  liquidityStructure: Object.freeze([4, 18]),
  narrative: Object.freeze([3, 14]),
  earlyAsymmetry: Object.freeze([6, 22]),
  runnerProbability: Object.freeze([4, 20]),
  expectedR: Object.freeze([2, 12]),
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function parsedWeights(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' ? value : null;
}

export function validateNeedleWeights(value, { requireExactTotal = true } = {}) {
  const parsed = parsedWeights(value);
  if (!parsed || Array.isArray(parsed)) throw new Error('needle weights must be a JSON object');
  const unknown = Object.keys(parsed).filter(key => !NEEDLE_DIMENSION_KEYS.includes(key));
  if (unknown.length) throw new Error(`unknown Needle weight key(s): ${unknown.join(', ')}`);

  const normalized = {};
  for (const key of NEEDLE_DIMENSION_KEYS) {
    const number = finite(parsed[key]);
    if (number == null) throw new Error(`missing or invalid Needle weight: ${key}`);
    const [min, max] = NEEDLE_WEIGHT_BOUNDS[key];
    if (number < min || number > max) {
      throw new Error(`Needle weight ${key} must remain within [${min}, ${max}]`);
    }
    normalized[key] = Number(number.toFixed(4));
  }

  if (Math.abs(normalized.safety - BASE_NEEDLE_WEIGHTS.safety) > 1e-9) {
    throw new Error(`Needle Safety weight is fixed at ${BASE_NEEDLE_WEIGHTS.safety}`);
  }
  const total = Object.values(normalized).reduce((sum, number) => sum + number, 0);
  if (requireExactTotal && Math.abs(total - 100) > 0.05) {
    throw new Error(`Needle weights must sum to 100, got ${total.toFixed(4)}`);
  }
  return normalized;
}

export function parseNeedleWeights(value, fallback = BASE_NEEDLE_WEIGHTS) {
  try {
    return validateNeedleWeights(value);
  } catch {
    return { ...fallback };
  }
}

export function scoreNeedleDimensions(dimensions = {}, weights = BASE_NEEDLE_WEIGHTS) {
  const validated = parseNeedleWeights(weights, BASE_NEEDLE_WEIGHTS);
  const score = NEEDLE_DIMENSION_KEYS.reduce((sum, key) => {
    const dimension = dimensions?.[key];
    const dimensionScore = finite(dimension?.score);
    const safeScore = clamp(dimensionScore == null ? 50 : dimensionScore, 0, 100);
    return sum + safeScore * validated[key] / 100;
  }, 0);
  return Number(clamp(score, 0, 100).toFixed(4));
}

export function needleEvidenceCoverage(dimensions = {}, weights = BASE_NEEDLE_WEIGHTS) {
  const validated = parseNeedleWeights(weights, BASE_NEEDLE_WEIGHTS);
  const coverage = NEEDLE_DIMENSION_KEYS.reduce((sum, key) => {
    const dimension = dimensions?.[key];
    const known = dimension?.known === true;
    const partial = clamp((finite(dimension?.coverage) ?? 0) / 100, 0, 1);
    return sum + validated[key] * (known ? 1 : partial);
  }, 0);
  return Number(clamp(coverage, 0, 100).toFixed(2));
}
