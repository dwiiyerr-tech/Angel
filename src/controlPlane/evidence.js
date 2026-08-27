import { db } from '../db/connection.js';
import { safeJson } from '../utils.js';
import { ensureResearchSchema } from '../research/schema.js';
import { summarizeLearningWindow } from '../learning/summary.js';
import { RUNNER_MODEL_VERSION } from '../edge/runnerModel.js';
import { ROUTE_EDGE_MODEL_VERSION } from '../edge/routeEdgeModel.js';
import { RESEARCH_SIMULATOR_VERSION } from '../research/engine.js';
import { compareReplayPolicies } from '../learning/counterfactualReplay.js';
import { executableDecisionPaths } from '../decisionIntelligence/learning.js';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values = []) {
  const clean = values.map(finite).filter(value => value != null).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function mean(values = []) {
  const clean = values.map(finite).filter(value => value != null);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function researchRoute(position) {
  const snapshot = safeJson(position.snapshot_json, {});
  return String(snapshot?.candidate?.signals?.primaryRoute || snapshot?.signalRoute || snapshot?.candidate?.signals?.route || 'unknown');
}

function configVersion(position) {
  const snapshot = safeJson(position.snapshot_json, {});
  const value = finite(snapshot?.candidate?.controlPlane?.activeVersion ?? snapshot?.controlPlane?.activeVersion);
  return value == null ? null : Math.floor(value);
}

function summarizeResearchRows(rows) {
  const closed = rows.filter(row => row.status === 'closed' && finite(row.realized_r) != null);
  const wins = closed.filter(row => Number(row.realized_r) > 0);
  const byRoute = new Map();
  const byConfigVersion = new Map();
  for (const row of closed) {
    const route = researchRoute(row);
    const routeStats = byRoute.get(route) || { route, count: 0, wins: 0, sumR: 0, mfe: [], mae: [] };
    routeStats.count += 1;
    routeStats.wins += Number(row.realized_r) > 0 ? 1 : 0;
    routeStats.sumR += Number(row.realized_r);
    if (finite(row.mfe_r) != null) routeStats.mfe.push(Number(row.mfe_r));
    if (finite(row.mae_r) != null) routeStats.mae.push(Number(row.mae_r));
    byRoute.set(route, routeStats);

    const version = configVersion(row);
    if (version != null) {
      const versionStats = byConfigVersion.get(version) || { version, count: 0, wins: 0, sumR: 0 };
      versionStats.count += 1;
      versionStats.wins += Number(row.realized_r) > 0 ? 1 : 0;
      versionStats.sumR += Number(row.realized_r);
      byConfigVersion.set(version, versionStats);
    }
  }

  return {
    closed: closed.length,
    wins: wins.length,
    winRate: closed.length ? wins.length / closed.length : null,
    expectancyR: mean(closed.map(row => row.realized_r)),
    medianR: median(closed.map(row => row.realized_r)),
    medianMfeR: median(closed.map(row => row.mfe_r)),
    medianMaeR: median(closed.map(row => row.mae_r)),
    averageCaptureEfficiency: mean(closed.map(row => {
      const realized = finite(row.realized_r);
      const mfe = finite(row.mfe_r);
      return realized != null && mfe != null && mfe > 0 ? realized / mfe : null;
    })),
    byRoute: [...byRoute.values()].map(item => ({
      route: item.route,
      count: item.count,
      winRate: item.count ? item.wins / item.count : null,
      expectancyR: item.count ? item.sumR / item.count : null,
      medianMfeR: median(item.mfe),
      medianMaeR: median(item.mae),
    })).sort((a, b) => Number(b.expectancyR || 0) - Number(a.expectancyR || 0)),
    byConfigVersion: [...byConfigVersion.values()].map(item => ({
      version: item.version,
      count: item.count,
      winRate: item.count ? item.wins / item.count : null,
      expectancyR: item.count ? item.sumR / item.count : null,
    })).sort((a, b) => a.version - b.version),
  };
}

export function buildStrategyEvidence(windowMs = 14 * 24 * 60 * 60 * 1000) {
  ensureResearchSchema();
  const safeWindowMs = Math.max(14 * 24 * 60 * 60 * 1000, Number(windowMs) || 14 * 24 * 60 * 60 * 1000);
  const cutoff = Date.now() - safeWindowMs;
  const researchRows = db.prepare(`
    SELECT id, candidate_id, status, closed_at_ms, opened_at_ms, realized_r, mfe_r, mae_r,
           time_to_mfe_ms, snapshot_json
    FROM dry_run_positions
    WHERE execution_mode = 'research'
      AND status = 'closed'
      AND COALESCE(closed_at_ms, opened_at_ms) >= ?
    ORDER BY closed_at_ms ASC
  `).all(cutoff);
  const research = summarizeResearchRows(researchRows);
  const executablePaths = executableDecisionPaths({ sinceMs: cutoff, limit: 10000 });
  const replayRows = executablePaths.map(path => compareReplayPolicies(path.observations))
    .filter(result => result.deltaR != null);
  const counterfactual = {
    version: 'v32-v33-executable-counterfactual-v2',
    methodology: 'decision-time Jupiter entry plus net executable exit quotes; discrete and gap-aware',
    sample: replayRows.length,
    verdictCoverage: Object.fromEntries(['BUY', 'WATCH', 'PASS'].map(verdict => [
      verdict,
      executablePaths.filter(path => path.receipt.verdict === verdict).length,
    ])),
    v32ExpectancyR: mean(replayRows.map(result => result.v32.exitR)),
    v33ExpectancyR: mean(replayRows.map(result => result.v33.exitR)),
    deltaExpectancyR: mean(replayRows.map(result => result.deltaR)),
  };

  let shadow;
  try {
    const summary = summarizeLearningWindow(safeWindowMs);
    shadow = {
      closed: Number(summary?.positions?.closed || 0),
      wins: Number(summary?.positions?.wins || 0),
      winRate: summary?.positions?.closed ? Number(summary.positions.wins || 0) / Number(summary.positions.closed) : null,
      expectancyPercent: summary?.positions?.expectancy?.expectancyPercent ?? null,
      profitFactor: summary?.positions?.expectancy?.profitFactor ?? null,
      byRoute: summary?.positions?.byRoute || [],
      dataQuality: summary?.dataQuality || null,
      learningEligible: summary?.dataQuality?.learningEligible === true,
      simulatorVersion: summary?.simulatorVersion || null,
    };
  } catch (error) {
    shadow = {
      closed: 0,
      wins: 0,
      winRate: null,
      expectancyPercent: null,
      profitFactor: null,
      byRoute: [],
      dataQuality: null,
      learningEligible: false,
      error: error.message,
    };
  }

  const totalClosed = research.closed + shadow.closed;
  const minimumProposalTrades = 100;
  return {
    version: 'strategy-evidence-v1',
    windowMs: safeWindowMs,
    fromMs: cutoff,
    toMs: Date.now(),
    totalClosed,
    minimumProposalTrades,
    proposalEligible: totalClosed >= minimumProposalTrades
      && (research.closed >= minimumProposalTrades || shadow.learningEligible),
    research,
    counterfactual,
    shadow,
    models: {
      runner: RUNNER_MODEL_VERSION,
      routeEdge: ROUTE_EDGE_MODEL_VERSION,
      researchSimulator: RESEARCH_SIMULATOR_VERSION,
    },
  };
}
