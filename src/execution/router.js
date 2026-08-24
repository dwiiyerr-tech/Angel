import { now } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import {
  WSOL_MINT, LIVE_MAX_DAILY_ENTRIES, LIVE_MAX_DAILY_LOSS_SOL, LIVE_MAX_OPEN_POSITIONS,
  LIVE_MAX_POSITION_SOL, LIVE_MAX_TOTAL_EXPOSURE_SOL, LIVE_MAX_WALLET_FRACTION,
  LIVE_MIN_SOL_RESERVE_LAMPORTS,
} from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, simulateJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { calculatePositionSizeSol, createDryRunPosition, createLivePosition, liveEntryBlockReason, openPositionCount, tradingMode, tryReservePositionSlot, decrementPendingPosition, riskRewardBlockReason, riskRewardRatio } from '../db/positions.js';
import { claimExecutionOperation, updateExecutionOperation } from '../db/executionOperations.js';
import { claimTradeIntent, TRADE_INTENT_TTL_MS } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { fetchDryRunEntryQuote } from '../enrichment/jupiter.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram } from '../telegram/send.js';
import { createTradeIntent } from '../db/intents.js';
import { assertLiveConfigApproved } from '../db/liveConfig.js';
import { pauseLiveEntries } from '../health/circuitBreaker.js';
import { assertLossStreakAllowed } from './riskControls.js';
import { assertContractSafetyForMoneyMode } from './contractSafetyGate.js';
import { hasPositiveRawAmount, resolveTrackedSellAmount } from './liveInventoryGuard.js';

const ENTRY_MAX_ATTEMPTS = 3;

function normalizedRiskBudgetMode(executionMode) {
  const normalizedMode = executionMode === 'confirm' ? 'live' : executionMode;
  if (normalizedMode !== 'live' && normalizedMode !== 'shadow_live') {
    throw new Error(`Hard risk budget only supports live/confirm/shadow_live modes, got: ${executionMode}`);
  }
  return normalizedMode;
}

export function assertLiveRiskBudget(nextSizeSol, executionMode = 'live') {
  const mode = normalizedRiskBudgetMode(executionMode);
  const label = mode === 'shadow_live' ? 'shadow-live' : 'live';
  const active = db.prepare(`
    SELECT count(*) AS count, coalesce(sum(size_sol), 0) AS exposure
    FROM dry_run_positions
    WHERE execution_mode = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
  `).get(mode);
  if (Number(active.count) >= LIVE_MAX_OPEN_POSITIONS) throw new Error(`Hard ${label} position cap reached (${active.count}/${LIVE_MAX_OPEN_POSITIONS}).`);
  if (Number(active.exposure) + Number(nextSizeSol) > LIVE_MAX_TOTAL_EXPOSURE_SOL) throw new Error(`Hard ${label} exposure cap exceeded (${LIVE_MAX_TOTAL_EXPOSURE_SOL} SOL).`);

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const entries = mode === 'live'
    ? db.prepare(`SELECT count(*) AS count FROM execution_operations WHERE side = 'buy' AND status IN ('completed', 'outcome_unknown') AND created_at_ms >= ?`).get(since).count
    : db.prepare(`SELECT count(*) AS count FROM dry_run_positions WHERE execution_mode = 'shadow_live' AND opened_at_ms >= ?`).get(since).count;
  if (Number(entries) >= LIVE_MAX_DAILY_ENTRIES) throw new Error(`Hard daily ${label} entry cap reached (${entries}/${LIVE_MAX_DAILY_ENTRIES}).`);

  const pnl = Number(db.prepare(`
    SELECT coalesce(sum(pnl_sol), 0) AS pnl
    FROM dry_run_positions
    WHERE execution_mode = ? AND status = 'closed' AND closed_at_ms >= ?
  `).get(mode, since).pnl);
  if (pnl <= -LIVE_MAX_DAILY_LOSS_SOL) throw new Error(`Hard daily ${label} loss limit reached (${pnl.toFixed(4)} SOL).`);
  return { executionMode: mode, activePositions: Number(active.count), exposureSol: Number(active.exposure), dailyEntries: Number(entries), dailyPnlSol: pnl };
}

export function assertSafeLiveDecision(decision, strat) {
  const confidence = Number(decision?.confidence);
  const tp = Number(decision?.suggested_tp_percent ?? strat?.tp_percent ?? numSetting('default_tp_percent', 50));
  const sl = Number(decision?.suggested_sl_percent ?? strat?.sl_percent ?? numSetting('default_sl_percent', -25));
  if (decision?.verdict !== 'BUY' || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error('Invalid live BUY decision or confidence.');
  if (!Number.isFinite(tp) || tp < 1 || tp > 500) throw new Error(`Unsafe take-profit value: ${tp}`);
  if (!Number.isFinite(sl) || sl >= 0 || sl < -50) throw new Error(`Unsafe stop-loss value: ${sl}`);
  const rrBlocked = riskRewardBlockReason(tp, sl);
  if (rrBlocked) throw new Error(`Unsafe risk/reward: ${rrBlocked}`);
  return { confidence, tp, sl, riskRewardRatio: riskRewardRatio(tp, sl) };
}

async function executeShadowLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const strat = activeStrategy();
  const candidate = selectedRow.candidate;
  assertSafeLiveDecision(decision, strat);
  await assertContractSafetyForMoneyMode(candidate, { stage: 'pre_execution' });
  const blocked = liveEntryBlockReason(candidate.token.mint, strat);
  if (blocked) throw new Error(`Shadow-live buy blocked before simulation: ${blocked}`);
  const scaledSizeSol = calculatePositionSizeSol(candidate, decision, strat);
  const amountLamports = Math.floor(scaledSizeSol * 1_000_000_000);
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0 || scaledSizeSol > LIVE_MAX_POSITION_SOL) throw new Error(`Unsafe shadow-live position size: ${scaledSizeSol} SOL (cap ${LIVE_MAX_POSITION_SOL})`);
  assertLiveRiskBudget(scaledSizeSol, 'shadow_live');
  assertLossStreakAllowed('shadow_live');
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) throw new Error('Shadow-live insufficient SOL balance for realistic simulation including reserve.');
  if (amountLamports > balance * LIVE_MAX_WALLET_FRACTION) throw new Error(`Shadow-live position exceeds ${(LIVE_MAX_WALLET_FRACTION * 100).toFixed(0)}% wallet cap.`);

  const simulation = await simulateJupiterSwap({ inputMint: WSOL_MINT, outputMint: candidate.token.mint, amount: amountLamports });
  const entryQuote = await fetchDryRunEntryQuote(candidate.token.mint, scaledSizeSol, candidate.jupiterAsset?.decimals, candidate.metrics?.priceUsd, candidate.metrics?.marketCapUsd);
  if (!entryQuote?.outputAmountRaw) throw new Error('Shadow-live requires a position-sized executable entry quote; fallback mark is disabled.');
  const created = createDryRunPosition(selectedRow.id, candidate, decision, `shadow_live_batch_${batchId}`, entryQuote);
  if (created.isNew && created.id) {
    db.prepare(`
      UPDATE dry_run_positions
      SET execution_mode = 'shadow_live',
          snapshot_json = json_set(snapshot_json, '$.shadowLiveCompatible', 1, '$.executionMode', 'shadow_live')
      WHERE id = ?
    `).run(created.id);
  }
  logDecisionEvent({
    batchId, triggerCandidateId, selectedRow, rows, decision,
    mode: 'shadow_live',
    action: created.isNew ? 'shadow_live_entry_simulated' : `shadow_live_blocked_${created.blockedBy || 'duplicate'}`,
    guardrails: { amountLamports, balanceLamports: balance, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS, broadcast: false },
    execution: { positionId: created.id, isNew: created.isNew, simulation },
  });
  if (created.isNew) await sendPositionOpen(created.id);
  return created;
}

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  if (tradingMode() === 'shadow_live') return executeShadowLiveBuy(selectedRow, decision, batchId, rows, triggerCandidateId);
  assertLiveConfigApproved();
  const strat = activeStrategy();
  const candidate = selectedRow.candidate;
  assertSafeLiveDecision(decision, strat);
  await assertContractSafetyForMoneyMode(candidate, { stage: 'pre_execution' });
  const blocked = liveEntryBlockReason(candidate.token.mint, strat);
  if (blocked) throw new Error(`Live buy blocked before swap: ${blocked}`);
  const scaledSizeSol = calculatePositionSizeSol(candidate, decision, strat);
  const amountLamports = Math.floor(scaledSizeSol * 1_000_000_000);
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0 || scaledSizeSol > LIVE_MAX_POSITION_SOL) throw new Error(`Unsafe live position size: ${scaledSizeSol} SOL (cap ${LIVE_MAX_POSITION_SOL})`);
  assertLiveRiskBudget(scaledSizeSol);
  assertLossStreakAllowed('live');
  const claim = claimExecutionOperation({ mint: candidate.token.mint, side: 'buy', inputAmount: amountLamports });
  if (!claim.ok) throw new Error(`Live buy blocked: ${claim.reason}`);
  let balance;
  try {
    balance = await liveWalletBalanceLamports();
  } catch (error) {
    updateExecutionOperation(claim.operationId, 'failed', { error: error.message });
    throw error;
  }
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    updateExecutionOperation(claim.operationId, 'failed', { error: 'insufficient_balance' });
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
  if (amountLamports > balance * LIVE_MAX_WALLET_FRACTION) {
    updateExecutionOperation(claim.operationId, 'failed', { error: 'wallet_fraction_cap' });
    throw new Error(`Position exceeds ${(LIVE_MAX_WALLET_FRACTION * 100).toFixed(0)}% wallet cap.`);
  }

  let swap = null;
  let lastError = null;
  for (let attempt = 1; attempt <= ENTRY_MAX_ATTEMPTS; attempt++) {
    try {
      assertLiveConfigApproved();
      swap = await executeJupiterSwap({ inputMint: WSOL_MINT, outputMint: candidate.token.mint, amount: amountLamports });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.log(`[executeLiveBuy] attempt ${attempt}/${ENTRY_MAX_ATTEMPTS} failed for ${candidate.token.mint.slice(0, 8)}... ${err.message}`);
      if (err.swapOutcomeUnknown) break;
      const fatalErrors = ['insufficient balance', 'insufficient funds', 'slippage'];
      if (err.message && fatalErrors.some(msg => err.message.toLowerCase().includes(msg))) break;
      if (attempt < ENTRY_MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  if (!swap) {
    const unknown = Boolean(lastError?.swapOutcomeUnknown);
    updateExecutionOperation(claim.operationId, unknown ? 'outcome_unknown' : 'failed', { signature: lastError?.swapSignature, error: lastError?.message || 'unknown' });
    if (unknown) await pauseLiveEntries(`buy outcome unknown for ${candidate.token.mint}`);
    logDecisionEvent({ batchId, triggerCandidateId, selectedRow, rows, decision, mode: 'live', action: 'live_entry_failed', guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS, attempts: ENTRY_MAX_ATTEMPTS }, execution: { operationId: claim.operationId, outcomeUnknown: unknown, error: lastError?.message || 'unknown' } });
    await sendTelegram(['🛑 <b>Live entry failed after retries</b>', '', candidateSummary(candidate, decision), '', `Attempts: ${ENTRY_MAX_ATTEMPTS}`, `Error: ${escapeHtml(lastError?.message || 'unknown')}`, unknown ? `Operation #${claim.operationId} requires reconciliation; automatic retry is blocked.` : `Operation #${claim.operationId} recorded as failed.`].join('\n'));
    throw lastError || new Error('Live buy failed without exception');
  }
  let positionResult;
  try {
    positionResult = createLivePosition(selectedRow.id, candidate, decision, swap, `live_batch_${batchId}`, scaledSizeSol);
  } catch (error) {
    updateExecutionOperation(claim.operationId, 'outcome_unknown', { signature: swap.signature, outputAmount: swap.outputAmount, error: `swap_succeeded_position_persist_failed: ${error.message}` });
    await pauseLiveEntries(`swap succeeded but position persistence failed for ${candidate.token.mint}`);
    throw error;
  }
  const { id: positionId, isNew } = positionResult;
  if (!isNew) {
    updateExecutionOperation(claim.operationId, 'outcome_unknown', { signature: swap.signature, outputAmount: swap.outputAmount, error: 'swap_succeeded_but_position_not_created' });
    await pauseLiveEntries(`swap succeeded but position was not newly recorded for ${candidate.token.mint}`);
    throw new Error('CRITICAL: swap succeeded but a new position was not created');
  }
  const missingAmount = !hasPositiveRawAmount(swap.outputAmount);
  updateExecutionOperation(claim.operationId, missingAmount ? 'outcome_unknown' : 'completed', { positionId, signature: swap.signature, outputAmount: swap.outputAmount, error: missingAmount ? 'received_token_amount_unknown' : null });
  if (missingAmount) await pauseLiveEntries(`buy succeeded but received token amount is unknown for ${candidate.token.mint}`);
  logDecisionEvent({ batchId, triggerCandidateId, selectedRow, rows, decision, mode: 'live', action: 'live_entry_executed', guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS }, execution: { positionId, isNew, swap } });
  if (isNew) await sendPositionOpen(positionId);
}

export async function executeLiveSell(position, reason) {
  const trackedAmount = position.token_amount_raw || position.token_amount_est;
  if (!trackedAmount) throw new Error('Live position has no token amount to sell.');
  const walletAmount = await fetchLiveTokenBalance(position.mint);
  const amount = resolveTrackedSellAmount({ positionAmountRaw: trackedAmount, walletAmountRaw: walletAmount });

  const claim = claimExecutionOperation({ mint: position.mint, side: 'sell', positionId: position.id, inputAmount: amount });
  if (!claim.ok) throw new Error(`Live sell blocked: ${claim.reason}`);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const swap = await executeJupiterSwap({ inputMint: position.mint, outputMint: WSOL_MINT, amount });
      updateExecutionOperation(claim.operationId, 'completed', { positionId: position.id, signature: swap.signature, outputAmount: swap.outputAmount });
      return swap;
    } catch (err) {
      lastError = err;
      if (err.swapOutcomeUnknown) break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  if (lastError?.swapOutcomeUnknown) {
    const unknownStatus = String(reason).includes('PARTIAL') ? 'partial_exit_unknown' : 'exit_unknown';
    db.prepare("UPDATE dry_run_positions SET status = ? WHERE id = ? AND status = 'open'").run(unknownStatus, position.id);
    updateExecutionOperation(claim.operationId, 'outcome_unknown', { positionId: position.id, signature: lastError.swapSignature, error: lastError.message });
    await pauseLiveEntries(`sell outcome unknown for ${position.mint}`);
  } else {
    updateExecutionOperation(claim.operationId, 'failed', { positionId: position.id, error: lastError?.message || 'unknown' });
  }
  throw lastError || new Error('Live sell failed without exception');
}

export async function executeConfirmedIntent(chatId, intentId) {
  if (!tryReservePositionSlot()) return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  const intent = claimTradeIntent(intentId);
  if (!intent) {
    decrementPendingPosition();
    return bot.sendMessage(chatId, 'Pending intent not found or already being executed.');
  }
  const { decision } = intent.payload;
  let operationId = null;
  let completedSwap = null;
  try {
    if (tradingMode() !== 'confirm') throw new Error('Confirmation execution requires trading_mode=confirm.');
    assertLiveConfigApproved();
    if (Date.now() - Number(intent.created_at_ms) > TRADE_INTENT_TTL_MS) {
      db.prepare("UPDATE trade_intents SET status = 'expired', updated_at_ms = ? WHERE id = ?").run(now(), intentId);
      throw new Error('Trade intent expired; request a fresh candidate evaluation.');
    }
    const freshRow = await refreshCandidateForExecution({ id: intent.candidate_id, candidate: intent.payload.candidate });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return bot.sendMessage(chatId, ['🛑 <b>Trade intent rejected on fresh check</b>', '', candidateSummary(freshRow.candidate, decision), '', `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    await assertContractSafetyForMoneyMode(freshRow.candidate, { stage: 'pre_execution' });
    const strat = activeStrategy();
    assertSafeLiveDecision(decision, strat);
    const blocked = liveEntryBlockReason(freshRow.candidate.token.mint, strat);
    if (blocked) throw new Error(`Confirmed buy blocked before swap: ${blocked}`);
    const recalculatedSizeSol = calculatePositionSizeSol(freshRow.candidate, decision, strat);
    const approvedSizeSol = Number(intent.size_sol);
    if (!Number.isFinite(approvedSizeSol) || approvedSizeSol <= 0) throw new Error('Intent has an invalid approved size.');
    const scaledSizeSol = Math.min(recalculatedSizeSol, approvedSizeSol);
    const amountLamports = Math.floor(scaledSizeSol * 1_000_000_000);
    if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0 || scaledSizeSol > LIVE_MAX_POSITION_SOL) throw new Error(`Unsafe confirmed position size: ${scaledSizeSol} SOL (cap ${LIVE_MAX_POSITION_SOL})`);
    assertLiveRiskBudget(scaledSizeSol);
    const claim = claimExecutionOperation({ mint: freshRow.candidate.token.mint, side: 'buy', intentId, inputAmount: amountLamports });
    if (!claim.ok) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_duplicate', now(), intentId);
      return bot.sendMessage(chatId, `Live execution blocked: ${escapeHtml(claim.reason)}`, { parse_mode: 'HTML' });
    }
    operationId = claim.operationId;
    let balance;
    try { balance = await liveWalletBalanceLamports(); }
    catch (error) { updateExecutionOperation(operationId, 'failed', { error: error.message }); throw error; }
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      updateExecutionOperation(claim.operationId, 'failed', { error: 'insufficient_balance' });
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_insufficient_balance', now(), intentId);
      return bot.sendMessage(chatId, `Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`, { parse_mode: 'HTML' });
    }
    if (amountLamports > balance * LIVE_MAX_WALLET_FRACTION) {
      updateExecutionOperation(claim.operationId, 'failed', { error: 'wallet_fraction_cap' });
      throw new Error(`Position exceeds ${(LIVE_MAX_WALLET_FRACTION * 100).toFixed(0)}% wallet cap.`);
    }
    assertLiveConfigApproved();
    const swap = await executeJupiterSwap({ inputMint: WSOL_MINT, outputMint: freshRow.candidate.token.mint, amount: amountLamports });
    completedSwap = swap;
    const { id: positionId, isNew } = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`, scaledSizeSol);
    if (!isNew) {
      updateExecutionOperation(claim.operationId, 'outcome_unknown', { signature: swap.signature, outputAmount: swap.outputAmount, error: 'swap_succeeded_but_position_not_created' });
      await pauseLiveEntries(`confirmed swap succeeded but position was not newly recorded for ${freshRow.candidate.token.mint}`);
      throw new Error('CRITICAL: swap succeeded but a new position was not created');
    }
    const missingAmount = !hasPositiveRawAmount(swap.outputAmount);
    updateExecutionOperation(claim.operationId, missingAmount ? 'outcome_unknown' : 'completed', { positionId, signature: swap.signature, outputAmount: swap.outputAmount, error: missingAmount ? 'received_token_amount_unknown' : null });
    if (missingAmount) await pauseLiveEntries(`confirmed buy amount unknown for ${freshRow.candidate.token.mint}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({ batchId: null, triggerCandidateId: intent.candidate_id, selectedRow: freshRow, rows: [], decision, mode: 'live', action: 'confirmed_intent_executed', guardrails: { balanceLamports: balance, amountLamports, intentId }, execution: { positionId, isNew, swap } });
    if (isNew) return sendPositionOpen(positionId);
  } catch (err) {
    if (operationId && (err.swapOutcomeUnknown || completedSwap)) {
      updateExecutionOperation(operationId, 'outcome_unknown', { signature: completedSwap?.signature || err.swapSignature, outputAmount: completedSwap?.outputAmount, error: completedSwap ? `swap_succeeded_position_persist_failed: ${err.message}` : err.message });
      await pauseLiveEntries(`confirmed execution outcome uncertain: ${err.message}`);
    } else if (operationId) {
      const current = db.prepare('SELECT status FROM execution_operations WHERE id = ?').get(operationId);
      if (current?.status === 'pending') updateExecutionOperation(operationId, 'failed', { error: err.message });
    }
    db.prepare("UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ? AND status = 'executing'").run(err.swapOutcomeUnknown ? 'outcome_unknown' : 'execution_failed', now(), intentId);
    return bot.sendMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  } finally {
    decrementPendingPosition();
  }
}

export async function rejectIntent(chatId, intentId) {
  const rejected = db.prepare(`UPDATE trade_intents SET status = 'rejected', updated_at_ms = ? WHERE id = ? AND status = 'pending_confirmation'`).run(now(), intentId);
  if (rejected.changes !== 1) return bot.sendMessage(chatId, 'Intent not found or already being executed.');
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}
