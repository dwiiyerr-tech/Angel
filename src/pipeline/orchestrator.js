import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting, setting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { upsertCandidate, updateCandidateStatus, updateCandidateSnapshot, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent, checkDecisionCache } from '../db/decisions.js';
import { buildCandidate } from './candidateBuilder.js';
import { preScoreCandidate } from './preScorer.js';
import { momentumFilter } from './momentumFilter.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { calculatePositionSizeSol, canOpenMorePositions, openPositionCount, tradingMode, tryReservePositionSlot, decrementPendingPosition } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { recordSignalProcessed } from '../health/deadMansSwitch.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short, escapeHtml } from '../format.js';
import { evaluateMarketAllocator, allocationAllowsCandidate } from '../execution/marketAllocator.js';
import { applyContractSafetyGate } from '../execution/contractSafetyGate.js';
import { isResearchSimulationMode, requiresMoneyGradeEvidence } from '../research/policy.js';
import {
  executeResearchEntry,
  canOpenResearchPosition,
  openResearchPositionCount,
  researchPositionCap,
} from '../research/engine.js';
import { hunterPolicy } from './hunterPolicy.js';

// Fast-track bypass remains disabled. Research aggression comes from explicit
// policy and zero-capital sampling, never from skipping contract safety.
const TRACK_A_ROUTES = new Set([]);

export const seenSignalCandidates = new Map();
export const processingCandidates = new Set();
export const executingMints = new Set();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

function candidateRiskSeverity(candidate) {
  return (candidate?.riskFlags || []).reduce((sum, flag) => sum + Math.max(0, Number(flag?.severity) || 0), 0);
}

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

function activeCapacity(researchMode) {
  return researchMode ? researchCapacity() : executionCapacity();
}

export async function processCandidateFromSignals(signals) {
  recordSignalProcessed();
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  if (processingCandidates.has(signals.mint)) return;
  processingCandidates.add(signals.mint);
  try {
    return await _processCandidateFromSignals(signals);
  } finally {
    processingCandidates.delete(signals.mint);
  }
}

async function _processCandidateFromSignals(signals) {
  const researchMode = isResearchSimulationMode();
  const capacity = activeCapacity(researchMode);
  if (!capacity.allowed) {
    console.log(`[agent] ${researchMode ? 'research' : 'execution'} max positions reached (${capacity.open}/${capacity.max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const strat = activeStrategy();
  const blockedRoutes = (() => {
    try { return JSON.parse(setting('blocked_routes', '[]')); } catch { return []; }
  })();
  const adaptivelyBlockedRoute = blockedRoutes.some(route => String(signals.route || '').includes(route));
  if (adaptivelyBlockedRoute && !researchMode) {
    console.log(`[agent] blocked route ${signals.route} for ${signals.mint.slice(0, 8)}...`);
    return;
  }
  if (adaptivelyBlockedRoute && researchMode) {
    console.log(`[research] observing adaptively-blocked route ${signals.route}; no capital is at risk`);
  }

  // Same-mint concurrent positions are forbidden for unambiguous accounting.
  // Research otherwise uses a short experiment cooldown rather than live bans.
  try {
    const openPos = db.prepare(
      `SELECT id FROM dry_run_positions
       WHERE mint = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
       LIMIT 1`
    ).get(signals.mint);
    if (openPos) {
      console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — already has active position`);
      return;
    }

    if (researchMode) {
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

      if (strat.use_llm) {
        const recentDecision = db.prepare(`
          SELECT id FROM llm_decisions
          WHERE mint = ? AND created_at_ms > ?
          LIMIT 1
        `).get(signals.mint, recentMs);
        if (recentDecision) {
          console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — LLM decision exists (<2h)`);
          return;
        }
      }
    }
  } catch (err) {
    console.warn(`[agent] duplicate precheck degraded: ${err.message}`);
  }

  // Prevent route fan-in races.
  try {
    const recentCandidate = db.prepare(`
      SELECT id FROM candidates
      WHERE mint = ? AND created_at_ms > ?
      LIMIT 1
    `).get(signals.mint, Date.now() - 600000);
    if (recentCandidate) {
      console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — recent candidate (<10min) for any route`);
      return;
    }
  } catch (err) {
    console.warn(`[agent] candidate dedup degraded: ${err.message}`);
  }

  // Decision cache is an execution optimization, not a research truth source.
  if (!researchMode) {
    const cachedDecision = checkDecisionCache(signals.mint, signals.mcap || null, signals.holders || null);
    if (cachedDecision) {
      const ageMin = ((now() - cachedDecision.cachedAt) / 60000).toFixed(1);
      console.log(`[cache-hit] ${signals.mint.slice(0, 8)}... — verdict ${cachedDecision.verdict} (cached ${ageMin}m ago, reason: ${cachedDecision.reason?.slice(0, 60) || 'n/a'})`);
      return;
    }
  }

  const candidate = await buildCandidate(signals);
  const moneyMode = requiresMoneyGradeEvidence();
  await applyContractSafetyGate(candidate, {
    moneyMode,
    stage: 'screening',
    fetchRugcheck: moneyMode,
  });
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);

  // Copycat history protects capital but should not censor zero-capital research.
  if (!researchMode) {
    try {
      const symbol = candidate.token?.symbol;
      if (symbol) {
        const symbolPos = db.prepare(
          'SELECT id FROM dry_run_positions WHERE symbol = ? AND closed_at_ms > ? LIMIT 1'
        ).get(symbol, Date.now() - 86400000);
        if (symbolPos) {
          console.log(`[agent] skipping ${symbol} (${candidate.token.mint.slice(0, 8)}) — same symbol traded <24h ago`);
          return;
        }
      }
    } catch (err) {
      console.warn(`[agent] symbol dedup degraded: ${err.message}`);
    }
  }

  const filterAdmission = researchFilterAdmission(candidate, researchMode);
  if (!filterAdmission.allowed) return;
  if (researchMode && filterAdmission.softFailures.length > 0) {
    console.log(`[research] soft-filter override ${candidate.token.mint.slice(0, 8)}... ${filterAdmission.softFailures.slice(0, 3).join('; ')}`);
  }

  const isTrackA = TRACK_A_ROUTES.has(signals.route);
  if (!isTrackA) {
    const preScoreHardFloor = Number(strat.prescore_hard_floor ?? 35);
    const preScore = preScoreCandidate(candidate, preScoreHardFloor);
    candidate.filters.preScore = preScore.score;
    candidate.filters.preScorePreferred = preScore.passed;
    const preScoreVetoFloor = Number(strat.prescore_veto_floor ?? -50);
    if (!researchMode && preScore.score <= preScoreVetoFloor) {
      console.log(`[prescore] catastrophic-veto ${candidate.token.mint.slice(0, 8)}... score ${preScore.score} <= ${preScoreVetoFloor}`);
      candidate.filters.passed = false;
      candidate.filters.failures.push(`prescore catastrophic veto: ${preScore.score} <= ${preScoreVetoFloor}`);
      updateCandidateSnapshot(candidateId, candidate, 'filtered');
      return;
    }
    if (researchMode && preScore.score <= preScoreVetoFloor) {
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
    const liveMlUnavailable = requiresMoneyGradeEvidence() && mlUnavailable;
    const catastrophicMomentum = !researchMode && !isFreshRoute && !mlUnavailable && Number(momentumResult.score) < momentumVetoFloor;
    if (liveMlUnavailable || catastrophicMomentum) {
      candidate.filters.passed = false;
      candidate.filters.failures.push(liveMlUnavailable
        ? 'momentum unavailable for money-grade mode'
        : `momentum catastrophic veto ${momentumResult.score} < ${momentumVetoFloor}`);
      candidate.filters.momentumScore = momentumResult.score;
      console.log(`[momentum] safety-veto ${candidate.token.mint.slice(0, 8)}... score ${momentumResult.score}`);
      updateCandidateSnapshot(candidateId, candidate, 'filtered');
      return;
    }
    candidate.filters.momentumScore = momentumResult.score;
    candidate.filters.momentumPreferred = momentumResult.score < 0 || momentumResult.score >= momentumPreferred;
  }

  updateCandidateSnapshot(candidateId, candidate);

  let rows;
  let batchDecision;
  let batchId;

  if (!strat.use_llm || isTrackA) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: isTrackA
        ? `Track A Direct: ${signals.route} — deterministic filters passed.`
        : `Strategy '${strat.id}' is rule-based; deterministic filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: isTrackA ? -15 : (strat.sl_percent ?? numSetting('default_sl_percent', -25)),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }

  // In Research, LLM is advisory. A deterministic Hunter policy may sample an
  // otherwise contract-safe candidate when the LLM says WATCH/PASS.
  if (researchMode && (!batchDecision?.selected_row || batchDecision.verdict !== 'BUY')) {
    const selfRow = candidateById(candidateId);
    const prescore = Number(candidate.filters?.preScore);
    const momentum = Number(candidate.filters?.momentumScore);
    const derivedConfidence = Math.max(
      numSetting('research_min_confidence', 30),
      Math.min(100, Number.isFinite(prescore) ? prescore : 50),
    );
    const policy = hunterPolicy({
      confidence: derivedConfidence,
      preScore: prescore,
      momentum,
      totalSoftRiskSeverity: candidateRiskSeverity(candidate),
      catastrophic: false,
    });
    if (policy.action === 'TRADE' && selfRow) {
      batchDecision = {
        ...batchDecision,
        verdict: 'BUY',
        confidence: Math.max(30, Math.min(100, policy.score)),
        selected_candidate_id: candidateId,
        selected_mint: candidate.token.mint,
        selected_row: selfRow,
        reason: `Research Hunter ${policy.tier}: LLM advisory did not veto zero-capital sampling. ${batchDecision?.reason || ''}`.trim(),
        risks: batchDecision?.risks || [],
        suggested_tp_percent: Number(batchDecision?.suggested_tp_percent ?? strat.tp_percent ?? numSetting('default_tp_percent', 50)),
        suggested_sl_percent: Number(batchDecision?.suggested_sl_percent ?? strat.sl_percent ?? numSetting('default_sl_percent', -25)),
        research_hunter_policy: policy,
      };
    }
  }

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
  const requiredConfidence = researchMode
    ? Math.max(0, numSetting('research_min_confidence', 30))
    : (isUsSessionExecute ? Math.max(configuredConfidence, sessionConfidenceFloor) : configuredConfidence);

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

  // Research is separated before market allocator, wallet reserve, transaction
  // simulation, live risk budget, and live config checks. Its only size is a
  // Jupiter quote probe; real capital, signing, and broadcast are zero.
  if (isResearchSimulationMode()) {
    executingMints.add(mint);
    try {
      const result = await executeResearchEntry(selectedRow, decision, `research_batch_${batchId ?? 'rule'}`);
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
          hunterPolicy: result.hunterPolicy ?? decision.research_hunter_policy ?? null,
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
