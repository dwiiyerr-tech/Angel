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

  // Missing models are neutral, never automatic vetoes. As Research accumulates
  // evidence the probability layers progressively replace neutral priors.
  const runnerEvidence = runnerP == null ? momentumNorm : runnerP;
  const routeEvidence = routeP == null ? 0.5 : routeP;
  const opportunityProbability = qualityNorm * 0.20
    + momentumNorm * 0.20
    + runnerEvidence * 0.35
    + routeEvidence * 0.25;

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
    weights: {
      quality: 0.20,
      momentum: 0.20,
      runner: 0.35,
      route: 0.25,
    },
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
