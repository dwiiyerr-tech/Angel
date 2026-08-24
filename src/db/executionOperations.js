import { db } from './connection.js';
import { now } from '../utils.js';
import {
  LIVE_MAX_DAILY_ENTRIES,
  LIVE_MAX_DAILY_LOSS_SOL,
  LIVE_MAX_OPEN_POSITIONS,
  LIVE_MAX_POSITION_SOL,
  LIVE_MAX_TOTAL_EXPOSURE_SOL,
} from '../config.js';
import { ensureLiveSafetySchema } from './liveSafety.js';

const ACTIVE = "('pending', 'outcome_unknown')";
const ACTIVE_POSITION_STATUSES = "('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')";

function currentMoneyExecutionMode() {
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
  return raw === 'live' || raw === 'confirm' ? 'live' : null;
}

function reserveLiveBuyInsideTransaction({ mint, inputAmount, operationId, at }) {
  const executionMode = currentMoneyExecutionMode();
  if (!executionMode) return null;

  const lamports = Number(inputAmount);
  const sizeSol = lamports / 1_000_000_000;
  if (!Number.isSafeInteger(lamports) || lamports <= 0 || !Number.isFinite(sizeSol) || sizeSol <= 0) {
    throw new Error('Live capital reservation requires a positive safe lamport amount.');
  }
  if (sizeSol > LIVE_MAX_POSITION_SOL) {
    throw new Error(`Hard live position cap exceeded (${sizeSol} > ${LIVE_MAX_POSITION_SOL} SOL).`);
  }

  const activePositions = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_sol), 0) AS exposure
    FROM dry_run_positions
    WHERE execution_mode = 'live' AND status IN ${ACTIVE_POSITION_STATUSES}
  `).get();
  const activeReservations = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_sol), 0) AS exposure
    FROM live_capital_reservations
    WHERE execution_mode = 'live' AND status = 'active'
  `).get();

  const activeCount = Number(activePositions?.count || 0) + Number(activeReservations?.count || 0);
  const exposureSol = Number(activePositions?.exposure || 0) + Number(activeReservations?.exposure || 0);
  if (activeCount >= LIVE_MAX_OPEN_POSITIONS) {
    throw new Error(`Hard live position/reservation cap reached (${activeCount}/${LIVE_MAX_OPEN_POSITIONS}).`);
  }
  if (exposureSol + sizeSol > LIVE_MAX_TOTAL_EXPOSURE_SOL) {
    throw new Error(`Hard live exposure including reservations exceeded (${(exposureSol + sizeSol).toFixed(6)} > ${LIVE_MAX_TOTAL_EXPOSURE_SOL} SOL).`);
  }

  const since = at - 24 * 60 * 60 * 1000;
  const completedEntries = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM execution_operations
    WHERE side = 'buy' AND COALESCE(execution_mode, 'live') = 'live'
      AND status IN ('completed', 'outcome_unknown') AND created_at_ms >= ?
  `).get(since)?.count || 0);
  const pendingEntries = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM live_capital_reservations
    WHERE execution_mode = 'live' AND status = 'active' AND created_at_ms >= ?
  `).get(since)?.count || 0);
  if (completedEntries + pendingEntries >= LIVE_MAX_DAILY_ENTRIES) {
    throw new Error(`Hard daily live entry cap reached (${completedEntries + pendingEntries}/${LIVE_MAX_DAILY_ENTRIES}).`);
  }

  const dailyPnlSol = Number(db.prepare(`
    SELECT COALESCE(SUM(pnl_sol), 0) AS pnl
    FROM dry_run_positions
    WHERE execution_mode = 'live' AND status = 'closed' AND closed_at_ms >= ?
  `).get(since)?.pnl || 0);
  if (dailyPnlSol <= -LIVE_MAX_DAILY_LOSS_SOL) {
    throw new Error(`Hard daily live loss limit reached (${dailyPnlSol.toFixed(6)} SOL).`);
  }

  db.prepare(`
    INSERT INTO live_capital_reservations
      (operation_id, mint, execution_mode, size_sol, status, created_at_ms)
    VALUES (?, ?, 'live', ?, 'active', ?)
  `).run(operationId, mint, sizeSol, at);

  db.prepare(`
    UPDATE execution_operations
    SET execution_mode = 'live', reserved_sol = ?
    WHERE id = ?
  `).run(sizeSol, operationId);

  return {
    executionMode,
    sizeSol,
    activeCountBefore: activeCount,
    exposureBeforeSol: exposureSol,
    dailyEntriesBefore: completedEntries + pendingEntries,
    dailyPnlSol,
  };
}

export function claimExecutionOperation({ mint, side, positionId = null, intentId = null, inputAmount = null }) {
  ensureLiveSafetySchema();
  return db.transaction(() => {
    if (side === 'buy') {
      const position = db.prepare(`
        SELECT id, status FROM dry_run_positions
        WHERE mint = ? AND status IN ${ACTIVE_POSITION_STATUSES}
        LIMIT 1
      `).get(mint);
      if (position) return { ok: false, reason: `position_${position.status}`, positionId: position.id };
    }
    const active = db.prepare(`SELECT id, status FROM execution_operations WHERE mint = ? AND side = ? AND status IN ${ACTIVE} LIMIT 1`).get(mint, side);
    if (active) return { ok: false, reason: `operation_${active.status}`, operationId: active.id };

    try {
      const at = now();
      const candidate = db.prepare('SELECT id FROM candidates WHERE mint = ? ORDER BY updated_at_ms DESC, id DESC LIMIT 1').get(mint);
      const decision = candidate
        ? db.prepare('SELECT id FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(candidate.id)
        : null;
      const rawMode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
      const normalizedMode = rawMode === 'confirm' ? 'live' : rawMode;
      const result = db.prepare(`
        INSERT INTO execution_operations
          (mint, side, status, position_id, intent_id, input_amount, candidate_id, decision_id,
           execution_mode, created_at_ms, updated_at_ms)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mint,
        side,
        positionId,
        intentId,
        inputAmount == null ? null : String(inputAmount),
        candidate?.id ?? null,
        decision?.id ?? null,
        normalizedMode,
        at,
        at,
      );
      const operationId = Number(result.lastInsertRowid);
      const reservation = side === 'buy'
        ? reserveLiveBuyInsideTransaction({ mint, inputAmount, operationId, at })
        : null;
      return { ok: true, operationId, reservation };
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { ok: false, reason: 'operation_active' };
      throw error;
    }
  })();
}

export function updateExecutionOperation(id, status, details = {}) {
  ensureLiveSafetySchema();
  db.prepare(`
    UPDATE execution_operations
    SET status = ?, position_id = COALESCE(?, position_id), output_amount = COALESCE(?, output_amount),
        signature = COALESCE(?, signature), error = ?, finalized_at_ms = COALESCE(?, finalized_at_ms),
        updated_at_ms = ?
    WHERE id = ?
  `).run(
    status,
    details.positionId ?? null,
    details.outputAmount == null ? null : String(details.outputAmount),
    details.signature ?? null,
    details.error ?? null,
    details.finalizedAtMs ?? null,
    now(),
    id,
  );
}

export function unresolvedExecutionCount() {
  ensureLiveSafetySchema();
  return db.prepare("SELECT COUNT(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get().count;
}
