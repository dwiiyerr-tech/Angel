import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { ensureResearchSchema } from '../../src/research/schema.js';
import {
  ensureResearchExitSimulatorSchema,
  exitQuoteDeteriorationPct,
  fetchResearchExitExecutionProfile,
  finalResearchExitAccounting,
  partialResearchExitAccounting,
  settleResearchFinalExitV3,
  settleResearchPartialExitV3,
  RESEARCH_EXIT_SIMULATOR_VERSION,
} from '../../src/research/exitSimulator.js';

assert.equal(Number(exitQuoteDeteriorationPct(0.06, 0.057).toFixed(4)), 5);
assert.equal(exitQuoteDeteriorationPct(null, 0.057), null);

const partial = partialResearchExitAccounting({
  baselineRealizedPnlSol: -0.002,
  baselineRealizedFeeSol: 0.00001,
  soldCostSol: 0.01,
  fillOutSol: 0.013,
  exitFeeSol: 0.00002,
});
assert.ok(partial);
assert.equal(Number(partial.legNetPnlSol.toFixed(8)), 0.00298);
assert.equal(Number(partial.realizedPnlSol.toFixed(8)), 0.00098);
assert.equal(Number(partial.realizedFeeSol.toFixed(8)), 0.00003);

const final = finalResearchExitAccounting({
  baselineRealizedPnlSol: 0.003,
  realizedCostSol: 0.01,
  remainingCostSol: 0.04,
  entryFeeSol: 0.00001,
  realizedFeeSol: 0.00002,
  fillOutSol: 0.052,
  exitFeeSol: 0.00003,
});
assert.ok(final);
assert.equal(Number(final.pnlSol.toFixed(8)), 0.01496);
assert.ok(final.pnlPercent > 29.8 && final.pnlPercent < 30);

let quoteCalls = 0;
let sleptMs = null;
const quotes = [
  { outSol: 0.06, outAmount: '60000000' },
  { outSol: 0.057, outAmount: '57000000' },
];
const profile = await fetchResearchExitExecutionProfile({
  mint: 'mint-v3-test',
  rawAmount: '123456789',
  quoteFn: async (_mint, rawAmount) => {
    assert.equal(rawAmount, '123456789');
    return quotes[quoteCalls++];
  },
  feeFn: async side => ({ side, totalFeeSol: 0.00002, quality: 'dynamic' }),
  sleepFn: async ms => { sleptMs = ms; },
});
assert.equal(profile.version, RESEARCH_EXIT_SIMULATOR_VERSION);
assert.equal(profile.signalOutSol, 0.06);
assert.equal(profile.fillOutSol, 0.057);
assert.equal(Number(profile.quoteDeteriorationPct.toFixed(4)), 5);
assert.equal(profile.quality, 'latency_requoted_executable');
assert.ok(Number.isFinite(sleptMs) && sleptMs >= 0);
assert.equal(profile.fees.totalFeeSol, 0.00002);

quoteCalls = 0;
const degraded = await fetchResearchExitExecutionProfile({
  mint: 'mint-v3-degraded',
  rawAmount: '99',
  quoteFn: async () => {
    quoteCalls += 1;
    if (quoteCalls === 1) return { outSol: 0.02, outAmount: '20000000' };
    throw new Error('requote unavailable');
  },
  feeFn: async () => ({ totalFeeSol: 0.00001, quality: 'dynamic' }),
  sleepFn: async () => {},
});
assert.equal(degraded.fillOutSol, 0.02);
assert.equal(degraded.quality, 'degraded_signal_quote_fallback');
assert.match(degraded.fillError, /requote unavailable/);

ensureResearchSchema();
ensureResearchExitSimulatorSchema();
const columns = db.pragma('table_info(research_exit_settlements)').map(row => row.name);
for (const required of ['trade_id', 'status', 'raw_amount', 'fill_out_sol', 'quote_deterioration_pct', 'fee_sol']) {
  assert.ok(columns.includes(required), `missing research_exit_settlements.${required}`);
}
const indexes = db.pragma('index_list(research_exit_settlements)').map(row => row.name);
assert.ok(indexes.some(name => name.includes('status_retry')));

// Integration regression: emulate the shared engine's legacy partial update, then
// prove V3 replaces only settlement economics and remains idempotent through the
// final exit. No network, wallet, signer, or broadcast is used in this test.
const mint = `research-exit-v3-${Date.now()}`;
const openedAt = Date.now() - 60_000;
const insertPosition = db.prepare(`
  INSERT INTO dry_run_positions (
    mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
    token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
    trailing_enabled, trailing_percent, trailing_armed, execution_mode,
    token_amount_raw, strategy_id, entry_fee_sol, snapshot_json,
    real_capital_sol, sim_notional_sol, initial_risk_percent, initial_risk_sol,
    planned_rr, realized_pnl_sol, realized_cost_sol, realized_fee_sol
  ) VALUES (?, 'V3', 'open', ?, 0.05, 0.000001, 100000,
    1000, 0.000001, 100000, 60, -15, 1, 20, 0, 'research',
    '1000000', 'sniper', 0.00001, '{}', 0, 0.05, 15, 0.0075,
    4, 0, 0, 0)
`).run(mint, openedAt);
const positionId = Number(insertPosition.lastInsertRowid);
const beforePartial = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
const partialCycleStart = Date.now() - 10;

db.prepare(`
  UPDATE dry_run_positions
  SET token_amount_raw = '750000', token_amount_est = -249000,
      size_sol = 0.0375, realized_cost_sol = 0.0125,
      realized_pnl_sol = 0.001, realized_fee_sol = 0.000005,
      partial_tp_done = 1
  WHERE id = ?
`).run(positionId);
const partialTrade = db.prepare(`
  INSERT INTO dry_run_trades (
    position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json
  ) VALUES (?, ?, 'sell', ?, 0.0000012, 120000, 0.0125, 250000, 'PARTIAL_TP_DEFAULT', '{}')
`).run(positionId, mint, Date.now());

let partialQuoteCall = 0;
const partialSettlement = await settleResearchPartialExitV3({
  beforePosition: beforePartial,
  cycleStartedAtMs: partialCycleStart,
  quoteFn: async () => ([{ outSol: 0.015 }, { outSol: 0.014 }][partialQuoteCall++]),
  feeFn: async () => ({ totalFeeSol: 0.00002, quality: 'dynamic' }),
  sleepFn: async () => {},
});
assert.equal(partialSettlement.ok, true);
assert.equal(partialSettlement.kind, 'partial');
let afterPartial = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
assert.equal(Number(afterPartial.realized_pnl_sol.toFixed(8)), 0.00148);
assert.equal(Number(afterPartial.realized_fee_sol.toFixed(8)), 0.00002);
assert.equal(afterPartial.token_amount_raw, '750000');
let partialSettlementRow = db.prepare('SELECT * FROM research_exit_settlements WHERE trade_id = ?').get(Number(partialTrade.lastInsertRowid));
assert.equal(partialSettlementRow.status, 'completed');
assert.equal(Number(partialSettlementRow.quote_deterioration_pct.toFixed(4)), Number(((0.015 - 0.014) / 0.015 * 100).toFixed(4)));

const beforeFinal = { ...afterPartial };
db.prepare(`
  UPDATE dry_run_positions
  SET status = 'closed', closed_at_ms = ?, exit_reason = 'TRAILING_TP',
      exit_price = 0.0000013, exit_mcap = 130000, pnl_sol = 0.01, pnl_percent = 20,
      exit_fee_sol = 0.000005
  WHERE id = ?
`).run(Date.now(), positionId);
const finalTrade = db.prepare(`
  INSERT INTO dry_run_trades (
    position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json
  ) VALUES (?, ?, 'sell', ?, 0.0000013, 130000, 0.0375, 750, 'TRAILING_TP', '{}')
`).run(positionId, mint, Date.now());

let finalQuoteCall = 0;
const finalSettlement = await settleResearchFinalExitV3({
  beforePosition: beforeFinal,
  result: { exitReason: 'TRAILING_TP', pnlSol: 0.01, pnlPercent: 20 },
  quoteFn: async () => ([{ outSol: 0.05 }, { outSol: 0.049 }][finalQuoteCall++]),
  feeFn: async () => ({ totalFeeSol: 0.00003, quality: 'dynamic' }),
  sleepFn: async () => {},
});
assert.equal(finalSettlement.ok, true);
assert.equal(finalSettlement.kind, 'final');
const closed = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
assert.equal(Number(closed.pnl_sol.toFixed(8)), 0.01294);
assert.equal(Number(closed.exit_fee_sol.toFixed(8)), 0.00003);
assert.equal(Number(closed.modeled_net_pnl_sol.toFixed(8)), 0.01294);
assert.ok(closed.pnl_percent > 25.8 && closed.pnl_percent < 25.9);
const finalSettlementRow = db.prepare('SELECT * FROM research_exit_settlements WHERE trade_id = ?').get(Number(finalTrade.lastInsertRowid));
assert.equal(finalSettlementRow.status, 'completed');
const finalPayload = JSON.parse(db.prepare('SELECT payload_json FROM dry_run_trades WHERE id = ?').get(Number(finalTrade.lastInsertRowid)).payload_json);
assert.equal(finalPayload.researchExitV3.version, RESEARCH_EXIT_SIMULATOR_VERSION);

// A second settlement attempt cannot double-apply the final sell.
const duplicateFinal = await settleResearchFinalExitV3({
  beforePosition: beforeFinal,
  result: { exitReason: 'TRAILING_TP', pnlSol: 0.01 },
  quoteFn: async () => { throw new Error('must not be called for settled trade'); },
  feeFn: async () => ({ totalFeeSol: 1 }),
  sleepFn: async () => {},
});
assert.equal(duplicateFinal, null);
assert.equal(db.prepare('SELECT count(*) AS count FROM research_exit_settlements WHERE position_id = ?').get(positionId).count, 2);

// Clean the shared test database for later unit files.
db.prepare('DELETE FROM research_exit_settlements WHERE position_id = ?').run(positionId);
db.prepare('DELETE FROM dry_run_trades WHERE position_id = ?').run(positionId);
db.prepare('DELETE FROM dry_run_positions WHERE id = ?').run(positionId);

console.log('[research-exit-v3] math, latency re-quote, degraded fallback, durable schema, partial/final ledger, and idempotence passed');
