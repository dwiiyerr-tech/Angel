import { bot } from '../telegram/bot.js';
import { now, formatWindow, parseWindowMs } from '../utils.js';
import { escapeHtml } from '../format.js';
import { db } from '../db/connection.js';
import { summarizeLearningWindow } from './summary.js';
import { generateLessons, storeLearningRun } from './lessons.js';
import { learningReportText } from './report.js';

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
    SELECT id, created_at_ms, status, lesson
    FROM learning_lessons
    WHERE status IN ('active', 'candidate')
    ORDER BY id DESC
    LIMIT 10
  `).all();
  const text = rows.length
    ? rows.map(row => `#${row.id} [${escapeHtml(row.status)}] ${escapeHtml(row.lesson)}`).join('\n\n')
    : 'No approved or candidate lessons. A candidate needs 7 days and at least 50 closed dry-run trades.';
  return bot.sendMessage(chatId, `🧠 <b>LLM Lessons</b>\n\n${text}`, { parse_mode: 'HTML' });
}

export function approveLesson(id) {
  const result = db.prepare(`
    UPDATE learning_lessons SET status = 'active', approved_at_ms = ?
    WHERE id = ? AND status = 'candidate'
  `).run(now(), id);
  return result.changes === 1;
}

export function rejectLesson(id) {
  const result = db.prepare(`
    UPDATE learning_lessons SET status = 'rejected', approved_at_ms = NULL
    WHERE id = ? AND status = 'candidate'
  `).run(id);
  return result.changes === 1;
}
