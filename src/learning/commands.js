import { bot } from '../telegram/bot.js';
import { now, formatWindow, parseWindowMs } from '../utils.js';
import { escapeHtml } from '../format.js';
import { db } from '../db/connection.js';
import { summarizeLearningWindow } from './summary.js';
import { generateLessons, storeLearningRun } from './lessons.js';
import { learningReportText } from './report.js';
import { activeLessonPerformance } from './evaluation.js';

export async function runLearning(chatId, windowArg = '7d') {
  const windowMs = parseWindowMs(windowArg);
  await bot.sendMessage(chatId, `Learning from the last ${formatWindow(windowMs)}...`);
  const summary = summarizeLearningWindow(windowMs);
  const { lessons, raw } = await generateLessons(summary);
  const runId = storeLearningRun(windowMs, summary, lessons, raw);
  return bot.sendMessage(chatId, learningReportText(runId, summary, lessons), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export async function sendLessons(chatId) {
  const rows = db.prepare(`
    SELECT id, created_at_ms, status, scope, confidence, lesson, instruction
    FROM learning_lessons
    WHERE status IN ('active', 'candidate')
    ORDER BY id DESC
    LIMIT 10
  `).all();
  const text = rows.length
    ? rows.map(row => `#${row.id} [${escapeHtml(row.status)} · ${escapeHtml(row.scope || 'global')} · ${escapeHtml(row.confidence || 'low')}]\n${escapeHtml(row.lesson)}\n→ ${escapeHtml(row.instruction || row.lesson)}`).join('\n\n')
    : 'No approved or candidate lessons. A candidate needs 7 days and at least 50 closed shadow-live-compatible trades.';
  return bot.sendMessage(chatId, `🧠 <b>LLM Lessons</b>\n\n${text}`, { parse_mode: 'HTML' });
}

export async function sendLessonEvaluation(chatId) {
  const rows = activeLessonPerformance();
  const text = rows.length ? rows.map(row => {
    const wr = row.winRate == null ? 'n/a' : `${row.winRate.toFixed(1)}%`;
    const pnl = row.avgPnlPercent == null ? 'n/a' : `${row.avgPnlPercent.toFixed(2)}%`;
    return `#${row.lesson.id} [${escapeHtml(row.lesson.scope || 'global')}] ${row.closedTrades} exposed closed · WR ${wr} · avg PnL ${pnl} · ${row.evaluationReady ? 'review-ready' : 'collecting (need 30)'}`;
  }).join('\n\n') : 'No active lessons to evaluate.';
  return bot.sendMessage(chatId, `📐 <b>Lesson Exposure Evaluation</b>\n\n${text}\n\nExposure is correlation, not proof that a lesson caused the outcome.`, { parse_mode: 'HTML' });
}

export function approveLesson(id) {
  const result = db.prepare(`
    UPDATE learning_lessons SET status = 'active', approved_at_ms = ?, expires_at_ms = ?
    WHERE id = ? AND status = 'candidate'
  `).run(now(), now() + 30 * 24 * 60 * 60 * 1000, id);
  return result.changes === 1;
}

export function rejectLesson(id) {
  const result = db.prepare(`
    UPDATE learning_lessons SET status = 'rejected', approved_at_ms = NULL
    WHERE id = ? AND status = 'candidate'
  `).run(id);
  return result.changes === 1;
}
