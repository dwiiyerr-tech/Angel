import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { configuredTradingMode } from '../research/policy.js';
import {
  canonicalJson,
  configVersionByNumber,
  controlPlaneContext,
  openStrategyProposal,
  proposalById,
  rollbackToParent,
} from './registry.js';
import { ensureControlPlaneSchema } from './schema.js';
import { isRouteBlocked } from '../pipeline/routePolicy.js';
import { executableDecisionPaths } from '../decisionIntelligence/learning.js';
import { replayPathPolicy, replayPolicyFromConfig } from '../learning/counterfactualReplay.js';
import { requestReleaseRollback } from '../release/rollbackRequest.js';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseBlockedRoutes(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function candidateNetBuyerRatio(candidate = {}) {
  const direct = finite(candidate?.flowAssessment?.netBuyerRatio);
  if (direct != null) return direct;
  const netBuyers = finite(candidate?.jupiterAsset?.stats5m?.numNetBuyers);
  const traders = finite(candidate?.jupiterAsset?.stats5m?.numTraders);
  if (netBuyers == null || traders == null || traders <= 0) return null;
  return netBuyers / traders;
}

export function evaluateEntryPolicy(candidate = {}, decision = {}, config = {}, { counterfactual = false } = {}) {
  const settings = config?.settings || {};
  const route = String(candidate?.signals?.route || 'unknown');
  const verdict = String(decision?.verdict || 'WATCH').toUpperCase();
  const confidence = finite(decision?.confidence) ?? 0;
  const blockedRoutes = new Set(parseBlockedRoutes(settings.blocked_routes));
  const confidenceFloor = finite(settings.llm_min_confidence) ?? 65;
  const opportunityFloor = finite(settings.min_opportunity_size_multiplier) ?? 0.35;
  const liquidityFloor = finite(settings.min_liquidity_usd) ?? 5000;
  const flowPriceFloor = finite(settings.flow_hard_price_change_pct) ?? -10;
  const flowNetFloor = finite(settings.flow_hard_net_buyer_ratio) ?? 0;
  const sourceWeight = finite(candidate?.filters?.sourceWeight) ?? 1;
  const liquidity = finite(candidate?.metrics?.liquidityUsd ?? candidate?.jupiterAsset?.liquidityUsd ?? candidate?.gmgn?.liquidity) ?? 0;
  const priceChange1h = finite(candidate?.flowAssessment?.priceChange1h ?? candidate?.jupiterAsset?.stats1h?.priceChange);
  const netBuyerRatio = candidateNetBuyerRatio(candidate);
  const evidence = { liquidity, priceChange1h, netBuyerRatio, liquidityFloor, flowPriceFloor, flowNetFloor };
  const safetyPassed = candidate?.contractSafety?.passed !== false;
  const filterPassed = candidate?.filters?.passed !== false;
  const quality = finite(candidate?.edge?.quality?.score ?? candidate?.filters?.qualityScore);
  const survival = candidate?.edge?.survival?.decisionEligible
    ? finite(candidate?.edge?.survival?.probability) : null;
  const runner = candidate?.edge?.runner?.decisionEligible
    ? finite(candidate?.edge?.runner?.probability) : null;
  const expectedR = candidate?.edge?.route?.decisionEligible
    ? finite(candidate?.edge?.route?.expectedR) : null;
  const thresholds = {
    quality: finite(settings.edge_min_quality_score) ?? 45,
    survival: finite(settings.edge_min_survival_probability) ?? 0.55,
    runner: finite(settings.edge_min_runner_probability) ?? 0.35,
    expectedR: finite(settings.edge_min_expected_r) ?? 0.15,
  };
  evidence.edge = { quality, survival, runner, expectedR, thresholds };

  if (!counterfactual && verdict !== 'BUY') return { eligible: false, reason: `verdict_${verdict.toLowerCase()}`, route, confidence, sourceWeight, evidence };
  if (!safetyPassed) return { eligible: false, reason: 'contract_safety_reject', route, confidence, sourceWeight, evidence };
  if (!filterPassed) return { eligible: false, reason: 'hard_filter_reject', route, confidence, sourceWeight, evidence };
  if (isRouteBlocked(candidate, blockedRoutes)) return { eligible: false, reason: 'blocked_route', route, confidence, sourceWeight, evidence };
  if (liquidity < liquidityFloor) return { eligible: false, reason: 'liquidity_below_floor', route, confidence, sourceWeight, evidence };
  if (priceChange1h != null && priceChange1h <= flowPriceFloor) return { eligible: false, reason: 'flow_severe_dump', route, confidence, sourceWeight, evidence };
  if (netBuyerRatio != null && netBuyerRatio < flowNetFloor) return { eligible: false, reason: 'flow_severe_selling', route, confidence, sourceWeight, evidence };
  const edgeConfidence = [survival, runner, finite(candidate?.edge?.combined?.opportunityProbability)]
    .filter(value => value != null);
  const replayConfidence = counterfactual && edgeConfidence.length
    ? edgeConfidence.reduce((sum, value) => sum + value, 0) / edgeConfidence.length * 100
    : confidence;
  if (replayConfidence < confidenceFloor) return { eligible: false, reason: 'confidence_below_floor', route, confidence: replayConfidence, sourceWeight, evidence };
  if (sourceWeight < opportunityFloor) return { eligible: false, reason: 'opportunity_below_floor', route, confidence, sourceWeight, evidence };
  if (counterfactual && (quality == null || survival == null || runner == null || expectedR == null)) {
    return { eligible: false, reason: 'edge_not_calibrated', route, confidence: replayConfidence, sourceWeight, evidence };
  }
  if (counterfactual && quality < thresholds.quality) return { eligible: false, reason: 'quality_below_floor', route, confidence: replayConfidence, sourceWeight, evidence };
  if (counterfactual && survival < thresholds.survival) return { eligible: false, reason: 'survival_below_floor', route, confidence: replayConfidence, sourceWeight, evidence };
  if (counterfactual && runner < thresholds.runner) return { eligible: false, reason: 'runner_below_floor', route, confidence: replayConfidence, sourceWeight, evidence };
  if (counterfactual && expectedR < thresholds.expectedR) return { eligible: false, reason: 'expected_r_below_floor', route, confidence: replayConfidence, sourceWeight, evidence };
  return { eligible: true, reason: 'eligible', route, confidence: replayConfidence, sourceWeight, evidence };
}

export function decorateCandidateControlPlane(candidate = {}) {
  const context = controlPlaneContext();
  candidate.controlPlane = context;
  return context;
}

export function recordChallengerObservation(candidateId, candidate = {}, decision = {}) {
  ensureControlPlaneSchema();
  const context = decorateCandidateControlPlane(candidate);
  const proposal = openStrategyProposal();
  if (!proposal || proposal.status !== 'testing') return null;
  const now = Date.now();
  if (proposal.test_until_ms && now > Number(proposal.test_until_ms)) {
    db.prepare("UPDATE strategy_proposals SET status = 'needs_extension' WHERE id = ? AND status = 'testing'").run(proposal.id);
    return null;
  }

  const control = configVersionByNumber(proposal.parent_version);
  const challenger = configVersionByNumber(proposal.proposed_version);
  if (!control || !challenger) return null;
  const activeResult = evaluateEntryPolicy(candidate, decision, control.config, { counterfactual: true });
  const challengerResult = evaluateEntryPolicy(candidate, decision, challenger.config, { counterfactual: true });
  const payload = {
    controlPlane: context,
    active: activeResult,
    challenger: challengerResult,
    edge: candidate?.edge?.combined || null,
    quality: candidate?.edge?.quality || null,
  };

  db.prepare(`
    INSERT INTO challenger_observations (
      proposal_id, candidate_id, mint, at_ms, route, verdict, confidence,
      active_eligible, challenger_eligible, active_reason, challenger_reason, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(proposal_id, candidate_id) DO UPDATE SET
      at_ms = excluded.at_ms,
      verdict = excluded.verdict,
      confidence = excluded.confidence,
      active_eligible = excluded.active_eligible,
      challenger_eligible = excluded.challenger_eligible,
      active_reason = excluded.active_reason,
      challenger_reason = excluded.challenger_reason,
      payload_json = excluded.payload_json
  `).run(
    proposal.id,
    Number(candidateId),
    String(candidate?.token?.mint || ''),
    now,
    activeResult.route,
    String(decision?.verdict || 'WATCH'),
    finite(decision?.confidence),
    activeResult.eligible ? 1 : 0,
    challengerResult.eligible ? 1 : 0,
    activeResult.reason,
    challengerResult.reason,
    canonicalJson(payload),
  );
  return { proposalId: proposal.id, active: activeResult, challenger: challengerResult };
}

function outcomeStats(rows, field, rField) {
  const selected = rows.filter(row => Number(row[field]) === 1 && finite(row[rField] ?? row.realized_r) != null);
  const wins = selected.filter(row => Number(row[rField] ?? row.realized_r) > 0).length;
  const sumR = selected.reduce((sum, row) => sum + Number(row[rField] ?? row.realized_r), 0);
  return {
    sample: selected.length,
    wins,
    winRate: selected.length ? wins / selected.length : null,
    expectancyR: selected.length ? sumR / selected.length : null,
  };
}

export function evaluateChallengerRows(rows = [], {
  minSample = 100,
  minRouteSample = 30,
  minAgeMs = 14 * 24 * 60 * 60 * 1000,
  startedAtMs = 0,
  nowMs = Date.now(),
  minimumExpectancyDeltaR = 0.05,
} = {}) {
  const active = outcomeStats(rows, 'active_eligible', 'active_realized_r');
  const challenger = outcomeStats(rows, 'challenger_eligible', 'challenger_realized_r');
  const expectancyDeltaR = active.expectancyR == null || challenger.expectancyR == null
    ? null
    : challenger.expectancyR - active.expectancyR;
  const winRateDelta = active.winRate == null || challenger.winRate == null
    ? null
    : challenger.winRate - active.winRate;
  const enoughSample = challenger.sample >= minSample;
  const routeSamples = Object.fromEntries([...new Set(rows.map(row => String(row.route || 'unknown')))]
    .map(route => [route, rows.filter(row => String(row.route || 'unknown') === route
      && Number(row.challenger_eligible) === 1
      && finite(row.challenger_realized_r ?? row.realized_r) != null).length]));
  const enoughRouteSample = Object.values(routeSamples).filter(sample => sample > 0)
    .every(sample => sample >= minRouteSample);
  const oldEnough = nowMs - Number(startedAtMs || 0) >= minAgeMs;
  const performancePass = challenger.expectancyR != null
    && challenger.expectancyR >= 0
    && (active.sample < minSample || expectancyDeltaR >= minimumExpectancyDeltaR)
    && (active.winRate == null || challenger.winRate >= active.winRate - 0.05);
  return {
    active,
    challenger,
    expectancyDeltaR,
    winRateDelta,
    minSample,
    enoughSample,
    oldEnough,
    performancePass,
    minRouteSample,
    routeSamples,
    enoughRouteSample,
    promotionReady: enoughSample && enoughRouteSample && oldEnough && performancePass,
  };
}

function changedSettingKeys(control = {}, challenger = {}) {
  const left = control?.settings || {};
  const right = challenger?.settings || {};
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => canonicalJson(left[key]) !== canonicalJson(right[key]));
}

function executableReplayRows(proposal, control, challenger) {
  const observations = db.prepare(`
    SELECT candidate_id, route FROM challenger_observations WHERE proposal_id = ?
  `).all(proposal.id);
  const byCandidate = new Map(observations.map(row => [Number(row.candidate_id), row]));
  const paths = executableDecisionPaths({ sinceMs: Number(proposal.test_started_at_ms || proposal.created_at_ms), limit: 10000 });
  const activeExitPolicy = replayPolicyFromConfig(control.config, `config-v${control.version}`);
  const challengerExitPolicy = replayPolicyFromConfig(challenger.config, `config-v${challenger.version}`);
  const insert = db.prepare(`
    INSERT INTO challenger_replays (
      proposal_id, candidate_id, receipt_id, computed_at_ms,
      active_config_version, challenger_config_version,
      active_eligible, challenger_eligible, active_r, challenger_r, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(proposal_id, receipt_id) DO UPDATE SET
      computed_at_ms = excluded.computed_at_ms,
      active_eligible = excluded.active_eligible,
      challenger_eligible = excluded.challenger_eligible,
      active_r = excluded.active_r,
      challenger_r = excluded.challenger_r,
      payload_json = excluded.payload_json
  `);
  const result = [];
  for (const path of paths) {
    const observed = byCandidate.get(Number(path.receipt.candidate_id));
    if (!observed) continue;
    const activeEntry = evaluateEntryPolicy(path.candidate, path.decision, control.config, { counterfactual: true });
    const challengerEntry = evaluateEntryPolicy(path.candidate, path.decision, challenger.config, { counterfactual: true });
    const activeExit = replayPathPolicy(path.observations, activeExitPolicy);
    const challengerExit = replayPathPolicy(path.observations, challengerExitPolicy);
    const row = {
      route: observed.route || path.receipt.route || 'unknown',
      active_eligible: activeEntry.eligible ? 1 : 0,
      challenger_eligible: challengerEntry.eligible ? 1 : 0,
      active_realized_r: activeEntry.eligible ? activeExit.exitR : null,
      challenger_realized_r: challengerEntry.eligible ? challengerExit.exitR : null,
      receipt_id: path.receipt.id,
      candidate_id: path.receipt.candidate_id,
      flow_telemetry_complete: path.observations.every(point => finite(point.buyerRatio) != null) ? 1 : 0,
    };
    const payload = { version: 'entry-exit-challenger-replay-v1', activeEntry, challengerEntry, activeExit, challengerExit };
    insert.run(
      proposal.id, row.candidate_id, row.receipt_id, Date.now(), control.version, challenger.version,
      row.active_eligible, row.challenger_eligible, row.active_realized_r, row.challenger_realized_r,
      canonicalJson(payload),
    );
    result.push(row);
  }
  return result;
}

export function evaluateChallenger(proposalId) {
  ensureControlPlaneSchema();
  const proposal = proposalById(proposalId);
  if (!proposal || !['testing', 'promotion_ready', 'needs_extension'].includes(proposal.status)) {
    throw new Error('Proposal is not in challenger evaluation state');
  }
  const control = configVersionByNumber(proposal.parent_version);
  const challenger = configVersionByNumber(proposal.proposed_version);
  const replayRows = control && challenger ? executableReplayRows(proposal, control, challenger) : [];
  const fallbackRows = db.prepare(`
    SELECT o.active_eligible, o.challenger_eligible, o.route, o.confidence,
           p.realized_r, p.pnl_percent
    FROM challenger_observations o
    LEFT JOIN dry_run_positions p
      ON p.candidate_id = o.candidate_id
     AND p.status = 'closed'
     AND p.execution_mode IN ('research', 'shadow_live')
    WHERE o.proposal_id = ?
  `).all(proposal.id);
  const rows = replayRows.length ? replayRows : fallbackRows;
  const evaluation = evaluateChallengerRows(rows, {
    minSample: Number(proposal.min_test_sample || 100),
    minRouteSample: Math.max(10, Math.floor(numSetting('control_plane_min_route_sample', 30))),
    minAgeMs: Math.max(14 * 24, numSetting('control_plane_min_test_hours', 14 * 24)) * 60 * 60 * 1000,
    startedAtMs: Number(proposal.test_started_at_ms || proposal.created_at_ms),
    minimumExpectancyDeltaR: numSetting('control_plane_min_expectancy_delta_r', 0.05),
  });
  const changedKeys = control && challenger ? changedSettingKeys(control.config, challenger.config) : [];
  const flowTelemetryCoverage = replayRows.length
    ? replayRows.filter(row => row.flow_telemetry_complete === 1).length / replayRows.length
    : 0;
  const unsupportedKeys = changedKeys.filter(key => key === 'runner_weakening_buyer_ratio'
    && flowTelemetryCoverage < 0.9);
  evaluation.replay = {
    version: 'entry-exit-challenger-replay-v1',
    source: replayRows.length ? 'decision_intelligence_executable_quotes' : 'closed_position_fallback',
    sample: replayRows.length,
    changedKeys,
    unsupportedKeys,
    flowTelemetryCoverage,
  };
  if (unsupportedKeys.length) evaluation.promotionReady = false;

  const now = Date.now();
  let nextStatus = proposal.status;
  if (evaluation.promotionReady) nextStatus = 'promotion_ready';
  else if (proposal.test_until_ms && now > Number(proposal.test_until_ms)) nextStatus = 'needs_extension';
  if (nextStatus !== proposal.status) {
    db.transaction(() => {
      db.prepare('UPDATE strategy_proposals SET status = ?, review_note = ? WHERE id = ?')
        .run(nextStatus, canonicalJson(evaluation), proposal.id);
      db.prepare('UPDATE config_versions SET status = ? WHERE version = ?')
        .run(nextStatus, proposal.proposed_version);
      db.prepare(`
        INSERT INTO config_events (at_ms, event_type, config_version, proposal_id, actor, payload_json)
        VALUES (?, 'challenger_evaluated', ?, ?, 'system', ?)
      `).run(now, proposal.proposed_version, proposal.id, canonicalJson({ nextStatus, evaluation }));
    })();
  }
  return { proposalId: proposal.id, status: nextStatus, ...evaluation };
}

export function evaluateActiveRollback(version = null) {
  ensureControlPlaneSchema();
  const active = version == null
    ? db.prepare("SELECT * FROM config_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1").get()
    : db.prepare('SELECT * FROM config_versions WHERE version = ?').get(Number(version));
  if (!active || active.parent_version == null || !active.promoted_at_ms) {
    return { eligible: false, reason: 'no_promoted_child_config' };
  }
  const rows = db.prepare(`
    SELECT realized_r, COALESCE(closed_at_ms, opened_at_ms) AS outcome_at_ms
    FROM dry_run_positions
    WHERE status = 'closed'
      AND execution_mode IN ('research', 'shadow_live')
      AND realized_r IS NOT NULL
      AND COALESCE(closed_at_ms, opened_at_ms) >= ?
      AND CAST(json_extract(snapshot_json, '$.candidate.controlPlane.activeVersion') AS INTEGER) = ?
  `).all(Number(active.promoted_at_ms), Number(active.version));
  const sample = rows.length;
  const expectancyR = sample ? rows.reduce((sum, row) => sum + Number(row.realized_r), 0) / sample : null;
  let equityR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const row of rows.sort((a, b) => Number(a.outcome_at_ms) - Number(b.outcome_at_ms))) {
    equityR += Number(row.realized_r);
    peakR = Math.max(peakR, equityR);
    maxDrawdownR = Math.min(maxDrawdownR, equityR - peakR);
  }
  const catastrophicRate = sample ? rows.filter(row => Number(row.realized_r) <= -2).length / sample : null;
  let baselineR = null;
  try {
    const evidence = JSON.parse(active.evidence_json || '{}');
    baselineR = finite(evidence?.paper?.expectancyR ?? evidence?.research?.expectancyR);
  } catch {}
  const minSample = Math.max(20, Math.floor(numSetting('control_plane_rollback_min_sample', 30)));
  const absoluteFloor = numSetting('control_plane_rollback_floor_r', -0.30);
  const maxDegradation = Math.max(0.1, numSetting('control_plane_rollback_degradation_r', 0.40));
  const enoughSample = sample >= minSample;
  const badAbsolute = expectancyR != null && expectancyR <= absoluteFloor;
  const badRelative = baselineR != null && expectancyR != null && expectancyR <= baselineR - maxDegradation;
  const badDrawdown = maxDrawdownR <= -Math.abs(numSetting('control_plane_rollback_max_drawdown_r', 5));
  const badCatastrophicRate = catastrophicRate != null
    && catastrophicRate >= numSetting('control_plane_rollback_catastrophic_rate', 0.20);
  return {
    eligible: true,
    version: Number(active.version),
    parentVersion: Number(active.parent_version),
    sample,
    minSample,
    expectancyR,
    baselineR,
    badAbsolute,
    badRelative,
    maxDrawdownR,
    catastrophicRate,
    badDrawdown,
    badCatastrophicRate,
    shouldRollback: enoughSample && (
      (badAbsolute && (baselineR == null || badRelative)) || badDrawdown || badCatastrophicRate
    ),
  };
}

export function runAutomaticRollbackCheck() {
  const mode = configuredTradingMode();
  if (mode !== 'paper') return { rolledBack: false, reason: 'deferred_outside_paper_mode' };
  const evaluation = evaluateActiveRollback();
  if (!evaluation.shouldRollback) return { rolledBack: false, evaluation };
  const reason = `automatic performance rollback: sample=${evaluation.sample}, expectancy=${Number(evaluation.expectancyR).toFixed(2)}R, baseline=${evaluation.baselineR == null ? 'n/a' : `${Number(evaluation.baselineR).toFixed(2)}R`}`;
  const active = rollbackToParent(evaluation.parentVersion, reason, 'automatic_performance_guard');
  const releaseRollback = requestReleaseRollback({ configVersion: evaluation.version, reason });
  return { rolledBack: true, evaluation, active, releaseRollback };
}
