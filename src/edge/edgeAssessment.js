import { qualityScoreCandidate } from './qualityScore.js';
import { estimateRunnerProbability } from './runnerModel.js';
import { estimateRouteEdge } from './routeEdgeModel.js';
import { estimateSurvivalProbability } from './survivalModel.js';
import { numSetting } from '../db/settings.js';

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function evaluateEdgeAdmission({ quality, survival, runner, route, domains = null } = {}, {
  minimumQuality = 45,
  minimumSurvivalProbability = 0.55,
  minimumRunnerProbability = 0.35,
  minimumExpectedR = 0.15,
} = {}) {
  const qualityScore = finite(quality?.score);
  const survivalP = survival?.decisionEligible ? finite(survival?.probability) : null;
  const runnerP = runner?.decisionEligible ? finite(runner?.probability) : null;
  const expectedR = route?.decisionEligible ? finite(route?.expectedR) : null;
  const missing = [];
  if (qualityScore == null) missing.push('quality');
  if (survivalP == null) missing.push('survival_model');
  if (runnerP == null) missing.push('runner_model');
  if (expectedR == null) missing.push('route_expected_r');
  if (domains && Number(domains.independentKnownCount || 0) < 2) missing.push('independent_domains');
  if (missing.length) {
    return {
      version: 'edge-admission-v1',
      action: 'LEARN',
      decisionEligible: false,
      recommendedSizeFraction: 0,
      reasons: missing.map(value => `missing:${value}`),
      thresholds: { minimumQuality, minimumSurvivalProbability, minimumRunnerProbability, minimumExpectedR },
    };
  }

  const reasons = [];
  if (qualityScore < minimumQuality) reasons.push(`quality:${qualityScore.toFixed(2)}<${minimumQuality}`);
  if (survivalP < minimumSurvivalProbability) reasons.push(`survival:${survivalP.toFixed(4)}<${minimumSurvivalProbability}`);
  if (runnerP < minimumRunnerProbability) reasons.push(`runner:${runnerP.toFixed(4)}<${minimumRunnerProbability}`);
  if (expectedR < minimumExpectedR) reasons.push(`expected_r:${expectedR.toFixed(4)}<${minimumExpectedR}`);
  if (domains && Number(domains.coreStrongCount || 0) < 2) {
    reasons.push(`domain_confirmation:${Number(domains.coreStrongCount || 0)}<2`);
  }
  if (domains?.flow?.score != null && Number(domains.flow.score) < 45) {
    reasons.push(`flow_domain:${Number(domains.flow.score).toFixed(2)}<45`);
  }
  if (reasons.length) {
    return {
      version: 'edge-admission-v1',
      action: 'REJECT',
      decisionEligible: true,
      recommendedSizeFraction: 0,
      reasons,
      thresholds: { minimumQuality, minimumSurvivalProbability, minimumRunnerProbability, minimumExpectedR },
    };
  }

  let recommendedSizeFraction = 0.25;
  if (survivalP >= 0.70 && runnerP >= 0.55 && expectedR >= 0.50) recommendedSizeFraction = 0.75;
  else if (survivalP >= 0.62 && runnerP >= 0.45 && expectedR >= 0.30) recommendedSizeFraction = 0.50;
  if (survivalP >= 0.78 && runnerP >= 0.65 && expectedR >= 0.80
      && survival?.quality === 'HIGH' && runner?.quality === 'HIGH' && route?.quality === 'HIGH') {
    recommendedSizeFraction = 1;
  }
  return {
    version: 'edge-admission-v1',
    action: 'GOOD',
    decisionEligible: true,
    recommendedSizeFraction,
    reasons: ['independent_survival_runner_ev_confirmed'],
    thresholds: { minimumQuality, minimumSurvivalProbability, minimumRunnerProbability, minimumExpectedR },
  };
}

export function combineEdgeAssessment({ quality, survival = null, runner, route, momentumScore = null } = {}) {
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
    version: 'edge-assessment-v2',
    opportunityProbability: Number(opportunityProbability.toFixed(4)),
    opportunityConfidence: Number(opportunityConfidence.toFixed(2)),
    survivalProbability: survival?.decisionEligible && finite(survival?.probability) != null
      ? Number(survival.probability)
      : null,
    expectedR: route?.decisionEligible && finite(route?.expectedR) != null ? Number(route.expectedR) : null,
    evidenceQuality,
    decisionEligible: availableModels > 0,
    method,
    weights,
  };
}

export function assessCandidateEdge(candidate = {}) {
  const quality = qualityScoreCandidate(candidate);
  let survival;
  let runner;
  let route;
  try {
    survival = estimateSurvivalProbability(candidate, quality);
  } catch (error) {
    survival = {
      version: 'survival-path-bayes-v1',
      probability: null,
      sample: 0,
      decisionEligible: false,
      quality: 'LOW',
      error: error.message,
    };
  }
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
    survival,
    runner,
    route,
    momentumScore: candidate?.filters?.momentumScore,
  });
  const admission = evaluateEdgeAdmission({ quality, survival, runner, route, domains: candidate?.domainEvidence }, {
    minimumQuality: numSetting('edge_min_quality_score', 45),
    minimumSurvivalProbability: numSetting('edge_min_survival_probability', 0.55),
    minimumRunnerProbability: numSetting('edge_min_runner_probability', 0.35),
    minimumExpectedR: numSetting('edge_min_expected_r', 0.15),
  });
  return { quality, survival, runner, route, combined, admission };
}
