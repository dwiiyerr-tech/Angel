import { bot } from '../telegram/bot.js';
import { buildManagerEvidence, clearManagerMessages, recentManagerMessages, storeManagerMessage } from './tools.js';
import { answerManagerQuestion } from './llm.js';

function liveAuthorizationIntent(text) {
  const value = String(text || '').toLowerCase();
  if (!/\blive\b/.test(value)) return false;
  return /(aktifkan|nyalakan|approve|setujui|otorisasi|enable|turn\s*on|mulai\s+live|go\s+live|jalankan\s+live)/i.test(value);
}

function chunkText(text, max = 3800) {
  const value = String(text || '').trim();
  if (value.length <= max) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function fallbackSummary(evidence, error) {
  const d = evidence?.decisionIntelligence || {};
  const s = evidence?.system || {};
  return [
    '👼 Angel Manager sedang tidak bisa menghubungi LLM, tetapi read-only evidence masih tersedia.',
    '',
    `Mode: ${s.mode || 'unknown'}`,
    `Decisions window: ${d.total || 0} (BUY ${d.verdicts?.BUY || 0} / WATCH ${d.verdicts?.WATCH || 0} / PASS ${d.verdicts?.PASS || 0})`,
    `Finalized outcomes: ${d.outcomes?.finalized || 0}`,
    `Median final R: ${Number.isFinite(Number(d.outcomes?.medianFinalR)) ? Number(d.outcomes.medianFinalR).toFixed(2) + 'R' : '—'}`,
    `Unresolved executions: ${s.liveSafety?.unresolvedExecutions ?? '—'}`,
    `Circuit breaker: ${s.liveSafety?.circuitOpen ? 'OPEN' : 'CLOSED'}`,
    '',
    `LLM error: ${error.message}`,
    'Tidak ada setting, approval, atau transaksi yang diubah.',
  ].join('\n');
}

export async function handleManagerMessage(chatId, question) {
  const text = String(question || '').trim();
  if (!text) return;

  if (liveAuthorizationIntent(text)) {
    const reply = [
      '🔐 Angel Manager bersifat read-only dan tidak memiliki fungsi untuk approve atau mengaktifkan Live.',
      '',
      'Saya bisa menilai kesiapan, menjelaskan risk/evidence, dan merekomendasikan apakah Live layak dipertimbangkan.',
      'Otorisasi Live tetap harus dilakukan sendiri oleh owner melalui kontrol deterministik /livestatus dan /liveapprove.',
    ].join('\n');
    storeManagerMessage(chatId, 'user', text);
    storeManagerMessage(chatId, 'assistant', reply);
    return bot.sendMessage(chatId, reply);
  }

  const history = recentManagerMessages(chatId, 8);
  const evidence = buildManagerEvidence(text);
  storeManagerMessage(chatId, 'user', text);

  let answer;
  try {
    const response = await answerManagerQuestion({ question: text, evidence, history });
    answer = response.content;
  } catch (error) {
    answer = fallbackSummary(evidence, error);
  }
  storeManagerMessage(chatId, 'assistant', answer);

  for (const chunk of chunkText(answer)) {
    await bot.sendMessage(chatId, chunk, { disable_web_page_preview: true });
  }
}

export function clearManagerConversation(chatId) {
  const removed = clearManagerMessages(chatId);
  return bot.sendMessage(chatId, `🧹 Angel Manager memory cleared (${removed} message${removed === 1 ? '' : 's'} removed). Trading evidence/receipts were not deleted.`);
}
