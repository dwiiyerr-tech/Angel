import { db } from '../db/connection.js';
import { createLivePosition } from '../db/positions.js';
import { updateExecutionOperation } from '../db/executionOperations.js';
import { ensureLiveSafetySchema } from '../db/liveSafety.js';
import { fetchFinalizedSwapReceipt, liveWalletPubkey } from '../liveExecutor.js';
import { WSOL_MINT } from '../config.js';
import { now } from '../utils.js';

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function decisionForOperation(operation) {
  const row = operation.decision_id
    ? db.prepare('SELECT * FROM llm_decisions WHERE id = ?').get(operation.decision_id)
    : operation.candidate_id
      ? db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(operation.candidate_id)
      : null;
  if (!row) return null;
  const raw = parseJson(row.raw_json, {}) || {};
  return {
    ...raw,
    id: row.id,
    verdict: row.verdict,
    confidence: Number(row.confidence),
    reason: row.reason,
    risks: parseJson(row.risks_json, []),
  };
}

function candidateForOperation(operation) {
  const row = operation.candidate_id
    ? db.prepare('SELECT * FROM candidates WHERE id = ?').get(operation.candidate_id)
    : db.prepare('SELECT * FROM candidates WHERE mint = ? ORDER BY updated_at_ms DESC, id DESC LIMIT 1').get(operation.mint);
  if (!row) return null;
  return { id: row.id, candidate: parseJson(row.candidate_json, null) };
}

function activePositionForMint(mint) {
  return db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE mint = ? AND execution_mode = 'live'
      AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
    ORDER BY id DESC LIMIT 1
  `).get(mint) || null;
}

function restoreFailedSell(operation) {
  if (!operation.position_id) return;
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'open'
    WHERE id = ? AND status IN ('exit_unknown', 'partial_exit_unknown')
  `).run(operation.position_id);
}

async function reconcileFinalizedBuy(operation, receipt) {
  const outputText = String(receipt.outputAmount || '');
  if (!/^\d+$/.test(outputText) || BigInt(outputText) <= 0n) {
    updateExecutionOperation(operation.id, 'outcome_unknown', {
      signature: operation.signature,
      finalizedAtMs: now(),
      error: 'finalized_buy_output_amount_unresolved',
    });
    return { resolved: false, reason: 'buy_output_unknown' };
  }
  const outputAmount = outputText;

  let position = operation.position_id
    ? db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(operation.position_id)
    : activePositionForMint(operation.mint);

  if (!position) {
    const candidateRow = candidateForOperation(operation);
    const decision = decisionForOperation(operation);
    if (!candidateRow?.candidate || !decision) {
      updateExecutionOperation(operation.id, 'outcome_unknown', {
        signature: operation.signature,
        outputAmount,
        finalizedAtMs: now(),
        error: 'finalized_buy_missing_candidate_or_decision_for_recovery',
      });
      return { resolved: false, reason: 'recovery_context_missing' };
    }
    const sizeSol = Number(operation.reserved_sol || Number(operation.input_amount || 0) / 1_000_000_000);
    const created = createLivePosition(
      candidateRow.id,
      candidateRow.candidate,
      decision,
      {
        signature: operation.signature,
        outputAmount,
        feeSol: Number(receipt.feeSol || 0),
        finalized: true,
        recoveredBy: 'finalized_reconciler',
      },
      `reconciled_operation_${operation.id}`,
      sizeSol,
    );
    position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(created.id);
    if (!created.isNew && (!position || position.mint !== operation.mint || position.status === 'closed')) {
      updateExecutionOperation(operation.id, 'outcome_unknown', {
        signature: operation.signature,
        outputAmount,
        finalizedAtMs: now(),
        error: 'finalized_buy_position_recovery_conflict',
      });
      return { resolved: false, reason: 'position_recovery_conflict' };
    }
  }

  db.prepare(`
    UPDATE dry_run_positions
    SET token_amount_raw = COALESCE(token_amount_raw, ?),
        status = CASE WHEN status = 'entry_unknown' THEN 'open' ELSE status END,
        entry_signature = COALESCE(entry_signature, ?),
        entry_fee_sol = CASE WHEN COALESCE(entry_fee_sol, 0) = 0 THEN ? ELSE entry_fee_sol END
    WHERE id = ?
  `).run(outputAmount, operation.signature, Number(receipt.feeSol || 0), position.id);
  updateExecutionOperation(operation.id, 'completed', {
    positionId: position.id,
    signature: operation.signature,
    outputAmount,
    finalizedAtMs: now(),
    error: null,
  });
  return { resolved: true, action: 'buy_recovered', positionId: position.id };
}

function settleFullFinalizedSell(operation, position, receipt) {
  const outputLamports = Number(receipt.outputAmount);
  const receivedSol = outputLamports / 1_000_000_000;
  const feeSol = Number(receipt.feeSol || 0);
  const finalPnlSol = Number(position.realized_pnl_sol || 0)
    + receivedSol
    - Number(position.size_sol || 0)
    - Number(position.entry_fee_sol || 0)
    - feeSol;
  const originalCost = Number(position.realized_cost_sol || 0)
    + Number(position.size_sol || 0)
    + Number(position.entry_fee_sol || 0)
    + Number(position.realized_fee_sol || 0)
    + feeSol;
  const finalPnlPercent = originalCost > 0 ? finalPnlSol / originalCost * 100 : null;
  const at = now();

  db.transaction(() => {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_reason = 'RECONCILED_FINALIZED_EXIT',
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?, exit_fee_sol = ?, token_amount_raw = '0'
      WHERE id = ?
    `).run(at, finalPnlPercent, finalPnlSol, operation.signature, feeSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades
        (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'RECONCILED_FINALIZED_EXIT', ?)
    `).run(
      position.id,
      position.mint,
      at,
      position.exit_price || position.high_water_price || position.entry_price,
      position.exit_mcap || position.high_water_mcap || position.entry_mcap,
      position.size_sol,
      position.token_amount_est,
      JSON.stringify({ operationId: operation.id, receipt, receivedSol, recovered: true }),
    );
  })();
  return { finalPnlSol, finalPnlPercent };
}

function settlePartialFinalizedSell(operation, position, receipt) {
  const beforeRaw = BigInt(position.token_amount_raw || operation.input_amount || '0');
  const soldRaw = BigInt(operation.input_amount || '0');
  if (beforeRaw <= 0n || soldRaw <= 0n || soldRaw > beforeRaw) {
    return { resolved: false, reason: 'invalid_partial_recovery_amount' };
  }
  // Remaining position inventory is derived from the position ledger plus the
  // finalized transaction input, not from the current wallet balance. External
  // transfers therefore cannot silently become part of this position.
  const remainingRaw = beforeRaw - soldRaw;
  const soldFraction = Math.min(1, Number(soldRaw.toString()) / Number(beforeRaw.toString()));
  const soldCostSol = Number(position.size_sol || 0) * soldFraction;
  const newSizeSol = Math.max(0, Number(position.size_sol || 0) - soldCostSol);
  const receivedSol = Number(receipt.outputAmount) / 1_000_000_000;
  const feeSol = Number(receipt.feeSol || 0);
  const realizedDelta = receivedSol - soldCostSol - feeSol;
  const at = now();

  db.transaction(() => {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'open', partial_tp_done = 1, token_amount_raw = ?, size_sol = ?,
          realized_pnl_sol = COALESCE(realized_pnl_sol, 0) + ?,
          realized_cost_sol = COALESCE(realized_cost_sol, 0) + ?,
          realized_fee_sol = COALESCE(realized_fee_sol, 0) + ?
      WHERE id = ?
    `).run(remainingRaw.toString(), newSizeSol, realizedDelta, soldCostSol, feeSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades
        (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'RECONCILED_PARTIAL_EXIT', ?)
    `).run(
      position.id,
      position.mint,
      at,
      position.high_water_price || position.entry_price,
      position.high_water_mcap || position.entry_mcap,
      soldCostSol,
      Number(soldRaw.toString()),
      JSON.stringify({ operationId: operation.id, receipt, remainingRaw: remainingRaw.toString(), recovered: true }),
    );
  })();
  return { resolved: true, remainingRaw: remainingRaw.toString() };
}

async function reconcileFinalizedSell(operation, receipt) {
  const outputText = String(receipt.outputAmount || '');
  if (!/^\d+$/.test(outputText) || BigInt(outputText) <= 0n) {
    updateExecutionOperation(operation.id, 'outcome_unknown', {
      signature: operation.signature,
      finalizedAtMs: now(),
      error: 'finalized_sell_output_amount_unresolved',
    });
    return { resolved: false, reason: 'sell_output_unknown' };
  }

  const position = operation.position_id
    ? db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(operation.position_id)
    : activePositionForMint(operation.mint);
  if (!position) {
    updateExecutionOperation(operation.id, 'outcome_unknown', {
      signature: operation.signature,
      finalizedAtMs: now(),
      error: 'finalized_sell_position_missing',
    });
    return { resolved: false, reason: 'position_missing' };
  }

  const originalRaw = BigInt(position.token_amount_raw || '0');
  const requestedRaw = BigInt(operation.input_amount || '0');
  const partial = position.status === 'partial_exit_unknown'
    || (originalRaw > 0n && requestedRaw > 0n && requestedRaw < originalRaw);

  if (partial) {
    const settled = settlePartialFinalizedSell(operation, position, receipt);
    if (!settled.resolved) {
      updateExecutionOperation(operation.id, 'outcome_unknown', {
        signature: operation.signature,
        finalizedAtMs: now(),
        error: settled.reason,
      });
      return settled;
    }
  } else {
    settleFullFinalizedSell(operation, position, receipt);
  }

  updateExecutionOperation(operation.id, 'completed', {
    positionId: position.id,
    signature: operation.signature,
    outputAmount: receipt.outputAmount,
    finalizedAtMs: now(),
    error: null,
  });
  return { resolved: true, action: partial ? 'partial_sell_recovered' : 'sell_recovered', positionId: position.id };
}

export async function reconcileUnknownExecutions({ limit = 20 } = {}) {
  ensureLiveSafetySchema();
  if (!liveWalletPubkey()) return { checked: 0, resolved: 0, pending: 0, skipped: 'wallet_unavailable' };

  const operations = db.prepare(`
    SELECT * FROM execution_operations
    WHERE status IN ('pending', 'outcome_unknown')
    ORDER BY updated_at_ms ASC
    LIMIT ?
  `).all(limit);

  let resolved = 0;
  let pending = 0;
  const details = [];
  for (const operation of operations) {
    // A pre-broadcast crash with no durable signature is intentionally not
    // guessed away. The reservation and circuit breaker remain latched.
    if (!operation.signature) {
      pending += 1;
      details.push({ id: operation.id, resolved: false, reason: 'signature_missing' });
      continue;
    }

    try {
      const mints = operation.side === 'buy'
        ? { inputMint: WSOL_MINT, outputMint: operation.mint }
        : { inputMint: operation.mint, outputMint: WSOL_MINT };
      const receipt = await fetchFinalizedSwapReceipt(operation.signature, mints);
      if (!receipt.finalized) {
        pending += 1;
        details.push({ id: operation.id, resolved: false, reason: 'not_finalized' });
        continue;
      }
      if (receipt.success !== true) {
        restoreFailedSell(operation);
        updateExecutionOperation(operation.id, 'failed', {
          signature: operation.signature,
          finalizedAtMs: now(),
          error: `finalized_chain_failure:${JSON.stringify(receipt.error)}`,
        });
        resolved += 1;
        details.push({ id: operation.id, resolved: true, action: 'finalized_failure' });
        continue;
      }

      const outcome = operation.side === 'buy'
        ? await reconcileFinalizedBuy(operation, receipt)
        : await reconcileFinalizedSell(operation, receipt);
      if (outcome.resolved) resolved += 1;
      else pending += 1;
      details.push({ id: operation.id, ...outcome });
    } catch (error) {
      pending += 1;
      details.push({ id: operation.id, resolved: false, reason: `reconcile_error:${error.message}` });
    }
  }

  return { checked: operations.length, resolved, pending, details };
}
