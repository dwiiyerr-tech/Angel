import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { ensureResearchSchema } from '../../src/research/schema.js';
import { recordResearchObservation } from '../../src/research/engine.js';
import {
  ensureResearchExitSimulatorSchema,
  settleResearchFinalExitV3,
} from '../../src/research/exitSimulator.js';

ensureResearchSchema();
ensureResearchExitSimulatorSchema();

const mint = `research-exit-observation-${Date.now()}`;
const inserted = db.prepare(`
  INSERT INTO dry_run_positions (
    mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
    token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
    trailing_enabled, trailing_percent, trailing_armed, execution_mode,
    token_amount_raw, strategy_id, entry_fee_sol, snapshot_json,
    real_capital_sol, sim_notional_sol, initial_risk_percent, initial_risk_sol,
    planned_rr, realized_pnl_sol, realized_cost_sol, realized_fee_sol
  ) VALUES (?, 'OBS', 'open', ?, 0.05, 0.000001, 100000,
    1000, 0.000001, 100000, 60, -15, 1, 20, 0, 'research',
    '1000000', 'sniper', 0.00001, '{}', 0, 0.05, 15, 0.0075,
    4, 0, 0, 0)
`).run(mint, Date.now() - 60_000);
const positionId = Number(inserted.lastInsertRowid);
const beforeFinal = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);

db.prepare(`
  UPDATE dry_run_positions
  SET status = 'closed', closed_at_ms = ?, exit_reason = 'TRAILING_TP',
      exit_price = 0.0000012, exit_mcap = 120000,
      pnl_sol = 0.01, pnl_percent = 20, exit_fee_sol = 0.000005
  WHERE id = ?
`).run(Date.now(), positionId);
db.prepare(`
  INSERT INTO dry_run_trades (
    position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json
  ) VALUES (?, ?, 'sell', ?, 0.0000012, 120000, 0.05, 1000, 'TRAILING_TP', '{}')
`).run(positionId, mint, Date.now());

let quoteCalls = 0;
const settlement = await settleResearchFinalExitV3({
  beforePosition: beforeFinal,
  result: { exitReason: 'TRAILING_TP', pnlSol: 0.01, pnlPercent: 20 },
  quoteFn: async () => ([{ outSol: 0.06 }, { outSol: 0.059 }][quoteCalls++]),
  feeFn: async () => ({ totalFeeSol: 0.00002, quality: 'dynamic' }),
  sleepFn: async () => {},
});
assert.equal(settlement?.ok, true);
const expectedNet = 0.059 - 0.05 - 0.00001 - 0.00002;
assert.equal(Number(settlement.accounting.pnlSol.toFixed(8)), Number(expectedNet.toFixed(8)));

const observation = recordResearchObservation(positionId, settlement.result, {
  exitFees: settlement.profile.fees,
});
assert.ok(observation);
assert.equal(Number(observation.pnlSol.toFixed(8)), Number(expectedNet.toFixed(8)));
const closed = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
assert.equal(Number(closed.pnl_sol.toFixed(8)), Number(expectedNet.toFixed(8)));
assert.equal(Number(closed.modeled_net_pnl_sol.toFixed(8)), Number(expectedNet.toFixed(8)));
assert.equal(Number(closed.exit_fee_sol.toFixed(8)), 0.00002);

// Cleanup shared unit-test database.
db.prepare('DELETE FROM research_exit_settlements WHERE position_id = ?').run(positionId);
db.prepare('DELETE FROM dry_run_trades WHERE position_id = ?').run(positionId);
db.prepare('DELETE FROM dry_run_positions WHERE id = ?').run(positionId);

console.log('[research-exit-v3-observation] final V3 net PnL survives observation without fee double-counting');
