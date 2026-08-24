import { qualityScoreCandidate } from './qualityScore.js';
import { estimateRunnerProbability } from './runnerModel.js';
import { estimateRouteEdge } from './routeEdgeModel.js';

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function combineEdgeAssessment({ quality, runner, route, momentumScore = null } = {}) {
  const qualityNorm = clamp(quality?.score ?? 50) / 100;
  const momentum = finite(momentumScore);
  const momentumNorm = momentum == null || momentum < 0 ? 0.5 : Math.max(0, Math.min(1, momentum));
  const runnerP = runner?.decisionEligible ? finite(runner.probability) : null;
  const routeP = route?.decisionEligible ? finite(route.pWin) : null;

  // Runner already consumes momentum/quality/flow buckets, and route+regime also
  // contains momentum/flow context. Do not pretend those correlated observations
  // are four independent votes. Probability models replace their input evidence
  // progressively as sufficient Research history becomes available.
  let opportunityProbability;
  let weights;
  let method;
  if (runnerP != null && routeP != null) {
    opportunityProbability = runnerP * 0.65 + routeP * 0.35;
    weights = { quality: 0, momentum: 0, runner: 0.65, route: 0.35 };
    method = 'runner_route';
  } else if (runnerP != null) {
    opportunityProbability = runnerP;
    weights = { quality: 0, momentum: 0, runner: 1, route: 0 };
    method = 'runner_only';
  } else if (routeP != null) {
    opportunityProbability = routeP * 0.75 + qualityNorm * 0.25;
    weights = { quality: 0.25, momentum: 0, runner: 0, route: 0.75 };
    method = 'route_quality_fallback';
  } else {
    opportunityProbability = momentumNorm * 0.55 + qualityNorm * 0.45;
    weights = { quality: 0.45, momentum: 0.55, runner: 0, route: 0 };
    method = 'descriptive_fallback';
  }

  const opportunityConfidence = clamp(opportunityProbability * 100);
  const availableModels = Number(runnerP != null) + Number(routeP != null);
  const evidenceQuality = availableModels === 2 && runner?.quality !== 'LOW' && route?.quality !== 'LOW'
    ? 'HIGH'
    : availableModels >= 1 ? 'MEDIUM' : 'LOW';

  return {
    version: 'edge-assessment-v1',
    opportunityProbability: Number(opportunityProbability.toFixed(4)),
    opportunityConfidence: Number(opportunityConfidence.toFixed(2)),
    expectedR: route?.decisionEligible && finite(route?.expectedR) != null ? Number(route.expectedR) : null,
    evidenceQuality,
    decisionEligible: availableModels > 0,
    method,
    weights,
  };
}

export function assessCandidateEdge(candidate = {}) {
  const quality = qualityScoreCandidate(candidate);
  let runner;
  let route;
  try {
    runner = estimateRunnerProbability(candidate, quality);
  } catch (error) {
    runner = {
      version: 'runner-path-bayes-v1',
      probability: null,
      sample: 0,
      decisionEligible: false,
      quality: 'LOW',
      error: error.message,
    };
  }
  try {
    route = estimateRouteEdge(candidate);
  } catch (error) {
    route = {
      version: 'route-edge-bayes-v1',
      pWin: null,
      expectedR: null,
      routeSample: 0,
      decisionEligible: false,
      quality: 'LOW',
      error: error.message,
    };
  }
  const combined = combineEdgeAssessment({
    quality,
    runner,
    route,
    momentumScore: candidate?.filters?.momentumScore,
  });
  return { quality, runner, route, combined };
}
