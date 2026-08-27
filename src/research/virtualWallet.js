import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { isPaperExecutionMode } from '../tradingModePresentation.js';

const PAPER_INITIAL_BALANCE_DEFAULT = 10;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function paperInitialBalanceSol() {
  const configured = numSetting('paper_initial_balance_sol', PAPER_INITIAL_BALANCE_DEFAULT);
  return configured > 0 ? configured : PAPER_INITIAL_BALANCE_DEFAULT;
}

function paperPositions() {
  return db.prepare(`
    SELECT status, execution_mode, size_sol, entry_fee_sol, realized_pnl_sol,
           mark_pnl_sol, pnl_sol, trailing_enabled, trailing_armed
    FROM dry_run_positions
  `).all().filter(row => isPaperExecutionMode(row.execution_mode));
}

/**
 * PAPER-only portfolio view. This is accounting data, never a wallet balance
 * and never used by LIVE sizing or execution guards.
 */
export function paperWalletSummary() {
  const rows = paperPositions();
  const initialBalanceSol = paperInitialBalanceSol();
  const closedRows = rows.filter(row => row.status === 'closed');
  const openRows = rows.filter(row => row.status === 'open');

  const realizedPnlSol = closedRows.reduce((sum, row) => sum + finite(row.pnl_sol), 0)
    + openRows.reduce((sum, row) => sum + finite(row.realized_pnl_sol), 0);

  // size_sol is reduced whenever a partial exit settles, so it is already the
  // remaining open cost basis. realized_cost_sol is historical sold cost basis
  // and must not be reserved again or PAPER would permanently lock capital that
  // has already returned to the virtual wallet.
  const committedSol = openRows.reduce((sum, row) => (
    sum
      + Math.max(0, finite(row.size_sol))
      + Math.max(0, finite(row.entry_fee_sol))
  ), 0);

  // mark_pnl_sol is written by the position monitor. The fallback keeps old
  // positions visible immediately after migration until their next refresh.
  const openMarkPnlSol = openRows.reduce((sum, row) => {
    const mark = Number.isFinite(Number(row.mark_pnl_sol))
      ? Number(row.mark_pnl_sol)
      : finite(row.realized_pnl_sol) + finite(row.pnl_sol) - finite(row.entry_fee_sol);
    return sum + mark;
  }, 0);
  const closedPnlSol = closedRows.reduce((sum, row) => sum + finite(row.pnl_sol), 0);
  const totalPnlSol = closedPnlSol + openMarkPnlSol;
  const equitySol = initialBalanceSol + totalPnlSol;
  // Unmarked positions still hold virtual inventory. Entry capacity therefore
  // follows cash/equity realized to date, not an unrealized quote mark.
  const availableCashSol = initialBalanceSol + realizedPnlSol - committedSol;

  const trailingEnabled = openRows.reduce(
    (count, row) => count + (Number(row.trailing_enabled) === 1 ? 1 : 0),
    0,
  );
  const trailingArmed = openRows.reduce(
    (count, row) => count + (Number(row.trailing_enabled) === 1 && Number(row.trailing_armed) === 1 ? 1 : 0),
    0,
  );

  return {
    initialBalanceSol,
    equitySol,
    availableSol: availableCashSol,
    availableCashSol,
    committedSol,
    totalPnlSol,
    realizedPnlSol,
    unrealizedPnlSol: openMarkPnlSol - openRows.reduce((sum, row) => sum + finite(row.realized_pnl_sol), 0),
    openPositions: openRows.length,
    closedPositions: closedRows.length,
    trailingEnabled,
    trailingArmed,
    source: 'paper_virtual_ledger',
  };
}

export function assertPaperWalletCapacity(nextNotionalSol, nextFeeSol = 0) {
  const required = Math.max(0, Number(nextNotionalSol) || 0) + Math.max(0, Number(nextFeeSol) || 0);
  const summary = paperWalletSummary();
  if (!Number.isFinite(required) || required <= 0) throw new Error('PAPER entry requires a positive virtual notional.');
  if (summary.availableCashSol + 1e-9 < required) {
    throw new Error(
      `PAPER virtual balance insufficient: need ${required.toFixed(4)} SOL, available ${summary.availableCashSol.toFixed(4)} SOL.`,
    );
  }
  return { requiredSol: required, availableSol: summary.availableCashSol };
}

export function formatPaperWalletSummary(summary = paperWalletSummary()) {
  const fmt = value => `${Number(value || 0) >= 0 ? '+' : ''}${Number(value || 0).toFixed(4)} SOL`;
  return [
    `Starting: ${Number(summary.initialBalanceSol).toFixed(4)} SOL`,
    `Virtual equity: ${Number(summary.equitySol).toFixed(4)} SOL`,
    `Available: ${Number(summary.availableSol).toFixed(4)} SOL · Committed: ${Number(summary.committedSol).toFixed(4)} SOL`,
    `Realized PnL: ${fmt(summary.realizedPnlSol)} · Unrealized PnL: ${fmt(summary.unrealizedPnlSol)}`,
    `Positions: ${summary.openPositions} open / ${summary.closedPositions} closed · Trailing: ${summary.trailingArmed}/${summary.trailingEnabled} armed`,
  ];
}
