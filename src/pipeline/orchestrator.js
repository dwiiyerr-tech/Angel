import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { upsertCandidate, updateCandidateStatus, updateCandidateSnapshot, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent, checkDecisionCache } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { preScoreCandidate } from './preScorer.js';
import { momentumFilter } from './momentumFilter.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { calculatePositionSizeSol, createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode, tryReservePositionSlot, decrementPendingPosition } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { recordSignalProcessed } from '../health/deadMansSwitch.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';
import { fetchDryRunEntryQuote } from '../enrichment/jupiter.js';
import { evaluateMarketAllocator, allocationAllowsCandidate } from '../execution/marketAllocator.js';
import { assessSecondWave, attachSecondWaveAssessment } from './secondWaveScreening.js';

// Track A: High-conviction routes that bypass PreScorer/ML/LLM for sub-second execution
// User requested full pipeline (ML + LLM) for all routes, so this is empty.
const TRACK_A_ROUTES = new Set([]);

export const seenSignalCandidates = new Map();
export const processingCandidates = new Set();
export const executingMints = new Set();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

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
  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  // Load strategy early — needed for duplicate checks below
  const strat = activeStrategy();

  // DUPLICATE CHECKS — all run BEFORE enrichment to save API calls
  try {
    const recentMs = Date.now() - 2 * 3600000; // 2 hours

    // 1. Open position exists
    const openPos = db.prepare(
      'SELECT id FROM dry_run_positions WHERE mint = ? AND status = ? LIMIT 1'
    ).get(signals.mint, 'open');
    if (openPos) {
      console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — already has open position`);
      return;
    }

    // 2. Recently closed position (<4h) — allow re-entries after 4h cooldown
    const closedPos = db.prepare(
      'SELECT id, exit_reason, closed_at_ms FROM dry_run_positions WHERE mint = ? AND status = ? AND closed_at_ms > ? ORDER BY closed_at_ms DESC LIMIT 1'
    ).get(signals.mint, 'closed', Date.now() - 4 * 60 * 60 * 1000);
    if (closedPos) {
      const hoursAgo = ((Date.now() - closedPos.closed_at_ms) / 3600000).toFixed(1);
      console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — recently closed (${hoursAgo}h ago, exit: ${closedPos.exit_reason})`);
      return;
    }

    // 3. LLM decision cache — only relevant when strategy uses LLM
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
  } catch (err) {
    // DB check failed — proceed anyway
  }

  // Bidirectional dedup — skip ANY route if this mint already has a recent candidate entry within 10 minutes
  // (prevents same token processed via pumpportal_graduated, pumpfun_pregrad, fee_trending, dual_source, etc. simultaneously)
  try {
    const recentCandidate = db.prepare(`
      SELECT id FROM candidates
      WHERE mint = ? AND created_at_ms > ?
      LIMIT 1
    `).get(signals.mint, Date.now() - 600000); // 10 minutes
    if (recentCandidate) {
      console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — recent candidate (<10min) for any route`);
      return;
    }
  } catch (err) {
    // DB check failed — proceed anyway
  }

  // FIX #1: Check decision cache BEFORE expensive buildCandidate() API calls
  // Lightweight check with just mint — full enrichment happens only if cache miss
  const cachedDecision = checkDecisionCache(signals.mint, signals.mcap || null, signals.holders || null);
  if (cachedDecision) {
    const ageMin = ((now() - cachedDecision.cachedAt) / 60000).toFixed(1);
    console.log(`[cache-hit] ${signals.mint.slice(0, 8)}... — verdict ${cachedDecision.verdict} (cached ${ageMin}m ago, reason: ${cachedDecision.reason?.slice(0, 60) || 'n/a'})`);
    return;
  }

  let candidate = await buildCandidate(signals);
  const allocationAtBuild = evaluateMarketAllocator();
  const requestedSecondWave = signals.strategyFamily === 'second_wave_v2' || signals.secondWave === true;
  const defensiveSecondWave = allocationAtBuild.secondWaveEnabled && !requestedSecondWave;
  if (requestedSecondWave || defensiveSecondWave) {
    const assessment = assessSecondWave(candidate);
    if (!assessment.eligible && (requestedSecondWave || allocationAtBuild.mode === 'red')) {
      console.log(`[second-wave] rejected ${candidate.token.mint.slice(0, 8)}...: ${assessment.hardFailures.join('; ')}`);
      return;
    }
    if (assessment.eligible) candidate = attachSecondWaveAssessment(candidate);
  }
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);

  // Symbol-based dedup — skip copycat tokens with same symbol traded in last 24h
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
    // DB check failed — proceed anyway
  }

  if (!candidate.filters.passed) {
    // filterCandidate already emits the complete rejection record.
    return;
  }

  // ── DUAL-TRACK PIPELINE ─────────────────────────────────────────────────
  // Track A (pumpportal_graduated, trenches_completed): bypass PreScorer/ML/LLM
  //   → pure Kaiser filter gate → direct BUY verdict → instant execution
  // Track B (all other routes): full pipeline PreScorer → Momentum ML → LLM
  const isTrackA = TRACK_A_ROUTES.has(signals.route);

  if (!isTrackA) {
    // ── Track B: Full analytical pipeline ──────────────────────────────────
    // Pre-score: rule-based check before LLM (saves LLM credits)
    const preScoreHardFloor = Number(strat.prescore_hard_floor ?? 35);
    const preScore = preScoreCandidate(candidate, preScoreHardFloor);
    candidate.filters.preScore = preScore.score;
    candidate.filters.preScorePreferred = preScore.passed;
    const preScoreVetoFloor = Number(strat.prescore_veto_floor ?? -50);
    if (preScore.score <= preScoreVetoFloor) {
      console.log(`[prescore] safety-veto ${candidate.token.mint.slice(0, 8)}... score ${preScore.score} <= ${preScoreVetoFloor} (${preScore.reasons.slice(0, 2).join('; ')})`);
      candidate.filters.passed = false;
      candidate.filters.failures.push(`prescore catastrophic veto: ${preScore.score} <= ${preScoreVetoFloor}`);
      updateCandidateSnapshot(candidateId, candidate, 'filtered');
      return;
    }
    console.log(`[prescore] ranked ${candidate.token.mint.slice(0, 8)}... score ${preScore.score} (preferred ${preScore.threshold}, veto ${preScoreVetoFloor})`);

    // Momentum filter — ML-based prediction of runner vs sideways
    // The current model is only weakly predictive, so use the configured
    // threshold as a preference and veto only clearly weak momentum.
    const momentumPreferred = Number(strat.momentum_threshold ?? 0.5);
    const momentumVetoFloor = Number(strat.momentum_veto_floor ?? 0.1);
    const momentumResult = await momentumFilter(candidate, momentumVetoFloor);
    const isFreshRoute = ['pumpportal_graduated', 'pumpfun_pregrad'].includes(signals.route);
    const mlUnavailable = Number(momentumResult.score) < 0;
    const liveMlUnavailable = tradingMode() !== 'dry_run' && mlUnavailable;
    const catastrophicMomentum = !isFreshRoute && !mlUnavailable && Number(momentumResult.score) < momentumVetoFloor;
    if (liveMlUnavailable || catastrophicMomentum) {
      candidate.filters.passed = false;
      candidate.filters.failures.push(liveMlUnavailable
        ? 'momentum unavailable for money mode'
        : `momentum catastrophic veto ${momentumResult.score} < ${momentumVetoFloor}`);
      candidate.filters.momentumScore = momentumResult.score;
      console.log(`[momentum] safety-veto ${candidate.token.mint.slice(0, 8)}... score ${momentumResult.score}`);
      updateCandidateSnapshot(candidateId, candidate, 'filtered');
      return;
    }
    candidate.filters.momentumScore = momentumResult.score;
    candidate.filters.momentumPreferred = momentumResult.score < 0 || momentumResult.score >= momentumPreferred;
  } else {
    console.log(`[track-a] ⚡ ${candidate.token.mint.slice(0, 8)}... FAST-TRACK via ${signals.route} — bypassing PreScorer/ML/LLM`);
  }

  updateCandidateSnapshot(candidateId, candidate);

  let rows, batchDecision, batchId;

  if (!strat.use_llm || isTrackA) {
    // Track A / Rule-based: direct BUY verdict, no LLM latency
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
        ? `⚡ Track A Direct: ${signals.route} — Kaiser filters passed, bypassed LLM/ML.`
        : `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: isTrackA ? -15 : (strat.sl_percent ?? numSetting('default_sl_percent', -25)),
      raw: null,
    };
  } else {
    // Track B: LLM batch evaluation
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
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

  // #6: Buy the LLM's selected candidate regardless of which candidate triggered the batch
  // FIX: Tighten confidence required during US Session (12:00 - 18:00 UTC)
  const currentUTCHourExecute = new Date().getUTCHours();
  const isUsSessionExecute = currentUTCHourExecute >= 12 && currentUTCHourExecute <= 18;
  const configuredConfidence = numSetting('llm_min_confidence');
  const sessionConfidenceFloor = 60;
  const requiredConfidence = isUsSessionExecute
    ? Math.max(configuredConfidence, sessionConfidenceFloor)
    : configuredConfidence;

  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= requiredConfidence) {
    if (!canOpenMorePositions()) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
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
        guardrails: { error: err.message, stack: err.stack?.slice(0, 500) },
      });
      await sendTelegram([
        '🛑 <b>Buy execution failed</b>',
        '',
        candidateSummary(selectedRow.candidate, batchDecision),
        '',
        `Error: ${escapeHtml(err.message)}`,
      ].join('\n')).catch(e => console.error(e));
    }
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: requiredConfidence,
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mint = selectedRow.candidate.token.mint;
  if (executingMints.has(mint)) return;

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
  // Fire-and-forget refresh — start now, await later. Wrapped so a refresh failure
  // doesn't kill the trade — we just fall back to the unrefreshed row.
  const refreshPromise = refreshCandidateForExecution(selectedRow).catch(err => {
    console.error('[handleApprovedBuy] refresh failed, rejecting execution:', err.message);
    return { ...selectedRow, refreshError: err.message, candidate: { ...selectedRow.candidate, filters: { passed: false, failures: ['refresh failed: ' + err.message] } } };
  });
  const freshSelectedRow = await refreshPromise;
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

  if (mode === 'dry_run') {
    // FIX #3: Wrap position creation in try-catch to capture execution failures
    
    let positionId, isNew, pastWinPnlSol, pastWinClosedAtMs, blockedBy;
    try {
      const drySizeSol = calculatePositionSizeSol(freshSelectedRow.candidate, decision);
      const entryQuote = await fetchDryRunEntryQuote(
        freshSelectedRow.candidate.token.mint,
        drySizeSol,
        freshSelectedRow.candidate.jupiterAsset?.decimals,
        freshSelectedRow.candidate.metrics?.priceUsd,
        freshSelectedRow.candidate.metrics?.marketCapUsd,
      );
      const result = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`, entryQuote);
      positionId = result.id;
      isNew = result.isNew;
      pastWinPnlSol = result.pastWinPnlSol;
      pastWinClosedAtMs = result.pastWinClosedAtMs;
      blockedBy = result.blockedBy;
    } catch (err) {
      console.error(`[orchestrator] createDryRunPosition failed for ${freshSelectedRow.candidate.token.mint}: ${err.message}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'dry_run_position_create_failed',
        guardrails: {
          maxOpenPositions: numSetting('max_open_positions', 3),
          openPositions: openPositionCount(),
        },
        execution: { 
          error: err.message,
          stack: err.stack?.slice(0, 500),
        },
      });
      await sendTelegram([
        '🛑 <b>Position creation failed</b>',
        '',
        candidateSummary(freshSelectedRow.candidate, decision),
        '',
        `Error: ${escapeHtml(err.message)}`,
      ].join('\n'));
      return;
    }
    
    // FIX #4: Enhanced past-win guard logging with context
    const guardrails = {
      maxOpenPositions: numSetting('max_open_positions', 3),
      openPositions: openPositionCount(),
      pastWinPnlSol: pastWinPnlSol ?? null,
      pastWinClosedAtMs: pastWinClosedAtMs ?? null,
    };
    
    if (!isNew && pastWinClosedAtMs) {
      // Fetch past position details for audit
      try {
        const pastPos = db.prepare(`
          SELECT exit_reason, opened_at_ms, closed_at_ms, entry_mcap, pnl_percent 
          FROM dry_run_positions 
          WHERE mint = ? AND closed_at_ms = ?
          LIMIT 1
        `).get(freshSelectedRow.candidate.token.mint, pastWinClosedAtMs);
        
        if (pastPos) {
          const holdDurationMin = pastPos.closed_at_ms && pastPos.opened_at_ms ? ((pastPos.closed_at_ms - pastPos.opened_at_ms) / 60000).toFixed(1) : 0;
          const currentMcap = freshSelectedRow.candidate.metrics?.marketCapUsd || 0;
          guardrails.pastWinExitReason = pastPos.exit_reason;
          guardrails.pastWinHoldDurationMin = Number(holdDurationMin);
          guardrails.pastWinPnlPercent = pastPos.pnl_percent;
          guardrails.wouldHaveBeenProfit = currentMcap > (pastPos.entry_mcap || 0);
        }
      } catch (err) {
        // Past position lookup failed — proceed with basic guardrails
      }
    }
    
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: isNew ? 'dry_run_entry' : `dry_run_blocked_${blockedBy || 'duplicate'}`,
      guardrails,
      execution: { positionId, isNew },
    });
    if (isNew) {
      await sendPositionOpen(positionId);
    } else if (pastWinClosedAtMs) {
      const daysAgo = Math.max(0, Math.floor((now() - (pastWinClosedAtMs || now())) / 86400000));
      await sendTelegram(`⏸️ Re-entry blocked: ${escapeHtml(freshSelectedRow.candidate.token.symbol)} won +${pastWinPnlSol ?? '?'} SOL ${daysAgo}d ago — guard prevented new position`);
    }
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

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
    ].join('\n')).catch(e => console.error(e));
  }
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
