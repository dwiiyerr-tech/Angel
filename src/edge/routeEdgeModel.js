import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { safeJson } from '../utils.js';
import { ensureResearchSchema } from '../research/schema.js';

const MODEL_VERSION = 'route-edge-bayes-v1';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function marketRegimeKey(candidate = {}) {
  const momentum = finite(candidate?.filters?.momentumScore);
  const priceChange1h = finite(candidate?.jupiterAsset?.stats1h?.priceChange);
  const buyerNet = finite(candidate?.jupiterAsset?.stats5m?.numNetBuyers);
  const traders = finite(candidate?.jupiterAsset?.stats5m?.numTraders);
  const buyerRatio = buyerNet != null && traders != null && traders > 0 ? buyerNet / traders : null;

  if ((momentum != null && momentum >= 0.65) && (priceChange1h == null || priceChange1h >= 0)
      && (buyerRatio == null || buyerRatio >= 0.1)) return 'hot';
  if ((momentum != null && momentum < 0.35) || (priceChange1h != null && priceChange1h < -5)
      || (buyerRatio != null && buyerRatio < -0.1)) return 'weak';
  return 'neutral';
}

function stats(records = []) {
  const valid = records.filter(row => Number.isFinite(Number(row.realizedR)));
  const sample = valid.length;
  if (!sample) return { sample: 0, wins: 0, winRate: null, expectancyR: null, sumR: 0 };
  const wins = valid.filter(row => Number(row.realizedR) > 0).length;
  const sumR = valid.reduce((sum, row) => sum + Number(row.realizedR), 0);
  return { sample, wins, winRate: wins / sample, expectancyR: sumR / sample, sumR };
}

function shrinkStats(segmentStats, priorStats, priorStrength) {
  const pPrior = priorStats?.winRate == null ? 0.5 : clamp01(priorStats.winRate);
  const rPrior = Number.isFinite(Number(priorStats?.expectancyR)) ? Number(priorStats.expectancyR) : 0;
  const strength = Math.max(1, Number(priorStrength) || 1);
  const n = segmentStats.sample;
  return {
    pWin: (segmentStats.wins + pPrior * strength) / (n + strength),
    expectedR: (segmentStats.sumR + rPrior * strength) / (n + strength),
    sample: n,
    rawWinRate: segmentStats.winRate,
    rawExpectancyR: segmentStats.expectancyR,
  };
}

export function estimateRouteEdgeFromRecords(records = [], {
  route = 'unknown',
  regime = 'neutral',
  priorStrength = 20,
  minRouteSample = 20,
  minRegimeSample = 10,
} = {}) {
  const allStats = stats(records);
  const routeRows = records.filter(row => String(row.route || 'unknown') === String(route || 'unknown'));
  const routeStats = stats(routeRows);
  const routePosterior = shrinkStats(routeStats, allStats, priorStrength);

  const regimeRows = routeRows.filter(row => String(row.regime || 'neutral') === String(regime || 'neutral'));
  const regimeStats = stats(regimeRows);
  const regimePrior = {
    winRate: routePosterior.pWin,
    expectancyR: routePosterior.expectedR,
  };
  const regimePosterior = shrinkStats(regimeStats, regimePrior, Math.max(5, Math.floor(priorStrength / 2)));

  const useRegime = regimeStats.sample >= minRegimeSample;
  const pWin = useRegime ? regimePosterior.pWin : routePosterior.pWin;
  const expectedR = useRegime ? regimePosterior.expectedR : routePosterior.expectedR;
  const decisionEligible = routeStats.sample >= minRouteSample;
  const quality = routeStats.sample >= Math.max(60, minRouteSample * 3)
    ? 'HIGH'
    : decisionEligible ? 'MEDIUM' : 'LOW';

  return {
    version: MODEL_VERSION,
    route,
    regime,
    pWin: Number(pWin.toFixed(4)),
    expectedR: Number(expectedR.toFixed(4)),
    routeSample: routeStats.sample,
    regimeSample: regimeStats.sample,
    totalSample: allStats.sample,
    minimumRouteSample: minRouteSample,
    minimumRegimeSample: minRegimeSample,
    decisionEligible,
    quality,
    sourceLevel: useRegime ? 'route_regime' : 'route',
    raw: {
      global: allStats,
      route: routeStats,
      routeRegime: regimeStats,
    },
  };
}

function researchEdgeRecords(limit = 2000) {
  ensureResearchSchema();
  const rows = db.prepare(`
    SELECT id, realized_r, snapshot_json
    FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'closed' AND realized_r IS NOT NULL
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(limit);

  return rows.map(row => {
    const snapshot = safeJson(row.snapshot_json, {});
    const candidate = snapshot?.candidate || {};
    return {
      id: Number(row.id),
      realizedR: Number(row.realized_r),
      route: String(snapshot?.signalRoute || candidate?.signals?.route || 'unknown'),
      regime: String(candidate?.edge?.route?.regime || marketRegimeKey(candidate)),
    };
  }).filter(row => Number.isFinite(row.realizedR));
}

export function estimateRouteEdge(candidate = {}) {
  const route = String(candidate?.signals?.route || 'unknown');
  const regime = marketRegimeKey(candidate);
  const priorStrength = Math.max(1, numSetting('route_edge_prior_strength', 20));
  const minRouteSample = Math.max(10, Math.floor(numSetting('route_edge_min_sample', 20)));
  const minRegimeSample = Math.max(5, Math.floor(numSetting('route_edge_regime_min_sample', 10)));
  const limit = Math.max(100, Math.min(5000, Math.floor(numSetting('route_edge_history_limit', 2000))));
  return estimateRouteEdgeFromRecords(researchEdgeRecords(limit), {
    route,
    regime,
    priorStrength,
    minRouteSample,
    minRegimeSample,
  });
}

export const ROUTE_EDGE_MODEL_VERSION = MODEL_VERSION;
