import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { numSetting } from './settings.js';

export function createTradeIntent(candidateId, candidate, decision, mode, status, side = 'buy', sizeSolOverride = null) {
  const sizeSol = Number.isFinite(Number(sizeSolOverride)) ? Number(sizeSolOverride) : numSetting('dry_run_buy_sol', 0.1);
  const result = db.prepare(`
    INSERT INTO trade_intents (
      candidate_id, mint, mode, status, created_at_ms, updated_at_ms, side,
      size_sol, confidence, reason, llm_decision_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    mode,
    status,
    now(),
    now(),
    side,
    sizeSol,
    decision.confidence,
    decision.reason,
    decision.id || null,
    json({ candidate, decision, mode, status, approved_size_sol: sizeSol }),
  );
  return Number(result.lastInsertRowid);
}

export function intentById(id) {
  const row = db.prepare('SELECT * FROM trade_intents WHERE id = ?').get(id);
  return row ? { ...row, payload: safeJson(row.payload_json, {}) } : null;
}

export function claimTradeIntent(id) {
  return db.transaction(() => {
    const claimed = db.prepare(`
      UPDATE trade_intents SET status = 'executing', updated_at_ms = ?
      WHERE id = ? AND status = 'pending_confirmation'
    `).run(now(), id);
    return claimed.changes === 1 ? intentById(id) : null;
  })();
}

export const TRADE_INTENT_TTL_MS = 10 * 60 * 1000;
