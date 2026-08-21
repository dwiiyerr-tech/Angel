import { db } from '../db/connection.js';
import { safeJson } from '../utils.js';

function lessonPerformance(lessonId) {
  const lesson = db.prepare(`
    SELECT id, approved_at_ms, expires_at_ms, status, scope, lesson, instruction
    FROM learning_lessons WHERE id = ?
  `).get(lessonId);
  if (!lesson) return null;
  const rows = db.prepare(`
    SELECT d.learning_lesson_ids_json, p.pnl_percent, p.pnl_sol
    FROM llm_decisions d
    JOIN dry_run_positions p ON p.llm_decision_id = d.id
    WHERE p.status = 'closed'
      AND p.execution_mode = 'shadow_live'
      AND json_extract(p.snapshot_json, '$.shadowLiveCompatible') = 1
      AND json_extract(p.snapshot_json, '$.simulatorVersion') = 'quote_sized_v3'
      AND json_extract(p.snapshot_json, '$.entryQuoteMode') = 'position_sized'
      AND d.created_at_ms >= ?
  `).all(lesson.approved_at_ms || 0).filter(row =>
    safeJson(row.learning_lesson_ids_json, []).includes(Number(lessonId))
  );
  const wins = rows.filter(row => Number(row.pnl_percent) > 0).length;
  return {
    lesson,
    closedTrades: rows.length,
    wins,
    winRate: rows.length ? wins / rows.length * 100 : null,
    avgPnlPercent: rows.length ? rows.reduce((sum, row) => sum + Number(row.pnl_percent || 0), 0) / rows.length : null,
    totalPnlSol: rows.reduce((sum, row) => sum + Number(row.pnl_sol || 0), 0),
    evaluationReady: rows.length >= 30,
    attribution: 'prompt_exposure_only',
  };
}

export function activeLessonPerformance() {
  return db.prepare("SELECT id FROM learning_lessons WHERE status = 'active' AND (expires_at_ms IS NULL OR expires_at_ms > ?) ORDER BY id DESC")
    .all(Date.now()).map(row => lessonPerformance(row.id));
}
