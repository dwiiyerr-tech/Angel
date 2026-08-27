import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting, setting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { upsertCandidate, updateCandidateStatus, updateCandidateSnapshot, recentEligibleCandidates, candidateById, latestCandidateByMint } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent, checkDecisionCache } from '../db/decisions.js';
import { buildCandidate, filterCandidate } from './candidateBuilder.js';
import { preScoreCandidate } from './preScorer.js';
import { momentumFilter } from './momentumFilter.js';
import { decideDeterministicBatch } from './deterministicDecision.js';
import { activeStrategy } from '../db/settings.js';
import { calculatePositionSizeSol, canOpenMorePositions, openPositionCount, tradingMode, tryReservePositionSlot, decrementPendingPosition } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { recordSignalProcessed } from '../health/deadMansSwitch.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy, assertSafeLiveDecision } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short, escapeHtml } from '../format.js';
import { evaluateMarketAllocator, allocationAllowsCandidate } from '../execution/marketAllocator.js';
import { applyContractSafetyGate } from '../execution/contractSafetyGate.js';
import { assertContractSafetyForMoneyMode } from '../execution/contractSafetyGate.js';
import { isResearchSimulationMode, requiresMoneyGradeEvidence } from '../research/policy.js';
import {
  executeResearchEntry,
  canOpenResearchPosition,
  openResearchPositionCount,
  researchPositionCap,
} from '../research/engine.js';
import { mergeCandidateEvidence } from './signalEvidence.js';
import { isRouteBlocked, parseBlockedRoutes } from './routePolicy.js';
import {
  isIndependentLateRoute,
  markEvidenceEventsProcessed,
  recordSignalEvidence,
  refreshLateEvidence,
} from './evidenceWindow.js';

// Fast-track bypass remains disabled. Research aggression comes from explicit
// policy and zero-capital sampling, never from skipping contract safety.
const TRACK_A_ROUTES = new Set([]);

export const seenSignalCandidates = new Map();
export const processingCandidates = new Set();
export const executingMints = new Set();
const pendingSignalEvidence = new Map();

function mergeRawSignals(target, incoming) {
  const routes = [...new Set([
    ...(target.signalRoutes || []), target.route,
    ...(incoming.signalRoutes || []), incoming.route,
  ].filter(Boolean))];
  const evidenceEventIds = [...new Set([
    ...(target._evidenceEventIds || []), ...(incoming._evidenceEventIds || []),
  ])];
  Object.assign(target, Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => value !== null && value !== undefined),
  ));
  target.signalRoutes = routes;
  target._evidenceEventIds = evidenceEventIds;
  target.route = routes.length > 1 ? 'dual_source' : routes[0];
  return target;
}

export function edgeAdmissionBlockReason(candidate, { researchMode = false } = {}) {
  const admission = candidate?.edge?.admission;
  if (researchMode) {
    if (!boolSetting('edge_admission_paper_enabled', true)) return null;
    // LEARN is intentionally admitted as a small PAPER probe so the models can
    // reach calibration sample minimums. An eligible REJECT is deterministic.
    return admission?.action === 'REJECT' ? `edge_reject:${(admission.reasons || []).join(',')}` : null;
  }
  if (!boolSetting('edge_admission_live_enabled', false)) return null;
  if (admission?.action !== 'GOOD') return `edge_not_good:${admission?.action || 'missing'}`;
  return null;
}

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

function researchFilterAdmission(candidate, researchMode) {
  const filters = candidate?.filters || {};
  if (!researchMode) return { allowed: filters.passed !== false, softFailures: [] };

  // Contract Safety is the catastrophic kernel and is never bypassed, even by a
  // zero-capital experiment. Everything else in filterCandidate is strategy or
  // statistical evidence and is useful to observe rather than censor.
  if (candidate?.contractSafety?.passed === false) {
    return { allowed: false, softFailures: [] };
  }

  const failures = Array.isArray(filters.failures) ? filters.failures.map(String) : [];
  const contractFailures = failures.filter(reason => reason.startsWith('contract safety:'));
  if (contractFailures.length > 0) return { allowed: false, softFailures: [] };

  const softFailures = failures.filter(reason => !reason.startsWith('contract safety:'));
  if (softFailures.length > 0) {
    candidate.researchFilterOverride = {
      policy: 'zero_capital_soft_filter_override_v1',
      softFailures,
      originalPassed: filters.passed !== false,
    };
    candidate.riskFlags = candidate.riskFlags || [];
    candidate.riskFlags.push({
      type: 'research_filter_override',
      severity: Math.min(4, Math.max(1, softFailures.length)),
      reason: softFailures.slice(0, 4).join('; '),
    });
  }
  return { allowed: true, softFailures };
}

function researchCapacity() {
  return {
    allowed: canOpenResearchPosition(),
    open: openResearchPositionCount(),
    max: researchPositionCap(),
  };
}

function executionCapacity() {
  return {
    allowed: canOpenMorePositions(),
    open: openPositionCount(),
    max: numSetting('max_open_positions', 3),
  };
}

function persistScreeningOutcome(candidateId, candidate, reason, {
  verdict = 'PASS',
  risks = [],
  category = 'screening_reject',
} = {}) {
  if (!candidateId || !candidate?.token?.mint) return null;
  const existing = db.prepare('SELECT id FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(candidateId);
  if (existing) return Number(existing.id);
  const strat = activeStrategy();
  const decision = {
    authority: 'deterministic_screening_v1',
    verdict,
    confidence: 0,
    selected_candidate_id: null,
    selected_mint: null,
    selected_row: null,
    reason: String(reason || category),
    risks: risks.map(String).slice(0, 8),
    rejection_category: category,
    suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
    suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
    recommended_size_fraction: 0,
    raw: null,
  };
  const id = storeDecision(candidateId, candidate, decision);
  updateCandidateStatus(candidateId, verdict.toLowerCase());
  return id;
}

function activeCapacity(researchMode) {
  return researchMode ? researchCapacity() : executionCapacity();
}

export async function processCandidateFromSignals(signals) {
  recordSignalProcessed();
  const evidenceEvent = recordSignalEvidence(signals);
  if (evidenceEvent?.id) {
    signals._evidenceEventIds = [...new Set([...(signals._evidenceEventIds || []), evidenceEvent.id])];
  }
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  if (processingCandidates.has(signals.mint)) {
    const pending = pendingSignalEvidence.get(signals.mint);
    if (pending) mergeRawSignals(pending, signals);
    return;
  }
  processingCandidates.add(signals.mint);
  const aggregate = mergeRawSignals({ mint: signals.mint }, signals);
  pendingSignalEvidence.set(signals.mint, aggregate);
  try {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, numSetting('signal_fanin_window_ms', 1500))));
    return await _processCandidateFromSignals(aggregate);
  } finally {
    pendingSignalEvidence.delete(signals.mint);
    processingCandidates.delete(signals.mint);
  }
}

async function _processCandidateFromSignals(signals) {
  const researchMode = isResearchSimulationMode();
  // PAPER follows the money-grade decision and market gates. Its execution
  // branch remains non-broadcast, but it must not get a better admission path
  // merely because the settlement currency is virtual.
  const paperLiveParity = researchMode && boolSetting('paper_live_parity_enabled', true);
  const strictPolicyMode = !researchMode || paperLiveParity;
  const strat = activeStrategy();
  const blockedRoutes = parseBlockedRoutes(setting('blocked_routes', '[]'));
  const adaptivelyBlockedRoute = isRouteBlocked(String(signals.route || ''), blockedRoutes);
  if (adaptivelyBlockedRoute && !researchMode) {
    console.log(`[agent] blocked route ${signals.route} for ${signals.mint.slice(0, 8)}...`);
    return;
  }
  if (adaptivelyBlockedRoute && researchMode) {
    console.log(`[research] observing adaptively-blocked route ${signals.route} for false-negative measurement; no capital is at risk`);
  }

  // Same-mint concurrent positions are forbidden for unambiguous accounting.
  // Research otherwise uses a short experiment cooldown rather than live bans.
  try {
    const openPos = db.prepare(
      `SELECT * FROM dry_run_positions
       WHERE mint = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
       LIMIT 1`
    ).get(signals.mint);
    if (openPos) {
      try {
        const late = await refreshLateEvidence(signals, { eventId: signals._evidenceEventIds?.at(-1) || null });
        console.log(late.updated
          ? `[evidence] refreshed active thesis for ${signals.mint.slice(0, 8)}... from late route ${signals.route}`
          : `[agent] active position ${signals.mint.slice(0, 8)}... received no independent late evidence`);
      } catch (error) {
        console.warn(`[evidence] active thesis refresh degraded for ${signals.mint.slice(0, 8)}...: ${error.message}`);
      }
      return;
    }

    if (researchMode && !paperLiveParity) {
      const researchCooldownMs = Math.max(0, numSetting('research_reentry_cooldown_minutes', 30)) * 60_000;
      if (researchCooldownMs > 0) {
        const recentResearch = db.prepare(`
          SELECT id, exit_reason, closed_at_ms FROM dry_run_positions
          WHERE mint = ? AND execution_mode = 'research' AND status = 'closed' AND closed_at_ms > ?
          ORDER BY closed_at_ms DESC LIMIT 1
        `).get(signals.mint, Date.now() - researchCooldownMs);
        if (recentResearch) {
          console.log(`[research] skipping ${signals.mint.slice(0, 8)}... — research cooldown active`);
          return;
        }
      }
    } else {
      const recentMs = Date.now() - 2 * 3600000;
      const closedPos = db.prepare(
        'SELECT id, exit_reason, closed_at_ms FROM dry_run_positions WHERE mint = ? AND status = ? AND closed_at_ms > ? ORDER BY closed_at_ms DESC LIMIT 1'
      ).get(signals.mint, 'closed', Date.now() - 4 * 60 * 60 * 1000);
      if (closedPos) {
        const hoursAgo = ((Date.now() - closedPos.closed_at_ms) / 3600000).toFixed(1);
        console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — recently closed (${hoursAgo}h ago, exit: ${closedPos.exit_reason})`);
        return;
      }

      const recentDecision = db.prepare(`
        SELECT id FROM llm_decisions
        WHERE mint = ? AND created_at_ms > ?
        LIMIT 1
      `).get(signals.mint, recentMs);
      const recentCandidate = latestCandidateByMint(signals.mint);
      const independentLateRoute = recentCandidate
        ? isIndependentLateRoute(signals, recentCandidate.candidate)
        : false;
      if (recentDecision && !independentLateRoute) {
        console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — deterministic decision exists (<2h)`);
        return;
      }
      if (recentDecision && independentLateRoute) {
        console.log(`[evidence] reopening ${signals.mint.slice(0, 8)}... for independent late route ${signals.route}`);
      }
    }
  } catch (err) {
    console.warn(`[agent] duplicate precheck degraded: ${err.message}`);
  }

  // Decision cache is an execution optimization, not a research truth source.
  if (strictPolicyMode) {
    const cachedDecision = checkDecisionCache(signals.mint, signals.mcap || null, signals.holders || null);
    const priorCandidate = latestCandidateByMint(signals.mint);
    const independentLateRoute = priorCandidate ? isIndependentLateRoute(signals, priorCandidate.candidate) : false;
    if (cachedDecision && !independentLateRoute) {
      const ageMin = ((now() - cachedDecision.cachedAt) / 60000).toFixed(1);
      console.log(`[cache-hit] ${signals.mint.slice(0, 8)}... — verdict ${cachedDecision.verdict} (cached ${ageMin}m ago, reason: ${cachedDecision.reason?.slice(0, 60) || 'n/a'})`);
      return;
    }
  }

  const previousRow = latestCandidateByMint(signals.mint);
  const recentPrevious = previousRow && Number(previousRow.created_at_ms) >= Date.now() - 10 * 60_000
    ? previousRow
    : null;
  let candidate = await buildCandidate(signals);
  if (recentPrevious) {
    candidate = mergeCandidateEvidence(recentPrevious.candidate, candidate);
    candidate.filters = filterCandidate(candidate);
    console.log(`[candidate] merged ${candidate.signals.sourceCount} independent routes for ${signals.mint.slice(0, 8)}...`);
  }
  const moneyMode = requiresMoneyGradeEvidence() || strictPolicyMode;
  await applyContractSafetyGate(candidate, {
    moneyMode,
    stage: 'screening',
    fetchRugcheck: moneyMode,
  });
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  markEvidenceEventsProcessed(signals._evidenceEventIds || [], candidateId);

  // Copycat history protects capital but should not censor zero-capital research.
  if (strictPolicyMode) {
    try {
      const symbol = candidate.token?.symbol;
      if (symbol) {
        const symbolPos = db.prepare(
          'SELECT id FROM dry_run_positions WHERE symbol = ? AND closed_at_ms > ? LIMIT 1'
        ).get(symbol, Date.now() - 86400000);
        if (symbolPos) {
          console.log(`[agent] skipping ${symbol} (${candidate.token.mint.slice(0, 8)}) — same symbol traded <24h ago`);
          persistScreeningOutcome(candidateId, candidate, 'same symbol traded within 24h', {
            category: 'copycat_cooldown', risks: ['same_symbol_recent_trade'],
          });
          return;
        }
      }
    } catch (err) {
      console.warn(`[agent] symbol dedup degraded: ${err.message}`);
    }
  }

  const filterAdmission = researchFilterAdmission(candidate, researchMode && !paperLiveParity);
  if (!filterAdmission.allowed) {
    persistScreeningOutcome(candidateId, candidate, (candidate.filters?.failures || ['filter rejected']).join('; '), {
      category: candidate.contractSafety?.passed === false ? 'contract_safety' : 'hard_filter',
      risks: candidate.filters?.failures || [],
    });
    return;
  }
  if (researchMode && !paperLiveParity && filterAdmission.softFailures.length > 0) {
    console.log(`[research] soft-filter override ${candidate.token.mint.slice(0, 8)}... ${filterAdmission.softFailures.slice(0, 3).join('; ')}`);
  }

  const isTrackA = TRACK_A_ROUTES.has(signals.route);
  if (!isTrackA) {
    const preScoreHardFloor = Number(strat.prescore_hard_floor ?? 35);
    const preScore = preScoreCandidate(candidate, preScoreHardFloor);
    candidate.filters.preScore = preScore.score;
    candidate.filters.preScorePreferred = preScore.passed;
    const preScoreVetoFloor = Number(strat.prescore_veto_floor ?? -50);
    if (strictPolicyMode && preScore.score <= preScoreVetoFloor) {
      console.log(`[prescore] catastrophic-veto ${candidate.token.mint.slice(0, 8)}... score ${preScore.score} <= ${preScoreVetoFloor}`);
      candidate.filters.passed = false;
      candidate.filters.failures.push(`prescore catastrophic veto: ${preScore.score} <= ${preScoreVetoFloor}`);
      updateCandidateSnapshot(candidateId, candidate, 'filtered');
      persistScreeningOutcome(candidateId, candidate, `prescore catastrophic veto: ${preScore.score} <= ${preScoreVetoFloor}`, {
        category: 'prescore_veto', risks: candidate.filters.failures,
      });
      return;
    }
    if (researchMode && !paperLiveParity && preScore.score <= preScoreVetoFloor) {
      candidate.riskFlags = candidate.riskFlags || [];
      candidate.riskFlags.push({
        type: 'research_low_prescore',
        severity: 3,
        reason: `preScore ${preScore.score} <= legacy veto ${preScoreVetoFloor}`,
      });
    }

    const momentumPreferred = Number(strat.momentum_threshold ?? 0.5);
    const momentumVetoFloor = Number(strat.momentum_veto_floor ?? 0.1);
    const momentumResult = await momentumFilter(candidate, momentumVetoFloor);
    const isFreshRoute = ['pumpportal_graduated', 'pumpfun_pregrad'].includes(signals.route);
    const mlUnavailable = Number(momentumResult.score) < 0;
    const liveMlUnavailable = (requiresMoneyGradeEvidence() || strictPolicyMode) && mlUnavailable;
    const catastrophicMomentum = strictPolicyMode && !isFreshRoute && !mlUnavailable && Number(momentumResult.score) < momentumVetoFloor;
    if (liveMlUnavailable || catastrophicMomentum) {
      candidate.filters.passed = false;
      candidate.filters.failures.push(liveMlUnavailable
        ? 'momentum unavailable for money-grade mode'
        : `momentum catastrophic veto ${momentumResult.score} < ${momentumVetoFloor}`);
      candidate.filters.momentumScore = momentumResult.score;
      console.log(`[momentum] safety-veto ${candidate.token.mint.slice(0, 8)}... score ${momentumResult.score}`);
      updateCandidateSnapshot(candidateId, candidate, 'filtered');
      persistScreeningOutcome(candidateId, candidate, candidate.filters.failures.at(-1), {
        category: liveMlUnavailable ? 'momentum_unavailable' : 'momentum_veto',
        risks: candidate.filters.failures,
      });
      return;
    }
    candidate.filters.momentumScore = momentumResult.score;
    candidate.filters.momentumPreferred = momentumResult.score < 0 || momentumResult.score >= momentumPreferred;
  }

  updateCandidateSnapshot(candidateId, candidate);

  let rows;
  let batchDecision;
  let batchId;

  rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
  const selfRow = candidateById(candidateId);
  if (selfRow && !rows.some(row => Number(row.id) === Number(candidateId))) rows.push(selfRow);
  batchDecision = decideDeterministicBatch(rows, candidateId, { researchMode });
  batchId = storeBatchDecision(candidateId, rows, batchDecision);

  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  const currentUTCHourExecute = new Date().getUTCHours();
  const isUsSessionExecute = currentUTCHourExecute >= 12 && currentUTCHourExecute <= 18;
  const configuredConfidence = numSetting('llm_min_confidence', 40);
  const sessionConfidenceFloor = 60;
  const calibrationProbe = researchMode && batchDecision?.edge_action === 'LEARN';
  const requiredConfidence = calibrationProbe
    ? Math.max(0, numSetting('research_min_confidence', 30))
    : strictPolicyMode
    ? (isUsSessionExecute ? Math.max(configuredConfidence, sessionConfidenceFloor) : configuredConfidence)
    : Math.max(0, numSetting('research_min_confidence', 30));

  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= requiredConfidence) {
    const freshCapacity = activeCapacity(researchMode);
    if (!freshCapacity.allowed) {
      console.log(`[agent] ${researchMode ? 'research' : 'execution'} capacity reached (${freshCapacity.open}/${freshCapacity.max}), skipping ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { researchMode, maxOpenPositions: freshCapacity.max, openPositions: freshCapacity.open },
      });
      return;
    }
    try {
      await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
    } catch (err) {
      console.error(`[orchestrator] handleApprovedBuy failed for ${selectedRow.candidate.token.mint}: ${err.message}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'handle_buy_error',
        guardrails: { researchMode, error: err.message, stack: err.stack?.slice(0, 500) },
      });
      await sendTelegram([
        `🛑 <b>${researchMode ? 'Research entry' : 'Buy execution'} failed</b>`,
        '',
        candidateSummary(selectedRow.candidate, batchDecision),
        '',
        `Error: ${escapeHtml(err.message)}`,
      ].join('\n')).catch(e => console.error(e));
    }
  } else {
    const currentCapacity = activeCapacity(researchMode);
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        researchMode,
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: requiredConfidence,
        openPositions: currentCapacity.open,
        maxOpenPositions: currentCapacity.max,
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mint = selectedRow.candidate.token.mint;
  if (executingMints.has(mint)) return;

  // PAPER follows the same market allocator, fresh market snapshot, contract
  // safety, and decision validation as LIVE. Only the settlement is virtual.
  if (isResearchSimulationMode()) {
    const allocation = evaluateMarketAllocator();
    if (!allocationAllowsCandidate(selectedRow.candidate, allocation)) {
      console.log(`[allocator] blocked ${mint.slice(0, 8)}... family=${selectedRow.candidate.signals?.strategyFamily || 'edge1'} mode=${allocation.mode}`);
      return { id: null, isNew: false, blockedBy: 'market_allocator' };
    }

    executingMints.add(mint);
    try {
      const freshSelectedRow = await refreshCandidateForExecution(selectedRow).catch(err => {
        throw new Error(`PAPER fresh execution check failed: ${err.message}`);
      });
      if (!freshSelectedRow.candidate.filters?.passed) {
        throw new Error(`PAPER fresh execution guard failed: ${(freshSelectedRow.candidate.filters?.failures || []).join('; ')}`);
      }
      const edgeBlocked = edgeAdmissionBlockReason(freshSelectedRow.candidate, { researchMode: true });
      if (edgeBlocked) {
        logDecisionEvent({
          batchId, triggerCandidateId, selectedRow: freshSelectedRow, rows, decision,
          mode: 'research', action: 'research_entry_rejected_edge',
          guardrails: { edgeAdmission: freshSelectedRow.candidate?.edge?.admission, reason: edgeBlocked },
          execution: { rejectedBeforeEntry: true },
        });
        return { id: null, isNew: false, blockedBy: edgeBlocked };
      }
      assertSafeLiveDecision(decision, activeStrategy());
      await assertContractSafetyForMoneyMode(freshSelectedRow.candidate, { stage: 'pre_execution' });
      const result = await executeResearchEntry(freshSelectedRow, decision, `paper_parity_batch_${batchId ?? 'rule'}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow,
        rows,
        decision,
        mode: 'research',
        action: result.isNew ? 'research_entry_simulated' : `research_blocked_${result.blockedBy || 'duplicate'}`,
        guardrails: {
          realCapitalSol: 0,
          simNotionalSol: result.simNotionalSol ?? null,
          broadcast: false,
          walletRequired: false,
          plannedRr: result.plannedRr ?? null,
          hunterPolicy: result.hunterPolicy ?? null,
        },
        execution: { positionId: result.id, isNew: result.isNew },
      });
      if (result.isNew && result.id) await sendPositionOpen(result.id);
      return result;
    } finally {
      executingMints.delete(mint);
    }
  }

  const allocation = evaluateMarketAllocator();
  if (!allocationAllowsCandidate(selectedRow.candidate, allocation)) {
    console.log(`[allocator] blocked ${mint.slice(0, 8)}... family=${selectedRow.candidate.signals?.strategyFamily || 'edge1'} mode=${allocation.mode}`);
    logDecisionEvent({
      batchId, triggerCandidateId, selectedRow, rows, decision,
      action: 'entry_blocked_market_allocator',
      guardrails: { allocator: allocation },
      execution: { rejectedBeforeEntry: true },
    });
    return;
  }

  if (!tryReservePositionSlot()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max open positions reached (${openPositionCount()}/${max}) at start of handleApprovedBuy, aborting buy for ${mint}`);
    return;
  }

  executingMints.add(mint);
  try {
    const mode = tradingMode();
    const freshSelectedRow = await refreshCandidateForExecution(selectedRow).catch(err => {
      console.error('[handleApprovedBuy] refresh failed, rejecting execution:', err.message);
      return {
        ...selectedRow,
        refreshError: err.message,
        candidate: {
          ...selectedRow.candidate,
          filters: { passed: false, failures: [`refresh failed: ${err.message}`] },
        },
      };
    });
    const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
    if (!freshSelectedRow.candidate.filters?.passed) {
      const failures = freshSelectedRow.candidate.filters?.failures || ['fresh execution guard failed'];
      console.warn(`[fresh-check-rejected] ${mint} entry cancelled: ${failures.join('; ')}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'entry_rejected_stale',
        guardrails: { failures },
        execution: { rejectedBeforeEntry: true },
      });
      return;
    }

    const edgeBlocked = edgeAdmissionBlockReason(freshSelectedRow.candidate, { researchMode: false });
    if (edgeBlocked) {
      console.warn(`[edge-admission] ${mint} entry cancelled: ${edgeBlocked}`);
      logDecisionEvent({
        batchId, triggerCandidateId, selectedRow: freshSelectedRow, rows: executionRows, decision,
        mode: tradingMode(), action: 'entry_rejected_edge',
        guardrails: { edgeAdmission: freshSelectedRow.candidate?.edge?.admission, reason: edgeBlocked },
        execution: { rejectedBeforeEntry: true },
      });
      return;
    }

    if (mode === 'confirm') {
      const approvedSizeSol = calculatePositionSizeSol(freshSelectedRow.candidate, decision, activeStrategy());
      if (approvedSizeSol <= 0) {
        console.warn(`[agent] confirm entry rejected: calculated size below economic minimum for ${mint}`);
        return;
      }
      const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation', 'buy', approvedSizeSol);
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'confirm_intent_created',
        guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
        execution: { intentId },
      });
      await sendTradeIntent(intentId, freshSelectedRow.candidate, decision, approvedSizeSol);
      return;
    }

    // shadow_live is pre-live verification and remains wallet-aware. live keeps
    // config approval, risk budget, reconciliation, and circuit breakers.
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const mode = tradingMode();
    if (mode === 'live') {
      const intentId = createTradeIntent(selectedRow.id, selectedRow.candidate, decision, mode, 'execution_failed');
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow,
        rows,
        decision,
        mode,
        action: 'live_entry_failed',
        guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
        execution: { intentId, error: err.message },
      });
      await sendTelegram([
        '🛑 <b>Live trade failed</b>',
        '',
        candidateSummary(selectedRow.candidate, decision),
        '',
        `Intent #${intentId} stored.`,
      ].join('\n')).catch(e => console.error(e));
      return;
    }
    throw err;
  } finally {
    decrementPendingPosition();
    executingMints.delete(mint);
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
