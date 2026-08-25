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
import { preLiveReadinessReport } from '../readiness/engine.js';
import { formatReadinessHtml } from '../readiness/format.js';
import { clearManagerConversation, handleManagerMessage } from './index.js';
import {
  decisionNotificationStatus,
  setAllDecisionNotifications,
  setDecisionNotification,
} from '../telegram/preferences.js';
import {
  dailyReportScheduleStatus,
  sendDailyReport,
  setDailyReportEnabled,
  setDailyReportTimeWib,
  startDailyReportScheduler,
} from '../telegram/dailyReport.js';

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
    '<i>PAPER receipts use 0 SOL real capital and executable Jupiter counterfactual quotes.</i>',
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

function sendReadiness(chatId, windowArg = '7d') {
  const windowMs = parseWindowMs(windowArg);
  const report = preLiveReadinessReport(windowMs);
  return bot.sendMessage(chatId, formatReadinessHtml(report), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

function boolWord(value) {
  return value ? 'ON' : 'OFF';
}

function notificationStatusText() {
  const status = decisionNotificationStatus();
  return [
    '🔔 <b>Decision Notifications</b>',
    '',
    `BUY: <b>${boolWord(status.buy)}</b>`,
    `WATCH: <b>${boolWord(status.watch)}</b>`,
    `PASS: <b>${boolWord(status.pass)}</b>`,
    '',
    '<i>This only mutes screening/decision alerts. LIVE approvals, executions, exits, safety alerts, and critical errors remain enabled.</i>',
    '',
    'Usage: <code>/notify buy|watch|pass|all on|off</code>',
  ].join('\n');
}

function handleNotifyCommand(chatId, text) {
  const [, targetRaw, valueRaw] = text.split(/\s+/);
  if (!targetRaw) return bot.sendMessage(chatId, notificationStatusText(), { parse_mode: 'HTML' });
  const target = targetRaw.toLowerCase();
  const value = String(valueRaw || '').toLowerCase();
  if (!['buy', 'watch', 'pass', 'all'].includes(target) || !['on', 'off'].includes(value)) {
    return bot.sendMessage(chatId, 'Usage: /notify buy|watch|pass|all on|off');
  }
  if (target === 'all') setAllDecisionNotifications(value === 'on');
  else setDecisionNotification(target, value === 'on');
  return bot.sendMessage(chatId, notificationStatusText(), { parse_mode: 'HTML' });
}

function dailyReportStatusText() {
  const status = dailyReportScheduleStatus();
  return [
    '📊 <b>24h Performance Report</b>',
    '',
    `Automatic report: <b>${boolWord(status.enabled)}</b>`,
    `Schedule: <b>${escapeHtml(status.timeWib)} WIB</b>`,
    `Last scheduled report date: <b>${escapeHtml(status.lastSentWibDate || 'none')}</b>`,
    '',
    'Commands:',
    '<code>/dailyreport on</code> · <code>/dailyreport off</code>',
    '<code>/dailyreport time 00:05</code>',
    '<code>/dailyreport now</code>',
    '',
    '<i>LIVE realized PnL and PAPER virtual PnL are reported separately.</i>',
  ].join('\n');
}

async function handleDailyReportCommand(chatId, text) {
  const parts = text.split(/\s+/);
  const action = String(parts[1] || '').toLowerCase();
  if (!action || action === 'status') {
    return bot.sendMessage(chatId, dailyReportStatusText(), { parse_mode: 'HTML' });
  }
  if (action === 'on' || action === 'off') {
    setDailyReportEnabled(action === 'on');
    return bot.sendMessage(chatId, dailyReportStatusText(), { parse_mode: 'HTML' });
  }
  if (action === 'time') {
    try {
      setDailyReportTimeWib(parts[2]);
      return bot.sendMessage(chatId, dailyReportStatusText(), { parse_mode: 'HTML' });
    } catch (error) {
      return bot.sendMessage(chatId, `Invalid report time: ${error.message}`);
    }
  }
  if (action === 'now') {
    await bot.sendMessage(chatId, '📊 Building rolling 24h report…');
    const sent = await sendDailyReport(chatId);
    if (!sent) return bot.sendMessage(chatId, '24h report failed. Check bot logs for the underlying error.');
    return;
  }
  return bot.sendMessage(chatId, 'Usage: /dailyreport [status|on|off|now|time HH:MM]');
}

export function setupTelegramManager() {
  if (initialized) return;
  initialized = true;
  startDailyReportScheduler();

  bot.on('message', msg => {
    if (!authorized(msg)) return;
    const text = String(msg.text || '').trim();
    if (!text) return;

    if (text.startsWith('/ask')) {
      const question = text.replace(/^\/ask(?:@\S+)?\s*/i, '').trim();
      if (!question) {
        bot.sendMessage(msg.chat.id, 'Usage: /ask <question>\nOr simply send a normal message to chat with Angel Manager V2.').catch(() => {});
        return;
      }
      handleManagerMessage(msg.chat.id, question).catch(error => console.error(`[manager] /ask failed: ${error.message}`));
      return;
    }
    if (text.startsWith('/managerclear')) {
      clearManagerConversation(msg.chat.id).catch(error => console.error(`[manager] clear failed: ${error.message}`));
      return;
    }
    if (text.startsWith('/notify')) {
      Promise.resolve(handleNotifyCommand(msg.chat.id, text)).catch(error => console.error(`[manager] notify failed: ${error.message}`));
      return;
    }
    if (text.startsWith('/dailyreport')) {
      handleDailyReportCommand(msg.chat.id, text).catch(error => console.error(`[manager] daily report failed: ${error.message}`));
      return;
    }
    if (text.startsWith('/readiness')) {
      const windowArg = text.split(/\s+/)[1] || '7d';
      try {
        sendReadiness(msg.chat.id, windowArg).catch(error => console.error(`[manager] readiness failed: ${error.message}`));
      } catch (error) {
        bot.sendMessage(msg.chat.id, `Readiness report failed: ${error.message}`).catch(() => {});
      }
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
