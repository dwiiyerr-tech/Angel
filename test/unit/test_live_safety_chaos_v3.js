import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { db, initDb } from '../../src/db/connection.js';
import { DB_PATH } from '../../src/config.js';
import { ensureLiveSafetySchema, activeLiveReservationSummary } from '../../src/db/liveSafety.js';
import { claimExecutionOperation, updateExecutionOperation } from '../../src/db/executionOperations.js';
import { reconcileUnknownExecutions } from '../../src/execution/reconciler.js';
import { hasPositiveRawAmount, resolveTrackedSellAmount } from '../../src/execution/liveInventoryGuard.js';

console.log('[test_live_safety_chaos_v3] Starting crash/finality/concurrency chaos tests...');

initDb();
ensureLiveSafetySchema();

const previousMode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
db.prepare("UPDATE settings SET value = 'live' WHERE key = 'trading_mode'").run();

const helperCrash = fileURLToPath(new URL('../helpers/chaos_crash_claim.mjs', import.meta.url));
const helperLock = fileURLToPath(new URL('../helpers/hold_sqlite_lock.mjs', import.meta.url));
const prefix = `ChaosV3_${Date.now()}`;

function cleanupMint(mint) {
  const ids = db.prepare('SELECT id FROM dry_run_positions WHERE mint = ?').all(mint).map(row => row.id);
  for (const id of ids) {
    db.prepare('DELETE FROM dry_run_positions WHERE id = ?').run(id);
  }
  db.prepare('DELETE FROM live_capital_reservations WHERE mint = ?').run(mint);
  db.prepare('DELETE FROM execution_operations WHERE mint = ?').run(mint);
  db.prepare('DELETE FROM llm_decisions WHERE mint = ?').run(mint);
  db.prepare('DELETE FROM candidates WHERE mint = ?').run(mint);
}

function seedCandidateAndDecision(mint) {
  const at = Date.now();
  const candidate = {
    token: { mint, symbol: 'CHAOS', name: 'Chaos Fixture' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100000, liquidityUsd: 25000, holderCount: 500 },
    signals: { route: 'chaos_test' },
    filters: { passed: true, failures: [] },
  };
  const inserted = db.prepare(`
    INSERT INTO candidates
      (mint, status, created_at_ms, updated_at_ms, signature, signal_key, candidate_json, filter_result_json)
    VALUES (?, 'candidate', ?, ?, NULL, NULL, ?, ?)
  `).run(mint, at, at, JSON.stringify(candidate), JSON.stringify(candidate.filters));
  const candidateId = Number(inserted.lastInsertRowid);
  const decisionRaw = {
    verdict: 'BUY', confidence: 90, reason: 'chaos fixture', risks: [],
    suggested_tp_percent: 60, suggested_sl_percent: -15,
  };
  const decisionInserted = db.prepare(`
    INSERT INTO llm_decisions
      (candidate_id, mint, created_at_ms, verdict, confidence, reason, risks_json, raw_json)
    VALUES (?, ?, ?, 'BUY', 90, 'chaos fixture', '[]', ?)
  `).run(candidateId, mint, at, JSON.stringify(decisionRaw));
  return { candidateId, decisionId: Number(decisionInserted.lastInsertRowid), candidate };
}

async function runCrashHelper(mint, stage) {
  const child = spawn(process.execPath, [helperCrash, mint, stage], {
    env: { ...process.env, DB_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const [code] = await once(child, 'close');
  assert.equal(code, 91, `fault helper must terminate abruptly (stderr: ${stderr})`);
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  assert(line, 'fault helper must print the durable operation id before crashing');
  return JSON.parse(line);
}

async function runWriterContention() {
  const child = spawn(process.execPath, [helperLock, DB_PATH, '350'], {
    env: { ...process.env, DB_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const locked = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`lock helper timeout: ${stderr}`)), 3000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.includes('LOCKED')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await locked;
  const started = Date.now();
  db.prepare("UPDATE settings SET value = value WHERE key = 'agent_enabled'").run();
  const elapsed = Date.now() - started;
  const [code] = await once(child, 'close');
  assert.equal(code, 0, `lock helper failed: ${stderr}`);
  assert(elapsed >= 150, `SQLite writer should wait for transient contention, only waited ${elapsed}ms`);
  assert(elapsed < 5000, `SQLite writer contention exceeded configured busy timeout (${elapsed}ms)`);
  return elapsed;
}

// Inventory ownership invariant: Angel may verify wallet sufficiency, but must
// never upsize a position exit just because the wallet owns extra tokens.
assert.equal(resolveTrackedSellAmount({ positionAmountRaw: '100', walletAmountRaw: '250' }), '100');
assert.equal(resolveTrackedSellAmount({ positionAmountRaw: '100', walletAmountRaw: '100' }), '100');
assert.throws(
  () => resolveTrackedSellAmount({ positionAmountRaw: '100', walletAmountRaw: '99' }),
  /exceeds wallet token balance/,
);
assert.throws(
  () => resolveTrackedSellAmount({ positionAmountRaw: '100', walletAmountRaw: null }),
  /authoritative wallet token balance/,
);
assert.equal(hasPositiveRawAmount('900719925474099300000'), true, 'raw amounts must not rely on Number precision');

// Fault 1: process dies after durable capital claim but before a transaction
// signature exists. The reservation must survive and reconciliation must refuse
// to guess an outcome.
const crashBeforeSignatureMint = `${prefix}_crash_before_signature`;
cleanupMint(crashBeforeSignatureMint);
const preSigCrash = await runCrashHelper(crashBeforeSignatureMint, 'after_claim');
let operation = db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(preSigCrash.operationId);
assert.equal(operation.status, 'pending');
assert.equal(operation.signature, null);
let reservation = db.prepare('SELECT * FROM live_capital_reservations WHERE operation_id = ?').get(preSigCrash.operationId);
assert.equal(reservation.status, 'active', 'abrupt process exit must not lose reserved capital');
let reconciliation = await reconcileUnknownExecutions({
  walletAvailable: true,
  receiptFetcher: async () => { throw new Error('receipt fetcher must not run without a signature'); },
});
assert(reconciliation.details.some(row => row.id === preSigCrash.operationId && row.reason === 'signature_missing'));
reservation = db.prepare('SELECT * FROM live_capital_reservations WHERE operation_id = ?').get(preSigCrash.operationId);
assert.equal(reservation.status, 'active', 'irreducibly ambiguous pre-signature state must remain fail-closed');
cleanupMint(crashBeforeSignatureMint);

// Fault 2/3: process dies after signature journaling. First the RPC looks
// unresolved, then a later finalized receipt appears. This models provider
// timeout plus restart after the chain already accepted the transaction.
const recoveryMint = `${prefix}_finalized_before_position_write`;
cleanupMint(recoveryMint);
seedCandidateAndDecision(recoveryMint);
const signedCrash = await runCrashHelper(recoveryMint, 'after_signature');
operation = db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(signedCrash.operationId);
assert.equal(operation.status, 'outcome_unknown');
assert(operation.signature, 'signed crash must leave durable transaction identity');

reconciliation = await reconcileUnknownExecutions({
  walletAvailable: true,
  receiptFetcher: async () => ({ found: true, finalized: false, success: null }),
});
assert(reconciliation.details.some(row => row.id === signedCrash.operationId && row.reason === 'not_finalized'));
assert.equal(activeLiveReservationSummary().count >= 1, true, 'RPC timeout must not release uncertain capital');

const finalizedBuyReceipt = {
  found: true,
  finalized: true,
  success: true,
  outputAmount: '777',
  feeLamports: 5000,
  feeSol: 0.000005,
};
reconciliation = await reconcileUnknownExecutions({
  walletAvailable: true,
  receiptFetcher: async (signature, mints, op) => op.id === signedCrash.operationId
    ? finalizedBuyReceipt
    : { found: false, finalized: false, success: null },
});
assert(reconciliation.details.some(row => row.id === signedCrash.operationId && row.action === 'buy_recovered'));
operation = db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(signedCrash.operationId);
assert.equal(operation.status, 'completed');
assert(operation.finalized_at_ms, 'recovered operation must record finalization time');
const recoveredPosition = db.prepare("SELECT * FROM dry_run_positions WHERE mint = ? AND execution_mode = 'live'").get(recoveryMint);
assert(recoveredPosition, 'finalized buy must reconstruct the position after a crash-before-position-write');
assert.equal(recoveredPosition.status, 'open');
assert.equal(recoveredPosition.token_amount_raw, '777');
reservation = db.prepare('SELECT * FROM live_capital_reservations WHERE operation_id = ?').get(signedCrash.operationId);
assert.equal(reservation.status, 'converted', 'position ledger must replace pending capital reservation after recovery');

// Duplicate callback/restart: completed operations disappear from the unresolved
// queue, so running the reconciler repeatedly must not duplicate the position.
const positionsBeforeDuplicate = db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE mint = ?').get(recoveryMint).count;
const duplicatePass = await reconcileUnknownExecutions({
  walletAvailable: true,
  receiptFetcher: async () => finalizedBuyReceipt,
});
const positionsAfterDuplicate = db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE mint = ?').get(recoveryMint).count;
assert.equal(positionsAfterDuplicate, positionsBeforeDuplicate, 'duplicate reconciliation must be idempotent');
assert.equal(duplicatePass.details.some(row => row.id === signedCrash.operationId), false);

// Fault 4: ambiguous sell later finalizes as a chain failure. The position must
// reopen; Angel must never assume tokens were sold.
let sellClaim = claimExecutionOperation({
  mint: recoveryMint,
  side: 'sell',
  positionId: recoveredPosition.id,
  inputAmount: recoveredPosition.token_amount_raw,
});
assert.equal(sellClaim.ok, true);
db.prepare("UPDATE dry_run_positions SET status = 'exit_unknown' WHERE id = ?").run(recoveredPosition.id);
updateExecutionOperation(sellClaim.operationId, 'outcome_unknown', { positionId: recoveredPosition.id, signature: `${prefix}_failed_sell_sig`, error: 'rpc_timeout' });
reconciliation = await reconcileUnknownExecutions({
  walletAvailable: true,
  receiptFetcher: async (signature, mints, op) => op.id === sellClaim.operationId
    ? { found: true, finalized: true, success: false, error: { InstructionError: [1, 'Custom'] } }
    : { found: false, finalized: false, success: null },
});
assert(reconciliation.details.some(row => row.id === sellClaim.operationId && row.action === 'finalized_failure'));
assert.equal(db.prepare('SELECT status FROM dry_run_positions WHERE id = ?').get(recoveredPosition.id).status, 'open');
assert.equal(db.prepare('SELECT status FROM execution_operations WHERE id = ?').get(sellClaim.operationId).status, 'failed');

// Fault 5: partial exit finalized after a crash. Inventory and cost basis must be
// derived from the position ledger and finalized input amount only.
sellClaim = claimExecutionOperation({ mint: recoveryMint, side: 'sell', positionId: recoveredPosition.id, inputAmount: '200' });
assert.equal(sellClaim.ok, true);
db.prepare("UPDATE dry_run_positions SET status = 'partial_exit_unknown' WHERE id = ?").run(recoveredPosition.id);
updateExecutionOperation(sellClaim.operationId, 'outcome_unknown', { positionId: recoveredPosition.id, signature: `${prefix}_partial_sell_sig`, error: 'process_exit' });
reconciliation = await reconcileUnknownExecutions({
  walletAvailable: true,
  receiptFetcher: async (signature, mints, op) => op.id === sellClaim.operationId
    ? { found: true, finalized: true, success: true, outputAmount: '10000000', feeLamports: 5000, feeSol: 0.000005 }
    : { found: false, finalized: false, success: null },
});
assert(reconciliation.details.some(row => row.id === sellClaim.operationId && row.action === 'partial_sell_recovered'));
let positionAfterPartial = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(recoveredPosition.id);
assert.equal(positionAfterPartial.status, 'open');
assert.equal(positionAfterPartial.token_amount_raw, '577');

// Fault 6: full exit finalizes after the app missed the normal DB close write.
sellClaim = claimExecutionOperation({ mint: recoveryMint, side: 'sell', positionId: recoveredPosition.id, inputAmount: positionAfterPartial.token_amount_raw });
assert.equal(sellClaim.ok, true);
db.prepare("UPDATE dry_run_positions SET status = 'exit_unknown' WHERE id = ?").run(recoveredPosition.id);
updateExecutionOperation(sellClaim.operationId, 'outcome_unknown', { positionId: recoveredPosition.id, signature: `${prefix}_full_sell_sig`, error: 'process_exit_after_finalization' });
reconciliation = await reconcileUnknownExecutions({
  walletAvailable: true,
  receiptFetcher: async (signature, mints, op) => op.id === sellClaim.operationId
    ? { found: true, finalized: true, success: true, outputAmount: '30000000', feeLamports: 5000, feeSol: 0.000005 }
    : { found: false, finalized: false, success: null },
});
assert(reconciliation.details.some(row => row.id === sellClaim.operationId && row.action === 'sell_recovered'));
const closedPosition = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(recoveredPosition.id);
assert.equal(closedPosition.status, 'closed');
assert.equal(closedPosition.token_amount_raw, '0');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dry_run_trades WHERE position_id = ? AND reason = ?').get(recoveredPosition.id, 'RECONCILED_FINALIZED_EXIT').count, 1);

// Fault 7: finalized status without authoritative output is still UNKNOWN. This
// protects accounting from provider/RPC responses that prove inclusion but do
// not provide the asset delta needed to settle the ledger.
const missingOutputMint = `${prefix}_missing_output`;
cleanupMint(missingOutputMint);
seedCandidateAndDecision(missingOutputMint);
const missingOutputClaim = claimExecutionOperation({ mint: missingOutputMint, side: 'buy', inputAmount: 20_000_000 });
assert.equal(missingOutputClaim.ok, true);
updateExecutionOperation(missingOutputClaim.operationId, 'outcome_unknown', { signature: `${prefix}_missing_output_sig`, error: 'receipt_not_indexed' });
reconciliation = await reconcileUnknownExecutions({
  walletAvailable: true,
  receiptFetcher: async (signature, mints, op) => op.id === missingOutputClaim.operationId
    ? { found: true, finalized: true, success: true, outputAmount: null, feeSol: 0.000005 }
    : { found: false, finalized: false, success: null },
});
assert(reconciliation.details.some(row => row.id === missingOutputClaim.operationId && row.reason === 'buy_output_unknown'));
assert.equal(db.prepare('SELECT status FROM execution_operations WHERE id = ?').get(missingOutputClaim.operationId).status, 'outcome_unknown');
assert.equal(db.prepare('SELECT status FROM live_capital_reservations WHERE operation_id = ?').get(missingOutputClaim.operationId).status, 'active');

// Fault 8: a second process holds SQLite's writer lock. The main money-grade
// connection must wait for the transient lock rather than failing immediately.
const lockWaitMs = await runWriterContention();
console.log(`[test_live_safety_chaos_v3] SQLite contention recovered after ${lockWaitMs}ms`);

cleanupMint(recoveryMint);
cleanupMint(missingOutputMint);
db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(previousMode, 'trading_mode');

console.log('[test_live_safety_chaos_v3] SUCCESS: crash windows, RPC ambiguity, duplicate reconciliation, inventory ownership, and DB contention verified.');
