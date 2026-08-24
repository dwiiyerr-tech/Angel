import assert from 'node:assert/strict';
import { db, initDb } from '../../src/db/connection.js';
import { ensureLiveSafetySchema } from '../../src/db/liveSafety.js';
import { claimExecutionOperation, updateExecutionOperation } from '../../src/db/executionOperations.js';

console.log('[test_live_sell_ledger_gate_v3] Starting finalized-sell ledger gate tests...');

initDb();
ensureLiveSafetySchema();
const previousMode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
db.prepare("UPDATE settings SET value = 'live' WHERE key = 'trading_mode'").run();

const mint = `SellLedgerV3_${Date.now()}`;
const at = Date.now();
const inserted = db.prepare(`
  INSERT INTO dry_run_positions (
    mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
    tp_percent, sl_percent, trailing_enabled, trailing_percent, trailing_armed,
    execution_mode, entry_signature, token_amount_raw, snapshot_json
  ) VALUES (?, 'SLG', 'open', ?, 0.05, 0.001, 100000, 60, -15, 1, 10, 0, 'live', ?, '1000', '{}')
`).run(mint, at, `${mint}_entry`);
const positionId = Number(inserted.lastInsertRowid);

// Partial sell: chain finality alone must not mark the operation completed.
let claim = claimExecutionOperation({ mint, side: 'sell', positionId, inputAmount: '200' });
assert.equal(claim.ok, true);
updateExecutionOperation(claim.operationId, 'completed', {
  positionId,
  signature: `${mint}_partial_sig`,
  outputAmount: '10000000',
  finalizedAtMs: Date.now(),
});
let op = db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(claim.operationId);
assert.equal(op.status, 'outcome_unknown');
assert.equal(op.error, 'finalized_sell_pending_position_ledger');

// The normal position mutation completes the operation through the SQLite
// trigger, atomically with the state that prevents a duplicate sell.
db.prepare(`
  UPDATE dry_run_positions
  SET partial_tp_done = 1, token_amount_raw = '800', size_sol = 0.04
  WHERE id = ?
`).run(positionId);
op = db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(claim.operationId);
assert.equal(op.status, 'completed');
assert.equal(op.error, null);

// Full exit after a prior partial must still be gated; partial_tp_done=1 must
// not accidentally make a newly finalized full sell look ledger-complete.
claim = claimExecutionOperation({ mint, side: 'sell', positionId, inputAmount: '800' });
assert.equal(claim.ok, true);
updateExecutionOperation(claim.operationId, 'completed', {
  positionId,
  signature: `${mint}_full_sig`,
  outputAmount: '45000000',
  finalizedAtMs: Date.now(),
});
op = db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(claim.operationId);
assert.equal(op.status, 'outcome_unknown');
assert.equal(op.error, 'finalized_sell_pending_position_ledger');

db.prepare(`
  UPDATE dry_run_positions
  SET status = 'closed', closed_at_ms = ?, exit_signature = ?, token_amount_raw = '0'
  WHERE id = ?
`).run(Date.now(), `${mint}_full_sig`, positionId);
op = db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(claim.operationId);
assert.equal(op.status, 'completed');
assert.equal(op.error, null);

// Cleanup isolated fixture.
db.prepare('DELETE FROM dry_run_positions WHERE id = ?').run(positionId);
db.prepare('DELETE FROM execution_operations WHERE mint = ?').run(mint);
db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(previousMode, 'trading_mode');

console.log('[test_live_sell_ledger_gate_v3] SUCCESS: finalized sells cannot outrun their position ledger commit.');
