import { TELEGRAM_CHAT_ID } from '../config.js';
import { bot } from '../telegram/bot.js';
import { escapeHtml } from '../format.js';
import { parseWindowMs, formatWindow } from '../utils.js';
import {
  decisionIntelligenceSummary,
  formatDecisionReceiptHtml,
  latestDecisionReceiptDetailsByMint,
  loadDecisionReceiptDetails,
} from '../decisionIntelligence/report.js';
import { clearManagerConversation, handleManagerMessage } from './index.js';

let initialized = false;

function authorized(msg) {
  return String(msg?.chat?.id) === String(TELEGRAM_CHAT_ID);
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summaryHtml(windowArg = '24h') {
  const windowMs = parseWindowMs(windowArg);
  const summary = decisionIntelligenceSummary(windowMs);
  const routes = summary.routes.slice(0, 5).map(row => {
    const avg = finite(row.averageFinalR);
    const r = avg == null ? '—' : `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}R`;
    return `• ${escapeHtml(row.route)}: N=${row.count}, outcomes=${row.outcomes}, avg ${r}, missed runners=${row.missedRunners}`;
  });
  const classes = Object.entries(summary.outcomes.classifications || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, value]) => `${escapeHtml(key)}=${value}`)
    .join(' · ');
  const decisionToProbe = finite(summary.probes.medianDecisionToProbeMs);
  const deterioration = finite(summary.probes.medianQuoteDeteriorationPct);
  const spread = finite(summary.probes.medianRoundtripSpreadPct);
  const medianFinalR = finite(summary.outcomes.medianFinalR);
  return [
    `🧠 <b>Decision Intelligence · ${escapeHtml(formatWindow(windowMs))}</b>`,
    '',
    `Receipts: <b>${summary.total}</b>`,
    `BUY ${summary.verdicts.BUY} · WATCH ${summary.verdicts.WATCH} · PASS ${summary.verdicts.PASS}`,
    `Executable probes: ready ${summary.probes.ready} · pending ${summary.probes.pending} · failed ${summary.probes.failed}`,
    `Median decision→probe: ${decisionToProbe == null ? '—' : `${Math.round(decisionToProbe)}ms`}`,
    `Median quote deterioration: ${deterioration == null ? '—' : `${deterioration.toFixed(2)}%`}`,
    `Median roundtrip spread: ${spread == null ? '—' : `${spread.toFixed(2)}%`}`,
    '',
    `<b>Outcomes</b>: finalized ${summary.outcomes.finalized} · median final ${medianFinalR == null ? '—' : `${medianFinalR >= 0 ? '+' : ''}${medianFinalR.toFixed(2)}R`}`,
    classes || 'No finalized classifications yet.',
    '',
    '<b>Top routes by sampled final R</b>',
    ...(routes.length ? routes : ['No route outcomes yet.']),
    '',
    '<i>Research receipts use 0 SOL capital and executable Jupiter counterfactual quotes.</i>',
  ].join('\n');
}

async function sendDecision(chatId, arg) {
  if (!arg) return bot.sendMessage(chatId, 'Usage: /decision <receipt_id|mint>');
  const numeric = /^#?\d+$/.test(arg);
  const details = numeric
    ? loadDecisionReceiptDetails(Number(arg.replace('#', '')))
    : latestDecisionReceiptDetailsByMint(arg);
  return bot.sendMessage(chatId, formatDecisionReceiptHtml(details), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export function setupTelegramManager() {
  if (initialized) return;
  initialized = true;

  bot.on('message', msg => {
    if (!authorized(msg)) return;
    const text = String(msg.text || '').trim();
    if (!text) return;

    if (text.startsWith('/ask')) {
      const question = text.replace(/^\/ask(?:@\S+)?\s*/i, '').trim();
      if (!question) {
        bot.sendMessage(msg.chat.id, 'Usage: /ask <question>\nOr simply send a normal message to chat with Angel Manager.').catch(() => {});
        return;
      }
      handleManagerMessage(msg.chat.id, question).catch(error => console.error(`[manager] /ask failed: ${error.message}`));
      return;
    }
    if (text.startsWith('/managerclear')) {
      clearManagerConversation(msg.chat.id).catch(error => console.error(`[manager] clear failed: ${error.message}`));
      return;
    }
    if (text.startsWith('/decision')) {
      const arg = text.split(/\s+/)[1];
      sendDecision(msg.chat.id, arg).catch(error => console.error(`[manager] decision report failed: ${error.message}`));
      return;
    }
    if (text.startsWith('/decisions')) {
      const windowArg = text.split(/\s+/)[1] || '24h';
      bot.sendMessage(msg.chat.id, summaryHtml(windowArg), { parse_mode: 'HTML' })
        .catch(error => console.error(`[manager] decisions summary failed: ${error.message}`));
      return;
    }

    // Existing deterministic Telegram commands remain owned by commands.js.
    if (text.startsWith('/')) return;
    // Numeric-only text can be an answer to an existing filter/input prompt.
    // Avoid racing that deterministic input state with the LLM listener.
    if (/^-?\d+(?:\.\d+)?(?:[kmb%])?$/i.test(text.replace(/\s+/g, ''))) return;

    handleManagerMessage(msg.chat.id, text).catch(error => console.error(`[manager] chat failed: ${error.message}`));
  });
}
