import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { setSetting, setting } from '../../src/db/settings.js';
import { paperWalletSummary } from '../../src/research/virtualWallet.js';

const previousInitialBalance = setting('paper_initial_balance_sol', '10');
setSetting('paper_initial_balance_sol', '5');
const before = paperWalletSummary();
const now = Date.now();
const insert = db.prepare(`
  INSERT INTO dry_run_positions (
    mint, symbol, status, opened_at_ms, size_sol, entry_mcap,
    tp_percent, sl_percent, trailing_enabled, trailing_percent,
    execution_mode, snapshot_json, entry_fee_sol, realized_pnl_sol,
    realized_cost_sol, mark_pnl_sol, pnl_sol
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dry_run', '{}', ?, ?, ?, ?, ?)
`);

const closed = insert.run('virtual-wallet-closed', 'CLOSED', 'closed', now, 0.1, 1000, 25, -15, 1, 10, 0.000005, 0.02, 0, null, 0.02).lastInsertRowid;
const open = insert.run('virtual-wallet-open', 'OPEN', 'open', now, 0.2, 1000, 25, -15, 1, 10, 0.000005, 0.01, 0.2, 0.03, null).lastInsertRowid;

const summary = paperWalletSummary();
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);
assert.equal(summary.initialBalanceSol, 5);
assert.equal(summary.openPositions, before.openPositions + 1);
assert.equal(summary.closedPositions, before.closedPositions + 1);
closeTo(summary.committedSol - before.committedSol, 0.400005);
closeTo(summary.realizedPnlSol - before.realizedPnlSol, 0.03);
closeTo(summary.unrealizedPnlSol - before.unrealizedPnlSol, 0.02);
closeTo(summary.totalPnlSol - before.totalPnlSol, 0.05);
closeTo(summary.equitySol - before.equitySol, 0.05);

db.prepare('DELETE FROM dry_run_positions WHERE id IN (?, ?)').run(closed, open);
setSetting('paper_initial_balance_sol', previousInitialBalance);
console.log('[virtual-wallet] PAPER equity, committed capital, and split PnL verified');
