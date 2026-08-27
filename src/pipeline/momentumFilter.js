import axios from 'axios';
import { setting } from '../db/settings.js';
import { assessCandidateEdge } from '../edge/edgeAssessment.js';
import { decorateCandidateControlPlane } from '../controlPlane/challenger.js';

const ML_SERVICE_PORT = process.env.ML_SERVICE_PORT || 8001;
const ML_SERVICE_URL = `http://127.0.0.1:${ML_SERVICE_PORT}/predict`;
const TIMEOUT_MS = 2000;
const DEFAULT_THRESHOLD = 0.5;

function attachEdgeEvidence(candidate, momentumScore) {
  candidate.filters = candidate.filters || {};
  candidate.filters.momentumScore = Number.isFinite(Number(momentumScore)) ? Number(momentumScore) : -1;
  try {
    const edge = assessCandidateEdge(candidate);
    candidate.edge = edge;
    candidate.filters.qualityScore = edge.quality.score;
    candidate.filters.survivalProbability = edge.survival.probability;
    candidate.filters.survivalProbabilityEligible = edge.survival.decisionEligible;
    candidate.filters.runnerProbability = edge.runner.probability;
    candidate.filters.runnerProbabilityEligible = edge.runner.decisionEligible;
    candidate.filters.routeWinProbability = edge.route.pWin;
    candidate.filters.routeExpectedR = edge.route.expectedR;
    candidate.filters.routeEdgeEligible = edge.route.decisionEligible;
    candidate.filters.edgeOpportunityProbability = edge.combined.opportunityProbability;
    candidate.filters.edgeOpportunityConfidence = edge.combined.opportunityConfidence;
    candidate.filters.edgeEvidenceQuality = edge.combined.evidenceQuality;
    candidate.filters.edgeAdmissionAction = edge.admission.action;
    candidate.filters.edgeAdmissionEligible = edge.admission.decisionEligible;
    candidate.filters.edgeRecommendedSizeFraction = edge.admission.recommendedSizeFraction;
  } catch (error) {
    candidate.edge = {
      version: 'edge-assessment-v2',
      error: error.message,
      quality: null,
      runner: null,
      route: null,
      combined: { decisionEligible: false, evidenceQuality: 'LOW' },
    };
  }
  try {
    decorateCandidateControlPlane(candidate);
  } catch (error) {
    candidate.controlPlane = { error: error.message, activeVersion: null, challengerVersion: null };
  }
  return candidate.edge;
}

/**
 * Score a candidate using the ML service.
 * Research remains fail-open, but unavailable ML is represented as score=-1
 * instead of fake bullish momentum. Money-grade modes remain fail-closed upstream.
 * Runner/Route edge evidence is attached after every outcome when possible.
 */
export async function momentumFilter(candidate, threshold = DEFAULT_THRESHOLD) {
  const startTime = Date.now();
  const mint = candidate.token?.mint?.slice(0, 8) || 'unknown';
  const failClosed = setting('trading_mode', 'dry_run') !== 'dry_run';

  // The current Momentum model was trained on GMGN price-history features. A
  // Jupiter spot price is not a substitute for those historical inputs.
  const price = candidate.gmgn?.price || {};
  if (!price.price && !price.price_1h) {
    console.log(`[momentum] ${mint}... model features unavailable — ${failClosed ? 'reject' : 'research pass'}`);
    const edge = attachEdgeEvidence(candidate, -1);
    return { passed: !failClosed, score: -1, reason: 'no_price_history_features', edge };
  }

  try {
    const res = await axios.post(ML_SERVICE_URL, { candidate }, { timeout: TIMEOUT_MS });
    const score = Number(res.data.momentum_score);

    if (!Number.isFinite(score) || score < 0) {
      console.error(`[momentum] ${mint}... ML error: ${res.data.error || 'unknown'} — ${failClosed ? 'reject' : 'research pass'}`);
      const edge = attachEdgeEvidence(candidate, -1);
      return { passed: !failClosed, score: -1, reason: res.data.error || 'invalid_momentum_score', edge };
    }

    const passed = score >= threshold;
    const latency = Date.now() - startTime;
    const edge = attachEdgeEvidence(candidate, score);

    if (!passed) {
      console.log(`[momentum] ${mint}... REJECTED score=${score.toFixed(3)} < ${threshold} (${latency}ms)`);
    } else {
      console.log(`[momentum] ${mint}... PASSED score=${score.toFixed(3)} (${latency}ms)`);
    }

    return { passed, score, latency, edge };
  } catch (err) {
    console.error(`[momentum] ${mint}... ML service failed: ${err.message} — ${failClosed ? 'reject' : 'research pass'}`);
    const edge = attachEdgeEvidence(candidate, -1);
    return { passed: !failClosed, score: -1, reason: err.message, edge };
  }
}
