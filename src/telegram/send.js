import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { now, json } from '../utils.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { numSetting } from '../db/settings.js';
import { candidateSummary, compactCandidateLine, batchRevealSummary, formatPosition } from './format.js';
import { candidateButtons, batchRevealButtons, positionButtons, intentButtons } from './menus.js';
import { batchById } from '../db/decisions.js';
import { generateEntryCard } from '../visuals/entryCard.js';
import { generateExitCard } from '../visuals/exitCard.js';
import { writeFileSync, unlinkSync } from 'fs';

export async function sendTelegram(text, extra = {}) {
  const options = {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
      ...extra,
    };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await bot.sendMessage(TELEGRAM_CHAT_ID, text, options);
    } catch (error) {
      lastError = error;
      const status = Number(error?.response?.statusCode || error?.response?.status || 0);
      const retryable = status === 429 || status >= 500 || /EFATAL|AggregateError|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error?.message || '');
      if (!retryable || attempt === 3) throw error;
      const retryAfterMs = Number(error?.response?.body?.parameters?.retry_after || 0) * 1000;
      await new Promise(resolve => setTimeout(resolve, Math.max(retryAfterMs, attempt * 1000)));
    }
  }
  throw lastError;
}

export async function sendCandidateAlert(candidateId, candidate, decision) {
  const sent = await sendTelegram(candidateSummary(candidate, decision), candidateButtons(candidateId, decision));
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, candidate.token.mint, 'candidate', now(), sent.message_id, json({ candidate, decision }));
}

export async function sendBatchReveal(batchId, rows, decision, triggerCandidateId) {
  const sent = await sendTelegram(
    batchRevealSummary(batchId, rows, decision, triggerCandidateId),
    batchRevealButtons(batchId, rows, decision, triggerCandidateId),
  );
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    triggerCandidateId || null,
    decision.selected_mint || rows.find(row => row.id === Number(triggerCandidateId))?.candidate?.token?.mint || 'batch',
    'batch_reveal',
    now(),
    sent.message_id,
    json({ batchId, candidateIds: rows.map(row => row.id), decision, triggerCandidateId }),
  );
}

export async function sendBatch(chatId, batchId) {
  const batch = batchById(batchId);
  if (!batch) return bot.sendMessage(chatId, 'Batch not found.');
  const lines = [
    '🧭 <b>Screening Batch</b>',
    '',
    `Batch: <b>#${batchId}</b> · Decision: <b>${escapeHtml(batch.verdict)}</b> ${fmtPct(batch.confidence)}`,
    batch.reason ? `Reason: ${escapeHtml(String(batch.reason).slice(0, 500))}` : null,
    '',
    ...batch.rows.slice(0, 15).map((row, index) => compactCandidateLine(row, index + 1)),
  ];
  const keyboard = batch.rows.slice(0, 10).map((row, index) => ([{
    text: `${index + 1}. ${row.candidate.token?.symbol || short(row.candidate.token?.mint || '')}`,
    callback_data: `cand:${row.id}`,
  }]));
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return bot.sendMessage(chatId, lines.filter(Boolean).join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  }).catch(err => console.error('[sendBatch] Failed:', err.message));
}

export async function sendPositionOpen(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!position) return;
  const label = position.execution_mode === 'live' ? 'Live buy executed' : 'Dry-run buy stored';
  const text = `✅ <b>${label}</b>\n\n${formatPosition(position)}`;
  let photoSent = false;
  try {
    const buffer = await generateEntryCard(position);
    const tmpPath = `/tmp/angel_entry_${positionId}.png`;
    writeFileSync(tmpPath, buffer);
    await bot.sendPhoto(TELEGRAM_CHAT_ID, tmpPath, {
      caption: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
      ...(positionButtons(positionId)?.reply_markup ? { reply_markup: positionButtons(positionId).reply_markup } : {}),
    });
    photoSent = true;
    try { unlinkSync(tmpPath); } catch (_) {}
  } catch (err) {
    if (!photoSent) {
      console.log('[send] entry card failed:', err.message);
      await sendTelegram(text, positionButtons(positionId));
    }
  }
}

export async function sendPositionExit(position) {
  const label = position?.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  const text = `🏁 <b>${label}: ${escapeHtml(position.exitReason)}</b>\n\n${formatPosition({ ...position, status: 'closed' })}`;
  let photoSent = false;
  try {
    const buffer = await generateExitCard(position);
    const tmpPath = `/tmp/angel_exit_${position.id}.png`;
    writeFileSync(tmpPath, buffer);
    await bot.sendPhoto(TELEGRAM_CHAT_ID, tmpPath, {
      caption: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    });
    photoSent = true;
    try { unlinkSync(tmpPath); } catch (_) {}
  } catch (err) {
    if (!photoSent) {
      console.log('[send] exit card failed:', err.message);
      await sendTelegram(text);
    }
  }
}

export async function sendTradeIntent(intentId, candidate, decision, approvedSizeSol) {
  await sendTelegram([
    '🧾 <b>Trade intent awaiting confirmation</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Maximum approved size: <b>${fmtSol(approvedSizeSol)} SOL</b>`,
    'Execution: confirmation required before signing.',
  ].join('\n'), intentButtons(intentId));
}
