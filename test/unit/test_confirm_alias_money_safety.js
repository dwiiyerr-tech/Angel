import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { setting, setSetting } from '../../src/db/settings.js';
import { ensureLiveSafetySchema } from '../../src/db/liveSafety.js';
import { claimExecutionOperation, updateExecutionOperation } from '../../src/db/executionOperations.js';
import { riskControlState } from '../../src/execution/riskControls.js';
import { reconcileUnknownExecutions } from '../../src/execution/reconciler.js';
import { buildReadinessEvidence } from '../../src/readiness/engine.js';

process.env.TELEGRAM_POLLING = 'false';
const { assertLiveRiskBudget } = await import('../../src/execution/router.js');

console.log('[confirm-alias-money-safety] starting...');
ensureLiveSafetySchema();

const previousMode = setting('trading_mode', 'dry_run');
setSetting('trading_mode', 'live');
const prefix = `ConfirmSafety_${Date.now()}`;
const insertedPositionIds = [];
const insertedOperationIds = [];

function insertPosition({
  mint,
  mode = 'confirm',
  status = 'open',
  sizeSol = 0.01,
  pnlPercent = null,
  pnlSol = null,
  closedAtMs = null,
  tokenAmountRaw = null,
  entrySignature = null,
}) {
  const openedAtMs = (closedAtMs ?? Date.now()) - 1000;
  const result = db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_mcap,
      tp_percent, sl_percent, trailing_enabled, trailing_percent,
      pnl_percent, pnl_sol, execution_mode, token_amount_raw, entry_signature, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, 1000, 50, -25, 1, 10, ?, ?, ?, ?, ?, '{}')
  `).run(
    mint,
    'CONFSAFE',
    status,
    openedAtMs,
    closedAtMs,
    sizeSol,
    pnlPercent,
    pnlSol,
    mode,
    tokenAmountRaw,
    entrySignature,
  );
  const id = Number(result.lastInsertRowid);
  insertedPositionIds.push(id);
  return id;
}

// 1) Pre-entry hard budget must count historical real-money `confirm` exposure,
// while a PAPER alias remains excluded.
const baselineBudget = assertLiveRiskBudget(0.001, 'live');
const confirmOpenId = insertPosition({ mint: `${prefix}_ConfirmOpen`, sizeSol: 0.05 });
insertPosition({ mint: `${prefix}_PaperOpen`, mode: 'shadow_live', sizeSol: 0.05 });
const budgetWithAliases = assertLiveRiskBudget(0.001, 'live');
assert.equal(
  budgetWithAliases.activePositions,
  baselineBudget.activePositions + 1,
  'legacy confirm must consume LIVE hard-budget position capacity; PAPER aliases must not',
);
assert.ok(
  budgetWithAliases.exposureSol >= baselineBudget.exposureSol + 0.05 - 1e-9,
  'legacy confirm notional must contribute to LIVE hard-budget exposure',
);

// 2) Atomic reservation is the final money-grade authority. Its in-transaction
// snapshot must include the same persisted confirm exposure.
const canonicalActiveBeforeClaim = Number(db.prepare(`
  SELECT COUNT(*) AS count FROM dry_run_positions
  WHERE status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
    AND lower(trim(coalesce(execution_mode, 'dry_run'))) IN ('live', 'confirm')
`).get()?.count || 0);
const activeReservationsBeforeClaim = Number(db.prepare(`
  SELECT COUNT(*) AS count FROM live_capital_reservations
  WHERE execution_mode = 'live' AND status = 'active'
`).get()?.count || 0);
const claim = claimExecutionOperation({
  mint: `${prefix}_Claim`,
  side: 'buy',
  inputAmount: 10_000_000,
});
assert.equal(claim.ok, true);
insertedOperationIds.push(claim.operationId);
assert.equal(
  claim.reservation.activeCountBefore,
  canonicalActiveBeforeClaim + activeReservationsBeforeClaim,
  'atomic LIVE reservation must count persisted confirm positions before admitting new capital',
);
updateExecutionOperation(claim.operationId, 'failed', { error: 'test_cleanup' });

// Close/remove open fixtures before loss-streak checks so only deliberately
// ordered closed rows drive the most-recent loss history.
db.prepare("UPDATE dry_run_positions SET status = 'closed', closed_at_ms = ? WHERE id IN (?, ?)")
  .run(Date.now() - 20_000, confirmOpenId, insertedPositionIds[1]);

// 3) `confirm` historical losses are real-money losses and must participate in
// LIVE/confirm loss-streak controls. Put a LIVE win immediately before three
// newer confirm losses so the old literal-live predicate would incorrectly see
// a zero streak.
const lossBase = Date.now() + 1_000_000;
insertPosition({ mint: `${prefix}_LiveWin`, mode: 'live', status: 'closed', pnlPercent: 10, pnlSol: 0.01, closedAtMs: lossBase });
for (let i = 1; i <= 3; i += 1) {
  insertPosition({
    mint: `${prefix}_ConfirmLoss${i}`,
    mode: 'confirm',
    status: 'closed',
    pnlPercent: -10,
    pnlSol: -0.01,
    closedAtMs: lossBase + i,
  });
}
const risk = riskControlState('live', lossBase + 10);
assert.equal(risk.streak, 3, 'LIVE loss streak must include newer legacy confirm losses');

// 4) Readiness safety must not hide unresolved real-money legacy rows.
const safetyBefore = buildReadinessEvidence().safety;
const unknownId = insertPosition({
  mint: `${prefix}_Unknown`,
  mode: 'confirm',
  status: 'entry_unknown',
  sizeSol: 0.02,
});
const safetyAfter = buildReadinessEvidence().safety;
assert.equal(
  safetyAfter.unknownLivePositions,
  safetyBefore.unknownLivePositions + 1,
  'legacy confirm UNKNOWN positions must block LIVE readiness',
);

// 5) Finalized orphan sell recovery must find a legacy confirm position when
// the durable operation lost its position_id across a crash window.
const reconcileMint = `${prefix}_Reconcile`;
const reconcilePositionId = insertPosition({
  mint: reconcileMint,
  mode: 'confirm',
  status: 'open',
  sizeSol: 0.05,
  tokenAmountRaw: '100',
  entrySignature: `${prefix}_entry_sig`,
});
const opResult = db.prepare(`
  INSERT INTO execution_operations (
    mint, side, status, position_id, input_amount, output_amount, signature,
    execution_mode, created_at_ms, updated_at_ms
  ) VALUES (?, 'sell', 'outcome_unknown', NULL, '100', NULL, ?, 'confirm', ?, ?)
`).run(reconcileMint, `${prefix}_sell_sig`, Date.now(), Date.now());
const reconcileOperationId = Number(opResult.lastInsertRowid);
insertedOperationIds.push(reconcileOperationId);

const reconciliation = await reconcileUnknownExecutions({
  walletAvailable: true,
  limit: 50,
  receiptFetcher: async (_signature, _mints, operation) => (
    Number(operation.id) === reconcileOperationId
      ? { finalized: true, success: true, outputAmount: '60000000', feeSol: 0 }
      : { finalized: false, success: false }
  ),
});
const reconcileDetail = reconciliation.details.find(row => Number(row.id) === reconcileOperationId);
assert.equal(reconcileDetail?.resolved, true, 'orphan confirm sell must reconcile from finalized evidence');
assert.equal(
  db.prepare('SELECT status FROM dry_run_positions WHERE id = ?').get(reconcilePositionId)?.status,
  'closed',
  'reconciled legacy confirm position must settle its position ledger',
);
assert.equal(
  db.prepare('SELECT status FROM execution_operations WHERE id = ?').get(reconcileOperationId)?.status,
  'completed',
  'reconciled legacy confirm execution must leave UNKNOWN state',
);

// Cleanup only this test's fixtures; never weaken the schema invariants to make
// the regression pass.
db.prepare('DELETE FROM live_capital_reservations WHERE mint LIKE ?').run(`${prefix}%`);
db.prepare('DELETE FROM execution_operations WHERE mint LIKE ?').run(`${prefix}%`);
db.prepare('DELETE FROM dry_run_positions WHERE mint LIKE ?').run(`${prefix}%`);
setSetting('trading_mode', previousMode);

console.log('[confirm-alias-money-safety] legacy confirm is counted across money-grade LIVE safety paths');
