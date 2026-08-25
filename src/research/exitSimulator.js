import { db } from '../db/connection.js';
import { DRY_RUN_NETWORK_FEE_SOL, DRY_RUN_PRIORITY_FEE_SOL } from '../config.js';
import { numSetting } from '../db/settings.js';
import { fetchTokenExitQuote } from '../enrichment/jupiter.js';
import { now, sleep } from '../utils.js';
import { estimateResearchTransactionFees } from './executionCost.js';

export const RESEARCH_EXIT_SIMULATOR_VERSION = 'research_exit_simulator_v3';

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function finiteNonNegative(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function positiveRawAmount(value) {
  try {
    const raw = BigInt(String(value ?? '0'));
    return raw > 0n ? raw.toString() : null;
  } catch {
    return null;
  }
}

function configuredExitLatencyMs() {
  const entryFallback = Math.max(0, Math.min(10_000, Math.floor(numSetting('research_quote_to_submit_latency_ms', 500))));
  return Math.max(0, Math.min(10_000, Math.floor(numSetting('research_exit_quote_to_fill_latency_ms', entryFallback))));
}

function fallbackExitFees(error = null) {
  const baseFeeSol = Math.max(0, numSetting('dry_run_network_fee_sol', DRY_RUN_NETWORK_FEE_SOL));
  const priorityFeeSol = Math.max(0, numSetting('dry_run_priority_fee_sol', DRY_RUN_PRIORITY_FEE_SOL));
  return {
    side: 'exit',
    baseFeeSol,
    priorityFeeSol,
    jitoTipSol: 0,
    expectedFailureOverheadSol: 0,
    failureProbability: 0,
    expectedRetries: 0,
    totalFeeSol: baseFeeSol + priorityFeeSol,
    quality: 'degraded',
    source: 'configured_fallback',
    error: error?.message || null,
    measuredAtMs: now(),
  };
}

export function exitQuoteDeteriorationPct(signalOutSol, fillOutSol) {
  const signal = Number(signalOutSol);
  const fill = Number(fillOutSol);
  if (!Number.isFinite(signal) || signal <= 0 || !Number.isFinite(fill) || fill < 0) return null;
  return (signal - fill) / signal * 100;
}

export function partialResearchExitAccounting({
  baselineRealizedPnlSol = 0,
  baselineRealizedFeeSol = 0,
  soldCostSol,
  fillOutSol,
  exitFeeSol,
} = {}) {
  const cost = finiteNonNegative(soldCostSol, NaN);
  const output = finiteNonNegative(fillOutSol, NaN);
  const fee = finiteNonNegative(exitFeeSol, 0);
  const baselinePnl = finiteNumber(baselineRealizedPnlSol, 0);
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(output)) return null;
  const legNetPnlSol = output - cost - fee;
  return {
    legNetPnlSol,
    realizedPnlSol: baselinePnl + legNetPnlSol,
    realizedFeeSol: finiteNonNegative(baselineRealizedFeeSol, 0) + fee,
    soldCostSol: cost,
    fillOutSol: output,
    exitFeeSol: fee,
  };
}

export function finalResearchExitAccounting({
  baselineRealizedPnlSol = 0,
  realizedCostSol = 0,
  remainingCostSol,
  entryFeeSol = 0,
  realizedFeeSol = 0,
  fillOutSol,
  exitFeeSol,
} = {}) {
  const remainingCost = finiteNonNegative(remainingCostSol, NaN);
  const output = finiteNonNegative(fillOutSol, NaN);
  const entryFee = finiteNonNegative(entryFeeSol, 0);
  const priorFees = finiteNonNegative(realizedFeeSol, 0);
  const exitFee = finiteNonNegative(exitFeeSol, 0);
  const priorCost = finiteNonNegative(realizedCostSol, 0);
  const priorPnl = finiteNumber(baselineRealizedPnlSol, NaN);
  if (!Number.isFinite(priorPnl) || !Number.isFinite(remainingCost) || remainingCost <= 0 || !Number.isFinite(output)) return null;

  const pnlSol = priorPnl + output - remainingCost - entryFee - exitFee;
  const costBasisSol = priorCost + remainingCost + entryFee + priorFees + exitFee;
  return {
    pnlSol,
    pnlPercent: costBasisSol > 0 ? pnlSol / costBasisSol * 100 : null,
    costBasisSol,
    fillOutSol: output,
    exitFeeSol: exitFee,
  };
}

export async function fetchResearchExitExecutionProfile({
  mint,
  rawAmount,
  quoteFn = fetchTokenExitQuote,
  feeFn = estimateResearchTransactionFees,
  sleepFn = sleep,
} = {}) {
  const normalizedRaw = positiveRawAmount(rawAmount);
  if (!mint || !normalizedRaw) throw new Error('Research Exit V3 requires mint and positive raw token amount.');

  const signalQuote = await quoteFn(mint, normalizedRaw);
  const signalOutSol = Number(signalQuote?.outSol);
  if (!Number.isFinite(signalOutSol) || signalOutSol < 0) {
    throw new Error('Research Exit V3 requires an executable signal exit quote.');
  }

  const signalAtMs = now();
  const configuredLatencyMs = configuredExitLatencyMs();
  const feePromise = Promise.resolve()
    .then(() => feeFn('exit'))
    .catch(error => fallbackExitFees(error));

  if (configuredLatencyMs > 0) await sleepFn(configuredLatencyMs);

  let fillQuote = null;
  let fillError = null;
  try {
    const requote = await quoteFn(mint, normalizedRaw);
    const outSol = Number(requote?.outSol);
    if (!Number.isFinite(outSol) || outSol < 0) throw new Error('invalid post-latency exit quote');
    fillQuote = requote;
  } catch (error) {
    fillError = error;
    fillQuote = signalQuote;
  }

  const fillAtMs = now();
  const fees = await feePromise;
  const fillOutSol = Number(fillQuote?.outSol);
  return {
    version: RESEARCH_EXIT_SIMULATOR_VERSION,
    mint,
    rawAmount: normalizedRaw,
    signalQuote,
    fillQuote,
    signalAtMs,
    fillAtMs,
    configuredLatencyMs,
    measuredQuoteToFillLatencyMs: Math.max(0, fillAtMs - signalAtMs),
    signalOutSol,
    fillOutSol,
    quoteDeteriorationPct: exitQuoteDeteriorationPct(signalOutSol, fillOutSol),
    fees,
    quality: fillError ? 'degraded_signal_quote_fallback' : 'latency_requoted_executable',
    fillError: fillError?.message || null,
  };
}

export function ensureResearchExitSimulatorSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_exit_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL UNIQUE,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_amount TEXT NOT NULL,
      sold_cost_sol REAL NOT NULL,
      baseline_realized_pnl_sol REAL NOT NULL DEFAULT 0,
      baseline_realized_fee_sol REAL NOT NULL DEFAULT 0,
      legacy_pnl_delta_sol REAL NOT NULL DEFAULT 0,
      legacy_fee_delta_sol REAL NOT NULL DEFAULT 0,
      signal_at_ms INTEGER,
      fill_at_ms INTEGER,
      configured_latency_ms INTEGER,
      measured_latency_ms INTEGER,
      signal_out_sol REAL,
      fill_out_sol REAL,
      quote_deterioration_pct REAL,
      fee_sol REAL,
      quality TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at_ms INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_exit_settlements_status_retry
      ON research_exit_settlements(status, next_retry_at_ms);
    CREATE INDEX IF NOT EXISTS idx_research_exit_settlements_position
      ON research_exit_settlements(position_id, trade_id);
  `);
}

function settlementByTradeId(tradeId) {
  ensureResearchExitSimulatorSchema();
  return db.prepare('SELECT * FROM research_exit_settlements WHERE trade_id = ?').get(tradeId) || null;
}

export function researchPositionHasPendingExitSettlement(positionId) {
  ensureResearchExitSimulatorSchema();
  const id = Number(positionId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return Boolean(db.prepare(`
    SELECT id FROM research_exit_settlements
    WHERE position_id = ? AND status = 'pending'
    LIMIT 1
  `).get(id));
}

function pendingPriorPartialSettlement(positionId, tradeId) {
  return db.prepare(`
    SELECT id, trade_id FROM research_exit_settlements
    WHERE position_id = ? AND kind = 'partial' AND status = 'pending' AND trade_id < ?
    ORDER BY trade_id ASC LIMIT 1
  `).get(positionId, tradeId) || null;
}

function insertPendingSettlement({
  trade,
  position,
  kind,
  rawAmount,
  soldCostSol,
  baselineRealizedPnlSol = 0,
  baselineRealizedFeeSol = 0,
  legacyPnlDeltaSol = 0,
  legacyFeeDeltaSol = 0,
  payload = {},
}) {
  ensureResearchExitSimulatorSchema();
  const existing = settlementByTradeId(trade.id);
  if (existing) return existing;
  const at = now();
  db.prepare(`
    INSERT INTO research_exit_settlements (
      trade_id, position_id, mint, kind, reason, status, raw_amount, sold_cost_sol,
      baseline_realized_pnl_sol, baseline_realized_fee_sol,
      legacy_pnl_delta_sol, legacy_fee_delta_sol, payload_json, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.id,
    position.id,
    position.mint,
    kind,
    trade.reason || null,
    String(rawAmount),
    soldCostSol,
    finiteNumber(baselineRealizedPnlSol, 0),
    finiteNonNegative(baselineRealizedFeeSol, 0),
    finiteNumber(legacyPnlDeltaSol, 0),
    finiteNumber(legacyFeeDeltaSol, 0),
    JSON.stringify(payload),
    at,
    at,
  );
  return settlementByTradeId(trade.id);
}

function retryDelayMs(attemptCount) {
  const base = Math.max(5_000, Math.min(5 * 60_000, Math.floor(numSetting('research_exit_retry_base_ms', 30_000))));
  return Math.min(15 * 60_000, base * Math.max(1, 2 ** Math.min(5, Math.max(0, attemptCount - 1))));
}

function markSettlementError(row, error) {
  const attempts = Number(row.attempt_count || 0) + 1;
  db.prepare(`
    UPDATE research_exit_settlements
    SET attempt_count = ?, next_retry_at_ms = ?, last_error = ?, updated_at_ms = ?
    WHERE id = ? AND status = 'pending'
  `).run(attempts, now() + retryDelayMs(attempts), String(error?.message || error).slice(0, 1000), now(), row.id);
}

function updateTradePayload(tradeId, patch) {
  const trade = db.prepare('SELECT payload_json FROM dry_run_trades WHERE id = ?').get(tradeId);
  if (!trade) return;
  const payload = parseJson(trade.payload_json, {});
  db.prepare('UPDATE dry_run_trades SET payload_json = ? WHERE id = ?').run(
    JSON.stringify({ ...payload, researchExitV3: patch }),
    tradeId,
  );
}

async function completePendingSettlement(row, { quoteFn, feeFn, sleepFn } = {}) {
  if (!row || row.status !== 'pending') return null;
  if (Number(row.next_retry_at_ms || 0) > now()) return null;

  if (row.kind === 'final') {
    const dependency = pendingPriorPartialSettlement(row.position_id, row.trade_id);
    if (dependency) {
      return {
        ok: false,
        pending: true,
        settlementId: row.id,
        kind: 'final',
        positionId: row.position_id,
        blockedBy: 'pending_prior_partial',
        dependencySettlementId: dependency.id,
      };
    }
  }

  let profile;
  try {
    profile = await fetchResearchExitExecutionProfile({
      mint: row.mint,
      rawAmount: row.raw_amount,
      quoteFn: quoteFn || fetchTokenExitQuote,
      feeFn: feeFn || estimateResearchTransactionFees,
      sleepFn: sleepFn || sleep,
    });
  } catch (error) {
    markSettlementError(row, error);
    return { ok: false, pending: true, settlementId: row.id, error: error.message };
  }

  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(row.position_id);
  const trade = db.prepare('SELECT * FROM dry_run_trades WHERE id = ?').get(row.trade_id);
  if (!position || !trade || position.execution_mode !== 'research') {
    const error = new Error('Research Exit V3 settlement lost its research position/trade identity.');
    markSettlementError(row, error);
    return { ok: false, pending: true, settlementId: row.id, error: error.message };
  }

  const exitFeeSol = finiteNonNegative(profile.fees?.totalFeeSol, 0);
  let adjustedResult = null;
  let accounting = null;
  let accountingBaseline = null;

  try {
    db.transaction(() => {
      const current = db.prepare('SELECT status FROM research_exit_settlements WHERE id = ?').get(row.id);
      if (current?.status !== 'pending') return;

      if (row.kind === 'partial') {
        accountingBaseline = {
          realizedPnlSol: finiteNumber(row.baseline_realized_pnl_sol, 0),
          realizedFeeSol: finiteNonNegative(row.baseline_realized_fee_sol, 0),
        };
        accounting = partialResearchExitAccounting({
          baselineRealizedPnlSol: accountingBaseline.realizedPnlSol,
          baselineRealizedFeeSol: accountingBaseline.realizedFeeSol,
          soldCostSol: row.sold_cost_sol,
          fillOutSol: profile.fillOutSol,
          exitFeeSol,
        });
        if (!accounting) throw new Error('Invalid Research Exit V3 partial accounting inputs.');
        db.prepare(`
          UPDATE dry_run_positions
          SET realized_pnl_sol = ?, realized_fee_sol = ?, research_data_quality = ?
          WHERE id = ? AND execution_mode = 'research'
        `).run(accounting.realizedPnlSol, accounting.realizedFeeSol, profile.quality, position.id);
      } else {
        // A final settlement may have been inserted while an earlier partial leg
        // was still waiting for executable evidence. Use the latest corrected
        // partial ledger at completion time, never the stale insertion snapshot.
        accountingBaseline = {
          realizedPnlSol: finiteNumber(position.realized_pnl_sol, 0),
          realizedFeeSol: finiteNonNegative(position.realized_fee_sol, 0),
        };
        accounting = finalResearchExitAccounting({
          baselineRealizedPnlSol: accountingBaseline.realizedPnlSol,
          realizedCostSol: position.realized_cost_sol,
          remainingCostSol: row.sold_cost_sol,
          entryFeeSol: position.entry_fee_sol,
          realizedFeeSol: accountingBaseline.realizedFeeSol,
          fillOutSol: profile.fillOutSol,
          exitFeeSol,
        });
        if (!accounting) throw new Error('Invalid Research Exit V3 final accounting inputs.');
        const ratio = Number(row.sold_cost_sol) > 0 ? Number(profile.fillOutSol) / Number(row.sold_cost_sol) : null;
        const exitPrice = Number.isFinite(ratio) && Number(position.entry_price) > 0 ? Number(position.entry_price) * ratio : position.exit_price;
        const exitMcap = Number.isFinite(ratio) && Number(position.entry_mcap) > 0 ? Number(position.entry_mcap) * ratio : position.exit_mcap;
        db.prepare(`
          UPDATE dry_run_positions
          SET exit_price = ?, exit_mcap = ?, pnl_sol = ?, pnl_percent = ?, exit_fee_sol = ?,
              modeled_exit_fee_sol = ?, modeled_net_pnl_sol = ?, modeled_net_pnl_percent = ?,
              research_data_quality = ?
          WHERE id = ? AND execution_mode = 'research' AND status = 'closed'
        `).run(
          exitPrice,
          exitMcap,
          accounting.pnlSol,
          accounting.pnlPercent,
          exitFeeSol,
          exitFeeSol,
          accounting.pnlSol,
          accounting.pnlPercent,
          profile.quality,
          position.id,
        );
        db.prepare('UPDATE dry_run_trades SET price = ?, mcap = ? WHERE id = ?').run(exitPrice, exitMcap, trade.id);
        adjustedResult = {
          ...position,
          status: 'closed',
          exitReason: position.exit_reason || trade.reason,
          exit_reason: position.exit_reason || trade.reason,
          exit_price: exitPrice,
          exit_mcap: exitMcap,
          price: exitPrice,
          mcap: exitMcap,
          pnlSol: accounting.pnlSol,
          pnl_sol: accounting.pnlSol,
          pnlPercent: accounting.pnlPercent,
          pnl_percent: accounting.pnlPercent,
        };
      }

      const settlementPayload = {
        version: RESEARCH_EXIT_SIMULATOR_VERSION,
        kind: row.kind,
        reason: row.reason,
        accounting,
        accountingBaseline,
        profile,
        replacedLegacy: {
          pnlDeltaSol: Number(row.legacy_pnl_delta_sol || 0),
          feeDeltaSol: Number(row.legacy_fee_delta_sol || 0),
        },
      };
      updateTradePayload(trade.id, settlementPayload);
      db.prepare(`
        UPDATE research_exit_settlements
        SET status = 'completed', signal_at_ms = ?, fill_at_ms = ?, configured_latency_ms = ?,
            measured_latency_ms = ?, signal_out_sol = ?, fill_out_sol = ?, quote_deterioration_pct = ?,
            fee_sol = ?, quality = ?, attempt_count = attempt_count + 1, next_retry_at_ms = 0,
            last_error = NULL, payload_json = ?, updated_at_ms = ?
        WHERE id = ?
      `).run(
        profile.signalAtMs,
        profile.fillAtMs,
        profile.configuredLatencyMs,
        profile.measuredQuoteToFillLatencyMs,
        profile.signalOutSol,
        profile.fillOutSol,
        profile.quoteDeteriorationPct,
        exitFeeSol,
        profile.quality,
        JSON.stringify(settlementPayload),
        now(),
        row.id,
      );
    })();
  } catch (error) {
    markSettlementError(row, error);
    return { ok: false, pending: true, settlementId: row.id, error: error.message };
  }

  return {
    ok: true,
    pending: false,
    settlementId: row.id,
    kind: row.kind,
    positionId: position.id,
    tradeId: trade.id,
    profile,
    accounting,
    result: adjustedResult,
  };
}

export async function settleResearchPartialExitV3({ beforePosition, cycleStartedAtMs = 0, quoteFn, feeFn, sleepFn } = {}) {
  ensureResearchExitSimulatorSchema();
  if (!beforePosition || beforePosition.execution_mode !== 'research' || !positiveRawAmount(beforePosition.token_amount_raw)) return null;

  const after = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(beforePosition.id);
  if (!after || after.execution_mode !== 'research') return null;
  const beforeRaw = BigInt(String(beforePosition.token_amount_raw));
  const afterRawText = positiveRawAmount(after.token_amount_raw);
  if (!afterRawText) return null;
  const afterRaw = BigInt(afterRawText);
  if (afterRaw >= beforeRaw) return null;
  const soldRaw = beforeRaw - afterRaw;

  const trade = db.prepare(`
    SELECT t.* FROM dry_run_trades t
    LEFT JOIN research_exit_settlements s ON s.trade_id = t.id
    WHERE t.position_id = ? AND t.side = 'sell' AND t.reason LIKE 'PARTIAL_TP%'
      AND t.at_ms >= ? AND s.id IS NULL
    ORDER BY t.id DESC LIMIT 1
  `).get(beforePosition.id, Number(cycleStartedAtMs || 0));
  if (!trade) return null;

  const baselinePnl = finiteNumber(beforePosition.realized_pnl_sol, 0);
  const baselineFee = finiteNonNegative(beforePosition.realized_fee_sol, 0);
  const baselineCost = finiteNonNegative(beforePosition.realized_cost_sol, 0);
  const afterPnl = finiteNumber(after.realized_pnl_sol, 0);
  const afterFee = finiteNonNegative(after.realized_fee_sol, 0);
  const afterCost = finiteNonNegative(after.realized_cost_sol, 0);
  const soldCostSol = afterCost - baselineCost;
  if (!Number.isFinite(soldCostSol) || soldCostSol <= 0) return null;

  const settlement = insertPendingSettlement({
    trade,
    position: beforePosition,
    kind: 'partial',
    rawAmount: soldRaw.toString(),
    soldCostSol,
    baselineRealizedPnlSol: baselinePnl,
    baselineRealizedFeeSol: baselineFee,
    legacyPnlDeltaSol: afterPnl - baselinePnl,
    legacyFeeDeltaSol: afterFee - baselineFee,
    payload: { cycleStartedAtMs, beforeRaw: beforeRaw.toString(), afterRaw: afterRaw.toString() },
  });
  return completePendingSettlement(settlement, { quoteFn, feeFn, sleepFn });
}

export async function settleResearchFinalExitV3({ beforePosition, result, quoteFn, feeFn, sleepFn } = {}) {
  ensureResearchExitSimulatorSchema();
  if (!beforePosition || beforePosition.execution_mode !== 'research' || !result?.exitReason) return null;
  const rawAmount = positiveRawAmount(beforePosition.token_amount_raw);
  if (!rawAmount || !(Number(beforePosition.size_sol) > 0)) return null;

  const trade = db.prepare(`
    SELECT t.* FROM dry_run_trades t
    LEFT JOIN research_exit_settlements s ON s.trade_id = t.id
    WHERE t.position_id = ? AND t.side = 'sell' AND t.reason = ? AND s.id IS NULL
    ORDER BY t.id DESC LIMIT 1
  `).get(beforePosition.id, result.exitReason);
  if (!trade) return null;

  const settlement = insertPendingSettlement({
    trade,
    position: beforePosition,
    kind: 'final',
    rawAmount,
    soldCostSol: Number(beforePosition.size_sol),
    baselineRealizedPnlSol: finiteNumber(beforePosition.realized_pnl_sol, 0),
    baselineRealizedFeeSol: finiteNonNegative(beforePosition.realized_fee_sol, 0),
    legacyPnlDeltaSol: finiteNumber(result.pnlSol ?? result.pnl_sol, 0),
    legacyFeeDeltaSol: finiteNonNegative(beforePosition.exit_fee_sol, 0),
    payload: { exitReason: result.exitReason },
  });
  return completePendingSettlement(settlement, { quoteFn, feeFn, sleepFn });
}

export async function resumePendingResearchExitSettlements({ limit = 5, quoteFn, feeFn, sleepFn } = {}) {
  ensureResearchExitSimulatorSchema();
  const rows = db.prepare(`
    SELECT * FROM research_exit_settlements
    WHERE status = 'pending' AND next_retry_at_ms <= ?
    ORDER BY id ASC LIMIT ?
  `).all(now(), Math.max(1, Math.min(50, Number(limit) || 5)));
  const results = [];
  for (const row of rows) {
    results.push(await completePendingSettlement(row, { quoteFn, feeFn, sleepFn }));
  }
  return results.filter(Boolean);
}
