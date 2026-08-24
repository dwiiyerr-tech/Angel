import assert from 'node:assert/strict';
import { db, initDb } from '../../src/db/connection.js';
import { ensureLiveSafetySchema, activeLiveReservationSummary } from '../../src/db/liveSafety.js';
import { claimExecutionOperation, updateExecutionOperation } from '../../src/db/executionOperations.js';
import { deriveFinalizedSwapReceipt, sumParsedTokenAccountBalances } from '../../src/liveExecutor.js';
import { WSOL_MINT } from '../../src/config.js';

console.log('[test_live_safety_hardening_v2] Starting money-grade hardening tests...');

initDb();
ensureLiveSafetySchema();

const busyTimeout = Number(db.pragma('busy_timeout', { simple: true }));
const synchronous = Number(db.pragma('synchronous', { simple: true }));
assert(busyTimeout >= 5000, 'money-grade SQLite connection must wait for transient writer contention');
assert(synchronous >= 2, 'money-grade SQLite connection must use FULL-or-stronger synchronous durability');

assert.equal(sumParsedTokenAccountBalances([
  { account: { data: { parsed: { info: { tokenAmount: { amount: '100' } } } } } },
  { account: { data: { parsed: { info: { tokenAmount: { amount: '250' } } } } } },
  { account: { data: { parsed: { info: { tokenAmount: { amount: 'bad' } } } } } },
]), '350', 'all token accounts for the mint must be aggregated');

const wallet = 'Wallet11111111111111111111111111111111111';
const outputMint = 'Output11111111111111111111111111111111111';
const key = (value) => ({ toBase58: () => value });
const buyReceipt = deriveFinalizedSwapReceipt({
  slot: 10,
  blockTime: 123,
  transaction: { message: { staticAccountKeys: [key(wallet)] } },
  meta: {
    err: null,
    fee: 5000,
    preBalances: [1_000_000_000],
    postBalances: [899_995_000],
    preTokenBalances: [],
    postTokenBalances: [{ owner: wallet, mint: outputMint, uiTokenAmount: { amount: '777' } }],
  },
}, wallet, { inputMint: WSOL_MINT, outputMint });
assert.equal(buyReceipt.success, true);
assert.equal(buyReceipt.outputAmount, '777');
assert.equal(buyReceipt.feeLamports, 5000);

const inputMint = 'Input111111111111111111111111111111111111';
const sellReceipt = deriveFinalizedSwapReceipt({
  transaction: { message: { staticAccountKeys: [key(wallet)] } },
  meta: {
    err: null,
    fee: 5000,
    preBalances: [1_000_000_000],
    postBalances: [1_049_995_000],
    preTokenBalances: [{ owner: wallet, mint: inputMint, uiTokenAmount: { amount: '1000' } }],
    postTokenBalances: [{ owner: wallet, mint: inputMint, uiTokenAmount: { amount: '700' } }],
  },
}, wallet, { inputMint, outputMint: WSOL_MINT });
assert.equal(sellReceipt.outputAmount, '50000000', 'native output must restore the fee from wallet net delta');
assert.equal(sellReceipt.inputDebitAmount, '300');

const failedReceipt = deriveFinalizedSwapReceipt({
  transaction: { message: { staticAccountKeys: [key(wallet)] } },
  meta: { err: { InstructionError: [1, 'Custom'] }, fee: 5000 },
}, wallet, { inputMint, outputMint: WSOL_MINT });
assert.equal(failedReceipt.success, false, 'finalized failed transaction must never be treated as a fill');

const previousMode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
db.prepare("UPDATE settings SET value = 'live' WHERE key = 'trading_mode'").run();

const prefix = `HardeningV2_${Date.now()}`;
const op1 = claimExecutionOperation({ mint: `${prefix}_A`, side: 'buy', inputAmount: 100_000_000 });
const op2 = claimExecutionOperation({ mint: `${prefix}_B`, side: 'buy', inputAmount: 100_000_000 });
assert.equal(op1.ok, true);
assert.equal(op2.ok, true);
let summary = activeLiveReservationSummary();
assert.equal(summary.count, 2, 'two concurrent live claims must consume two durable slots');
assert(Math.abs(summary.exposureSol - 0.2) < 1e-9, 'pending reservations must count toward hard exposure');

assert.throws(
  () => claimExecutionOperation({ mint: `${prefix}_C`, side: 'buy', inputAmount: 1_000_000 }),
  /position\/reservation cap|exposure including reservations/,
  'a third claim must not pass using a stale pre-reservation exposure snapshot',
);

updateExecutionOperation(op1.operationId, 'failed', { error: 'known_prebroadcast_failure' });
summary = activeLiveReservationSummary();
assert.equal(summary.count, 1, 'known failure must release its durable reservation');

updateExecutionOperation(op2.operationId, 'outcome_unknown', { error: 'transport_timeout' });
summary = activeLiveReservationSummary();
assert.equal(summary.count, 1, 'UNKNOWN execution must keep capital reserved');

const op3 = claimExecutionOperation({ mint: `${prefix}_C`, side: 'buy', inputAmount: 50_000_000 });
assert.equal(op3.ok, true, 'released capacity may be reused while UNKNOWN exposure remains reserved');
summary = activeLiveReservationSummary();
assert.equal(summary.count, 2);
assert(Math.abs(summary.exposureSol - 0.15) < 1e-9);

updateExecutionOperation(op3.operationId, 'completed', { finalizedAtMs: Date.now() });
summary = activeLiveReservationSummary();
assert.equal(summary.count, 1, 'completed operation must convert/release the pending reservation');

// Re-running the schema initializer simulates restart/idempotent migration. The
// unresolved reservation must still exist because it lives in SQLite, not RAM.
ensureLiveSafetySchema();
summary = activeLiveReservationSummary();
assert.equal(summary.count, 1, 'UNKNOWN reservation must survive idempotent startup initialization');

// Cleanup so the shared isolated unit-test database cannot influence later files.
db.prepare('DELETE FROM live_capital_reservations WHERE mint LIKE ?').run(`${prefix}%`);
db.prepare('DELETE FROM execution_operations WHERE mint LIKE ?').run(`${prefix}%`);
db.prepare('UPDATE settings SET value = ? WHERE key = \'trading_mode\'').run(previousMode);

console.log('[test_live_safety_hardening_v2] SUCCESS: atomic reservations, finality receipts, and balance aggregation verified.');
