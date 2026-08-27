import { activeStrategy, numSetting, setting } from '../db/settings.js';
import { isRouteBlocked, parseBlockedRoutes } from './routePolicy.js';

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function effectivePositionSizeSol(strat, decision) {
  const base = Number(strat?.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1));
  if (decision?.verdict !== 'BUY') return base;
  const confidenceFraction = Math.max(0.1, Math.min(1, finite(decision?.confidence, 0) / 100));
  const edgeFraction = Math.max(0.05, Math.min(1, finite(decision?.recommended_size_fraction, 1)));
  return base * Math.min(confidenceFraction, edgeFraction);
}

export function rankCandidateDeterministically(row, { researchMode = false } = {}) {
  const candidate = row?.candidate || {};
  const admission = candidate?.edge?.admission || {};
  const blocked = isRouteBlocked(candidate, parseBlockedRoutes(setting('blocked_routes', '[]')));
  const safetyPassed = candidate?.contractSafety?.passed !== false;
  const filterPassed = candidate?.filters?.passed !== false;
  const action = String(admission.action || 'LEARN');
  const eligible = !blocked && safetyPassed && filterPassed
    && (action === 'GOOD' || (researchMode && action === 'LEARN'));
  const survival = finite(candidate?.edge?.survival?.probability, 0.5);
  const runner = finite(candidate?.edge?.runner?.probability, 0.3);
  const expectedR = finite(candidate?.edge?.route?.expectedR, 0);
  const quality = finite(candidate?.edge?.quality?.score ?? candidate?.filters?.qualityScore, 0);
  const domains = finite(candidate?.domainEvidence?.compositeScore, 0);
  const sourceCount = Math.min(3, finite(candidate?.signals?.sourceCount, 1));
  const score = (action === 'GOOD' ? 100 : 25)
    + survival * 30 + runner * 35 + Math.max(-1, Math.min(2, expectedR)) * 15
    + quality * 0.15 + domains * 0.15 + (sourceCount - 1) * 4;
  return {
    row,
    eligible,
    action,
    score: Number(score.toFixed(4)),
    diagnostics: { blocked, safetyPassed, filterPassed, survival, runner, expectedR, quality, domains, sourceCount },
  };
}

export function decideDeterministicBatch(rows = [], triggerCandidateId = null, { researchMode = false } = {}) {
  const strat = activeStrategy();
  const ranked = rows
    .map(row => rankCandidateDeterministically(row, { researchMode }))
    .filter(item => item.eligible)
    .sort((a, b) => b.score - a.score || Number(b.row.id) - Number(a.row.id));
  const selected = ranked[0] || null;
  if (!selected) {
    return {
      authority: 'deterministic_edge_v1', verdict: 'WATCH', confidence: 0,
      selected_candidate_id: null, selected_mint: null, selected_row: null,
      reason: `No candidate passed Safety + four-domain + calibrated Edge admission in batch triggered by #${triggerCandidateId}.`,
      risks: ['no_deterministic_edge'],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      recommended_size_fraction: 0,
      ranking: rows.map(row => rankCandidateDeterministically(row, { researchMode })),
    };
  }
  const c = selected.row.candidate;
  const learnProbe = selected.action === 'LEARN';
  const probabilityInputs = [
    finite(c?.edge?.survival?.probability),
    finite(c?.edge?.runner?.probability),
    finite(c?.edge?.combined?.opportunityProbability),
  ].filter(value => value != null);
  let confidence = probabilityInputs.length
    ? probabilityInputs.reduce((sum, value) => sum + value, 0) / probabilityInputs.length * 100
    : finite(c?.filters?.softScore, 0);
  confidence = learnProbe ? Math.min(35, Math.max(30, confidence)) : clamp(confidence, 40, 95);
  const recommendedFraction = learnProbe
    ? Math.min(0.15, numSetting('probe_entry_fraction', 0.15))
    : Math.max(0.05, Math.min(1, finite(c?.edge?.admission?.recommendedSizeFraction, 0.25)));
  return {
    authority: 'deterministic_edge_v1',
    verdict: 'BUY',
    confidence: Number(confidence.toFixed(2)),
    selected_candidate_id: selected.row.id,
    selected_mint: c?.token?.mint,
    selected_row: selected.row,
    reason: learnProbe
      ? 'PAPER learning probe: Safety passed, Edge is not yet statistically eligible; size is capped.'
      : `GOOD edge: ${c?.domainEvidence?.coreStrongCount || 0}/3 core domains confirmed; survival, runner and expected-R thresholds passed.`,
    risks: learnProbe ? ['insufficient_calibration_sample'] : [],
    suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
    suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
    recommended_size_fraction: recommendedFraction,
    edge_action: selected.action,
    ranking_score: selected.score,
    ranking: ranked.map(item => ({ candidateId: item.row.id, score: item.score, action: item.action, diagnostics: item.diagnostics })),
  };
}
