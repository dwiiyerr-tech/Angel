import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID, DB_PATH } from '../config.js';
import { generateDailyCard } from '../visuals/dailyCard.js';
import { writeFileSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';

export async function buildDailyReport() {
  const db = new Database(DB_PATH);
  try {
    const now = Date.now();
    // Start of today in Jakarta time (UTC+7): midnight WIB = UTC midnight - 7h
    const wibOffset = 7 * 60 * 60 * 1000;
    const nowWIB = now + wibOffset;
    const todayWIBStart = Math.floor(nowWIB / 86400000) * 86400000; // midnight WIB in UTC+7 frame
    const startWIBmidnight = todayWIBStart - wibOffset; // convert back to UTC ms

    const closed = db.prepare(`
      SELECT * FROM dry_run_positions
      WHERE status = 'closed' AND closed_at_ms >= ?
      ORDER BY closed_at_ms DESC
    `).all(startWIBmidnight);

    const totalTrades = closed.length;
    const wins = closed.filter(p => (p.pnl_sol || 0) > 0).length;
    const losses = closed.filter(p => (p.pnl_sol || 0) <= 0).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    const pnlSol = closed.reduce((sum, p) => sum + (p.pnl_sol || 0), 0);
    const pnlPercent = totalTrades > 0
      ? closed.reduce((sum, p) => sum + (p.pnl_percent || 0), 0) / totalTrades
      : 0;

    const sorted = [...closed].sort((a, b) => (b.pnl_percent || 0) - (a.pnl_percent || 0));
    const bestTrade = totalTrades > 0
      ? { pnlPercent: sorted[0].pnl_percent || 0, symbol: sorted[0].symbol || sorted[0].mint }
      : null;
    const worstTrade = totalTrades > 0
      ? { pnlPercent: sorted[sorted.length - 1].pnl_percent || 0, symbol: sorted[sorted.length - 1].symbol || sorted[sorted.length - 1].mint }
      : null;

    const winTrades = closed.filter(p => (p.pnl_sol || 0) > 0);
    const lossTrades = closed.filter(p => (p.pnl_sol || 0) <= 0);
    const avgWin = winTrades.length > 0
      ? winTrades.reduce((s, p) => s + (p.pnl_percent || 0), 0) / winTrades.length
      : 0;
    const avgLoss = lossTrades.length > 0
      ? lossTrades.reduce((s, p) => s + (p.pnl_percent || 0), 0) / lossTrades.length
      : 0;
    const riskReward = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

    return {
      totalTrades,
      wins,
      losses,
      winRate,
      pnlSol,
      pnlPercent,
      bestTrade,
      worstTrade,
      avgWin,
      avgLoss,
      riskReward,
      positions: closed.map(p => ({
        pnlPercent: p.pnl_percent || 0,
        symbol: p.symbol || '',
      })),
      strategy: 'sniper',
    };
  } finally {
    db.close();
  }
}

export function buildReportCaption(report) {
  return [
    `\u{1F4CA} <b>Daily Report</b>`,
    '',
    `Trades: ${report.totalTrades} (${report.wins}W / ${report.losses}L) \u00B7 WR: ${report.winRate.toFixed(1)}%`,
    `PnL: ${report.pnlSol >= 0 ? '+' : ''}${report.pnlSol.toFixed(4)} SOL (avg ${report.pnlPercent >= 0 ? '+' : ''}${report.pnlPercent.toFixed(2)}%)`,
    report.bestTrade ? `Best: ${report.bestTrade.symbol} ${report.bestTrade.pnlPercent >= 0 ? '+' : ''}${report.bestTrade.pnlPercent.toFixed(2)}%` : '',
    report.worstTrade ? `Worst: ${report.worstTrade.symbol} ${report.worstTrade.pnlPercent >= 0 ? '+' : ''}${report.worstTrade.pnlPercent.toFixed(2)}%` : '',
    '',
    report.bestTrade && report.worstTrade ? `RR: \u22481:${report.riskReward.toFixed(2)}` : '',
  ].filter(Boolean).join('\n');
}

export async function sendDailyReport(chatId = TELEGRAM_CHAT_ID) {
  let tmpPath = '';
  try {
    const report = await buildDailyReport();
    const buffer = await generateDailyCard(report);
    tmpPath = `/tmp/angel_daily_${new Date().toISOString().slice(0, 10)}.png`;
    writeFileSync(tmpPath, buffer);

    await bot.sendPhoto(chatId, tmpPath, {
      caption: buildReportCaption(report),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    });
    console.log('[dailyReport] sent successfully');
  } catch (err) {
    console.error('[dailyReport] failed:', err.message);
    // fallback text
    const report = await buildDailyReport().catch(() => ({ totalTrades: 0, pnlSol: 0 }));
    const fallbackText = [
      `\u{1F4CA} <b>Daily Report (text fallback)</b>`,
      '',
      `Trades: ${report.totalTrades} | PnL: ${report.pnlSol >= 0 ? '+' : ''}${report.pnlSol.toFixed(4)} SOL`,
    ].filter(Boolean).join('\n');
    try {
      await bot.sendMessage(chatId, fallbackText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
      });
    } catch { /* give up */ }
  } finally {
    if (tmpPath) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
