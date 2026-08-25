import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { ensureResearchSchema } from '../../src/research/schema.js';
import {
  ensureResearchExitSimulatorSchema,
  researchPositionHasPendingExitSettlement,
  resumePendingResearchExitSettlements,
  settleResearchFinalExitV3,
  settleResearchPartialExitV3,
} from '../../src/research/exitSimulator.js';

ensureResearchSchema();
ensureResearchExitSimulatorSchema();

const mint = `research-exit-order-${Date.now()}`;
const openedAt = Date.now() - 60_000;
const inserted = db.prepare(`
  INSERT INTO dry_run_positions (
    mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
    token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
    trailing_enabled, trailing_percent, trailing_armed, execution_mode,
    token_amount_raw, strategy_id, entry_fee_sol, snapshot_json,
    real_capital_sol, sim_notional_sol, initial_risk_percent, initial_risk_sol,
    planned_rr, realized_pnl_sol, realized_cost_sol, realized_fee_sol
  ) VALUES (?, 'ORD', 'open', ?, 0.05, 0.000001, 100000,
    1000, 0.000001, 100000, 60, -15, 1, 20, 0, 'research',
    '1000000', 'sniper', 0.00001, '{}', 0, 0.05, 15, 0.0075,
    4, 0, 0, 0)
`).run(mint, openedAt);
const positionId = Number(inserted.lastInsertRowid);
const beforePartial = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
const cycleStartedAtMs = Date.now() - 10;

// Emulate the shared engine's legacy partial mutation. V3 must later replace
// only the settlement economics for this leg.
db.prepare(`
  UPDATE dry_run_positions
  SET token_amount_raw = '750000', token_amount_est = 750,
      size_sol = 0.0375, realized_cost_sol = 0.0125,
      realized_pnl_sol = 0.001, realized_fee_sol = 0.000005,
      partial_tp_done = 1
  WHERE id = ?
`).run(positionId);
const partialTrade = db.prepare(`
  INSERT INTO dry_run_trades (
    position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json
  ) VALUES (?, ?, 'sell', ?, 0.0000012, 120000, 0.0125, 250, 'PARTIAL_TP_DEFAULT', '{}')
`).run(positionId, mint, Date.now());

const pendingPartial = await settleResearchPartialExitV3({
  beforePosition: beforePartial,
  cycleStartedAtMs,
  quoteFn: async () => { throw new Error('temporary Jupiter outage'); },
  feeFn: async () => ({ totalFeeSol: 0.00002, quality: 'dynamic' }),
  sleepFn: async () => {},
});
assert.equal(pendingPartial?.pending, true);
assert.equal(researchPositionHasPendingExitSettlement(positionId), true);

const partialSettlementRow = db.prepare(
  'SELECT * FROM research_exit_settlements WHERE trade_id = ?'
).get(Number(partialTrade.lastInsertRowid));
assert.equal(partialSettlementRow.status, 'pending');

// Emulate a later final exit being written by the shared engine before the
// earlier partial settlement has recovered. Final V3 must create a durable row
// but must not quote/finalize ahead of the pending partial.
const beforeFinal = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
db.prepare(`
  UPDATE dry_run_positions
  SET status = 'closed', closed_at_ms = ?, exit_reason = 'TRAILING_TP',
      exit_price = 0.0000013, exit_mcap = 130000, pnl_sol = 0.01,
      pnl_percent = 20, exit_fee_sol = 0.000005
  WHERE id = ?
`).run(Date.now(), positionId);
const finalTrade = db.prepare(`
  INSERT INTO dry_run_trades (
    position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json
  ) VALUES (?, ?, 'sell', ?, 0.0000013, 130000, 0.0375, 750, 'TRAILING_TP', '{}')
`).run(positionId, mint, Date.now());

let prematureFinalQuoteCalls = 0;
const blockedFinal = await settleResearchFinalExitV3({
  beforePosition: beforeFinal,
  result: { exitReason: 'TRAILING_TP', pnlSol: 0.01, pnlPercent: 20 },
  quoteFn: async () => {
    prematureFinalQuoteCalls += 1;
    return { outSol: 0.05 };
  },
  feeFn: async () => ({ totalFeeSol: 0.00002, quality: 'dynamic' }),
  sleepFn: async () => {},
});
assert.equal(blockedFinal?.pending, true);
assert.equal(blockedFinal?.blockedBy, 'pending_prior_partial');
assert.equal(prematureFinalQuoteCalls, 0, 'final settlement must not quote before prior partial settles');

const finalPendingRow = db.prepare(
  'SELECT * FROM research_exit_settlements WHERE trade_id = ?'
).get(Number(finalTrade.lastInsertRowid));
assert.equal(finalPendingRow.status, 'pending');

// Make the failed partial immediately retryable, then resume in durable ID
// order. Partial must complete first; final must then use the corrected partial
// realized PnL/fee from the live position row at completion time.
db.prepare(`
  UPDATE research_exit_settlements
  SET next_retry_at_ms = 0
  WHERE position_id = ? AND status = 'pending'
`).run(positionId);

const quoteCallsByRaw = new Map();
const quoteFn = async (_mint, rawAmount) => {
  const count = quoteCallsByRaw.get(rawAmount) || 0;
  quoteCallsByRaw.set(rawAmount, count + 1);
  if (rawAmount === '250000') return count === 0 ? { outSol: 0.015 } : { outSol: 0.014 };
  if (rawAmount === '750000') return count === 0 ? { outSol: 0.05 } : { outSol: 0.049 };
  throw new Error(`unexpected raw amount ${rawAmount}`);
};
const feeFn = async () => ({ totalFeeSol: 0.00002, quality: 'dynamic' });

const resumed = await resumePendingResearchExitSettlements({
  limit: 10,
  quoteFn,
  feeFn,
  sleepFn: async () => {},
});
assert.equal(resumed.filter(row => row?.ok).length, 2);
assert.equal(researchPositionHasPendingExitSettlement(positionId), false);

const settledPartial = db.prepare(
  'SELECT * FROM research_exit_settlements WHERE trade_id = ?'
).get(Number(partialTrade.lastInsertRowid));
const settledFinal = db.prepare(
  'SELECT * FROM research_exit_settlements WHERE trade_id = ?'
).get(Number(finalTrade.lastInsertRowid));
assert.equal(settledPartial.status, 'completed');
assert.equal(settledFinal.status, 'completed');

const closed = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
assert.equal(Number(closed.realized_pnl_sol.toFixed(8)), 0.00148);
assert.equal(Number(closed.realized_fee_sol.toFixed(8)), 0.00002);
// Correct final baseline: 0.00148 + 0.049 - 0.0375 - 0.00001 - 0.00002.
assert.equal(Number(closed.pnl_sol.toFixed(8)), 0.01295);
assert.ok(closed.pnl_percent > 25.8 && closed.pnl_percent < 26);

const finalPayload = JSON.parse(
  db.prepare('SELECT payload_json FROM dry_run_trades WHERE id = ?').get(Number(finalTrade.lastInsertRowid)).payload_json
);
assert.equal(Number(finalPayload.researchExitV3.accountingBaseline.realizedPnlSol.toFixed(8)), 0.00148);
assert.equal(Number(finalPayload.researchExitV3.accountingBaseline.realizedFeeSol.toFixed(8)), 0.00002);

// Cleanup shared unit-test database.
db.prepare('DELETE FROM research_exit_settlements WHERE position_id = ?').run(positionId);
db.prepare('DELETE FROM dry_run_trades WHERE position_id = ?').run(positionId);
db.prepare('DELETE FROM dry_run_positions WHERE id = ?').run(positionId);

console.log('[research-exit-v3-order] pending partial settlement serializes final settlement and preserves corrected accounting');
