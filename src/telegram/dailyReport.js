import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID, DB_PATH } from '../config.js';
import { generateDailyCard } from '../visuals/dailyCard.js';
import { escapeHtml } from '../format.js';
import { boolSetting, setting, setSetting } from '../db/settings.js';
import { writeFileSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';

const DAY_MS = 24 * 60 * 60 * 1000;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const REPORT_ENABLED_KEY = 'telegram_daily_report_enabled';
const REPORT_TIME_KEY = 'telegram_daily_report_time_wib';
const REPORT_LAST_DATE_KEY = 'telegram_daily_report_last_sent_wib_date';
const DEFAULT_REPORT_TIME_WIB = '00:05';
let schedulerTimer = null;
let schedulerRunning = false;

function publicMode(row) {
  return row?.execution_mode === 'live' ? 'LIVE' : 'PAPER';
}

function wibDateKey(ms) {
  return new Date(Number(ms) + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

function wibClock(ms) {
  return new Date(Number(ms) + WIB_OFFSET_MS).toISOString().slice(11, 16);
}

function minutesOfDayWib(ms) {
  const clock = wibClock(ms).split(':').map(Number);
  return clock[0] * 60 + clock[1];
}

function parseTimeWib(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return { text: `${match[1]}:${match[2]}`, minutes: Number(match[1]) * 60 + Number(match[2]) };
}

function summarize(rows) {
  const totalTrades = rows.length;
  const wins = rows.filter(p => Number(p.pnl_sol || 0) > 0).length;
  const losses = rows.filter(p => Number(p.pnl_sol || 0) < 0).length;
  const breakeven = totalTrades - wins - losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const pnlSol = rows.reduce((sum, p) => sum + Number(p.pnl_sol || 0), 0);
  const pnlPercent = totalTrades > 0
    ? rows.reduce((sum, p) => sum + Number(p.pnl_percent || 0), 0) / totalTrades
    : 0;

  const sorted = [...rows].sort((a, b) => Number(b.pnl_percent || 0) - Number(a.pnl_percent || 0));
  const bestTrade = totalTrades > 0
    ? { pnlPercent: Number(sorted[0].pnl_percent || 0), symbol: sorted[0].symbol || sorted[0].mint }
    : null;
  const worstTrade = totalTrades > 0
    ? { pnlPercent: Number(sorted[sorted.length - 1].pnl_percent || 0), symbol: sorted[sorted.length - 1].symbol || sorted[sorted.length - 1].mint }
    : null;

  const winTrades = rows.filter(p => Number(p.pnl_sol || 0) > 0);
  const lossTrades = rows.filter(p => Number(p.pnl_sol || 0) < 0);
  const avgWin = winTrades.length > 0
    ? winTrades.reduce((sum, p) => sum + Number(p.pnl_percent || 0), 0) / winTrades.length
    : 0;
  const avgLoss = lossTrades.length > 0
    ? lossTrades.reduce((sum, p) => sum + Number(p.pnl_percent || 0), 0) / lossTrades.length
    : 0;
  const riskReward = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  const rValues = rows.map(p => Number(p.realized_r)).filter(Number.isFinite);
  const expectancyR = rValues.length > 0
    ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length
    : null;

  return {
    totalTrades,
    wins,
    losses,
    breakeven,
    winRate,
    pnlSol,
    pnlPercent,
    bestTrade,
    worstTrade,
    avgWin,
    avgLoss,
    riskReward,
    expectancyR,
    rSamples: rValues.length,
    positions: rows.map(p => ({
      pnlPercent: Number(p.pnl_percent || 0),
      symbol: p.symbol || '',
    })),
  };
}

export async function buildDailyReport(nowMs = Date.now()) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const windowEndMs = Number(nowMs);
    const windowStartMs = windowEndMs - DAY_MS;
    const closed = db.prepare(`
      SELECT id, mint, symbol, execution_mode, pnl_sol, pnl_percent, realized_r, closed_at_ms
      FROM dry_run_positions
      WHERE status = 'closed' AND closed_at_ms >= ? AND closed_at_ms <= ?
      ORDER BY closed_at_ms DESC
    `).all(windowStartMs, windowEndMs);

    const paperRows = closed.filter(row => publicMode(row) === 'PAPER');
    const liveRows = closed.filter(row => publicMode(row) === 'LIVE');
    const paper = summarize(paperRows);
    const live = summarize(liveRows);
    const primaryMode = live.totalTrades > 0 ? 'LIVE' : 'PAPER';
    const primary = primaryMode === 'LIVE' ? live : paper;

    return {
      date: wibDateKey(windowEndMs),
      windowStartMs,
      windowEndMs,
      windowLabel: `${wibDateKey(windowStartMs)} ${wibClock(windowStartMs)} → ${wibDateKey(windowEndMs)} ${wibClock(windowEndMs)} WIB`,
      primaryMode,
      totalClosedAcrossModes: closed.length,
      paper,
      live,
      ...primary,
      strategy: 'active',
    };
  } finally {
    db.close();
  }
}

function fmtPnl(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? '+' : ''}${number.toFixed(4)} SOL`;
}

function fmtR(value, samples) {
  return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}R (N=${samples})` : '—';
}

function modeLines(label, report, pnlLabel) {
  return [
    `<b>${label}</b>`,
    `Trades: ${report.totalTrades} · ${report.wins}W / ${report.losses}L${report.breakeven ? ` / ${report.breakeven}BE` : ''} · WR ${report.winRate.toFixed(1)}%`,
    `${pnlLabel}: ${fmtPnl(report.pnlSol)} · Avg ${report.pnlPercent >= 0 ? '+' : ''}${report.pnlPercent.toFixed(2)}%`,
    `Expectancy: ${fmtR(report.expectancyR, report.rSamples)}`,
  ];
}

export function buildReportCaption(report) {
  const primary = report.primaryMode === 'LIVE' ? report.live : report.paper;
  return [
    '📊 <b>Angel 24h Performance Report</b>',
    `<i>${escapeHtml(report.windowLabel)}</i>`,
    '',
    ...modeLines('🔴 LIVE · real capital', report.live, 'Realized PnL'),
    '',
    ...modeLines('🟢 PAPER · zero real capital', report.paper, 'Virtual PnL'),
    '',
    primary.bestTrade ? `Best ${report.primaryMode}: ${escapeHtml(primary.bestTrade.symbol)} ${primary.bestTrade.pnlPercent >= 0 ? '+' : ''}${primary.bestTrade.pnlPercent.toFixed(2)}%` : null,
    primary.worstTrade ? `Worst ${report.primaryMode}: ${escapeHtml(primary.worstTrade.symbol)} ${primary.worstTrade.pnlPercent >= 0 ? '+' : ''}${primary.worstTrade.pnlPercent.toFixed(2)}%` : null,
    '',
    '<i>PAPER PnL is simulated/virtual and is never added to LIVE realized PnL.</i>',
  ].filter(Boolean).join('\n');
}

export async function sendDailyReport(chatId = TELEGRAM_CHAT_ID) {
  let tmpPath = '';
  let report;
  try {
    report = await buildDailyReport();
  } catch (error) {
    console.error('[dailyReport] build failed:', error.message);
    return false;
  }

  const caption = buildReportCaption(report);
  try {
    const buffer = await generateDailyCard(report);
    tmpPath = `/tmp/angel_daily_${Date.now()}.png`;
    writeFileSync(tmpPath, buffer);
    await bot.sendPhoto(chatId, tmpPath, {
      caption,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    });
    console.log('[dailyReport] 24h report sent successfully');
    return true;
  } catch (error) {
    console.error('[dailyReport] card failed, using text fallback:', error.message);
    try {
      await bot.sendMessage(chatId, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
      });
      return true;
    } catch (fallbackError) {
      console.error('[dailyReport] text fallback failed:', fallbackError.message);
      return false;
    }
  } finally {
    if (tmpPath) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

export function dailyReportScheduleStatus() {
  const parsed = parseTimeWib(setting(REPORT_TIME_KEY, DEFAULT_REPORT_TIME_WIB)) || parseTimeWib(DEFAULT_REPORT_TIME_WIB);
  return {
    enabled: boolSetting(REPORT_ENABLED_KEY, true),
    timeWib: parsed.text,
    lastSentWibDate: setting(REPORT_LAST_DATE_KEY, '') || null,
  };
}

export function setDailyReportEnabled(value) {
  setSetting(REPORT_ENABLED_KEY, value ? 'true' : 'false');
  return dailyReportScheduleStatus();
}

export function setDailyReportTimeWib(value) {
  const parsed = parseTimeWib(value);
  if (!parsed) throw new Error('Time must use HH:MM in WIB, for example 00:05 or 23:30');
  setSetting(REPORT_TIME_KEY, parsed.text);
  return dailyReportScheduleStatus();
}

async function runScheduledReportCheck() {
  if (schedulerRunning) return;
  const status = dailyReportScheduleStatus();
  if (!status.enabled) return;
  const nowMs = Date.now();
  const schedule = parseTimeWib(status.timeWib);
  if (!schedule || minutesOfDayWib(nowMs) < schedule.minutes) return;
  const today = wibDateKey(nowMs);
  if (status.lastSentWibDate === today) return;

  schedulerRunning = true;
  try {
    const sent = await sendDailyReport();
    if (sent) setSetting(REPORT_LAST_DATE_KEY, today);
  } finally {
    schedulerRunning = false;
  }
}

export function startDailyReportScheduler() {
  if (schedulerTimer) return;
  const status = dailyReportScheduleStatus();
  const nowMs = Date.now();
  const schedule = parseTimeWib(status.timeWib);
  if (!status.lastSentWibDate && schedule && minutesOfDayWib(nowMs) >= schedule.minutes) {
    // First deployment after today's scheduled time should not immediately emit
    // a catch-up report and then emit another one shortly after midnight.
    setSetting(REPORT_LAST_DATE_KEY, wibDateKey(nowMs));
  }
  setTimeout(() => runScheduledReportCheck().catch(error => console.error(`[dailyReport] scheduler check failed: ${error.message}`)), 10_000);
  schedulerTimer = setInterval(() => {
    runScheduledReportCheck().catch(error => console.error(`[dailyReport] scheduler check failed: ${error.message}`));
  }, 60_000);
  console.log(`[dailyReport] scheduler enabled=${dailyReportScheduleStatus().enabled} at ${dailyReportScheduleStatus().timeWib} WIB`);
}
