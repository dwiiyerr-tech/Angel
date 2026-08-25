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

export function evaluateEntryPolicy(candidate = {}, decision = {}, config = {}) {
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

  if (verdict !== 'BUY') return { eligible: false, reason: `verdict_${verdict.toLowerCase()}`, route, confidence, sourceWeight, evidence };
  if (blockedRoutes.has(route)) return { eligible: false, reason: 'blocked_route', route, confidence, sourceWeight, evidence };
  if (liquidity < liquidityFloor) return { eligible: false, reason: 'liquidity_below_floor', route, confidence, sourceWeight, evidence };
  if (priceChange1h != null && priceChange1h <= flowPriceFloor) return { eligible: false, reason: 'flow_severe_dump', route, confidence, sourceWeight, evidence };
  if (netBuyerRatio != null && netBuyerRatio < flowNetFloor) return { eligible: false, reason: 'flow_severe_selling', route, confidence, sourceWeight, evidence };
  if (confidence < confidenceFloor) return { eligible: false, reason: 'confidence_below_floor', route, confidence, sourceWeight, evidence };
  if (sourceWeight < opportunityFloor) return { eligible: false, reason: 'opportunity_below_floor', route, confidence, sourceWeight, evidence };
  return { eligible: true, reason: 'eligible', route, confidence, sourceWeight, evidence };
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
  const activeResult = evaluateEntryPolicy(candidate, decision, control.config);
  const challengerResult = evaluateEntryPolicy(candidate, decision, challenger.config);
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

function outcomeStats(rows, field) {
  const selected = rows.filter(row => Number(row[field]) === 1 && finite(row.realized_r) != null);
  const wins = selected.filter(row => Number(row.realized_r) > 0).length;
  const sumR = selected.reduce((sum, row) => sum + Number(row.realized_r), 0);
  return {
    sample: selected.length,
    wins,
    winRate: selected.length ? wins / selected.length : null,
    expectancyR: selected.length ? sumR / selected.length : null,
  };
}

export function evaluateChallengerRows(rows = [], {
  minSample = 30,
  minAgeMs = 24 * 60 * 60 * 1000,
  startedAtMs = 0,
  nowMs = Date.now(),
  minimumExpectancyDeltaR = 0.05,
} = {}) {
  const active = outcomeStats(rows, 'active_eligible');
  const challenger = outcomeStats(rows, 'challenger_eligible');
  const expectancyDeltaR = active.expectancyR == null || challenger.expectancyR == null
    ? null
    : challenger.expectancyR - active.expectancyR;
  const winRateDelta = active.winRate == null || challenger.winRate == null
    ? null
    : challenger.winRate - active.winRate;
  const enoughSample = challenger.sample >= minSample;
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
    promotionReady: enoughSample && oldEnough && performancePass,
  };
}

export function evaluateChallenger(proposalId) {
  ensureControlPlaneSchema();
  const proposal = proposalById(proposalId);
  if (!proposal || !['testing', 'promotion_ready', 'needs_extension'].includes(proposal.status)) {
    throw new Error('Proposal is not in challenger evaluation state');
  }
  const rows = db.prepare(`
    SELECT o.active_eligible, o.challenger_eligible, o.route, o.confidence,
           p.realized_r, p.pnl_percent
    FROM challenger_observations o
    LEFT JOIN dry_run_positions p
      ON p.candidate_id = o.candidate_id
     AND p.status = 'closed'
     AND p.execution_mode IN ('research', 'shadow_live')
    WHERE o.proposal_id = ?
  `).all(proposal.id);
  const evaluation = evaluateChallengerRows(rows, {
    minSample: Number(proposal.min_test_sample || 30),
    minAgeMs: Math.max(0, numSetting('control_plane_min_test_hours', 24)) * 60 * 60 * 1000,
    startedAtMs: Number(proposal.test_started_at_ms || proposal.created_at_ms),
    minimumExpectancyDeltaR: numSetting('control_plane_min_expectancy_delta_r', 0.05),
  });

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
    SELECT realized_r
    FROM dry_run_positions
    WHERE status = 'closed'
      AND execution_mode IN ('research', 'shadow_live')
      AND realized_r IS NOT NULL
      AND COALESCE(closed_at_ms, opened_at_ms) >= ?
      AND CAST(json_extract(snapshot_json, '$.candidate.controlPlane.activeVersion') AS INTEGER) = ?
  `).all(Number(active.promoted_at_ms), Number(active.version));
  const sample = rows.length;
  const expectancyR = sample ? rows.reduce((sum, row) => sum + Number(row.realized_r), 0) / sample : null;
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
    shouldRollback: enoughSample && badAbsolute && (baselineR == null || badRelative),
  };
}

export function runAutomaticRollbackCheck() {
  const mode = configuredTradingMode();
  if (mode !== 'paper') return { rolledBack: false, reason: 'deferred_outside_paper_mode' };
  const evaluation = evaluateActiveRollback();
  if (!evaluation.shouldRollback) return { rolledBack: false, evaluation };
  const reason = `automatic performance rollback: sample=${evaluation.sample}, expectancy=${Number(evaluation.expectancyR).toFixed(2)}R, baseline=${evaluation.baselineR == null ? 'n/a' : `${Number(evaluation.baselineR).toFixed(2)}R`}`;
  const active = rollbackToParent(evaluation.parentVersion, reason, 'automatic_performance_guard');
  return { rolledBack: true, evaluation, active };
}
