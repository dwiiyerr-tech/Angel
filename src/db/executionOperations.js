import { db } from './connection.js';
import { now } from '../utils.js';

const ACTIVE = "('pending', 'outcome_unknown')";

export function claimExecutionOperation({ mint, side, positionId = null, intentId = null, inputAmount = null }) {
  return db.transaction(() => {
    if (side === 'buy') {
      const position = db.prepare(`
        SELECT id, status FROM dry_run_positions
        WHERE mint = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
        LIMIT 1
      `).get(mint);
      if (position) return { ok: false, reason: `position_${position.status}`, positionId: position.id };
    }
    const active = db.prepare(`SELECT id, status FROM execution_operations WHERE mint = ? AND side = ? AND status IN ${ACTIVE} LIMIT 1`).get(mint, side);
    if (active) return { ok: false, reason: `operation_${active.status}`, operationId: active.id };
    try {
      const at = now();
      const result = db.prepare(`
        INSERT INTO execution_operations
          (mint, side, status, position_id, intent_id, input_amount, created_at_ms, updated_at_ms)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(mint, side, positionId, intentId, inputAmount == null ? null : String(inputAmount), at, at);
      return { ok: true, operationId: Number(result.lastInsertRowid) };
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { ok: false, reason: 'operation_active' };
      throw error;
    }
  })();
}

export function updateExecutionOperation(id, status, details = {}) {
  db.prepare(`
    UPDATE execution_operations
    SET status = ?, position_id = COALESCE(?, position_id), output_amount = COALESCE(?, output_amount),
        signature = COALESCE(?, signature), error = ?, updated_at_ms = ?
    WHERE id = ?
  `).run(
    status,
    details.positionId ?? null,
    details.outputAmount == null ? null : String(details.outputAmount),
    details.signature ?? null,
    details.error ?? null,
    now(),
    id,
  );
}

export function unresolvedExecutionCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get().count;
}
