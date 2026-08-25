/**
 * Trade Memory — LLM Evaluation Prompt Builder
 *
 * Builds a concise summary of recent closed trades so the LLM can
 * "learn" from actual outcomes WITHOUT modifying any risk parameters.
 *
 * Only shadow-live-compatible outcomes are allowed into memory. This keeps
 * prompt learning aligned with the same safety and execution path used before
 * real-money broadcast.
 */

import { db } from '../db/connection.js';

const MEMORY_WINDOW_MS = 72 * 60 * 60 * 1000;
const FALLBACK_MEMORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRADES_IN_PROMPT = 15;

function compatibleTrades(afterMs) {
  return db.prepare(`
    SELECT mint, symbol, pnl_percent, pnl_sol, exit_reason,
           entry_mcap, snapshot_json, opened_at_ms, closed_at_ms
    FROM dry_run_positions
    WHERE status = 'closed'
      AND execution_mode = 'shadow_live'
      AND json_extract(snapshot_json, '$.shadowLiveCompatible') = 1
      AND json_extract(snapshot_json, '$.simulatorVersion') = 'quote_sized_v3'
      AND json_extract(snapshot_json, '$.entryQuoteMode') = 'position_sized'
      AND closed_at_ms > ?
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(afterMs, MAX_TRADES_IN_PROMPT);
}

export function buildTradeMemory() {
  try {
    let trades = compatibleTrades(Date.now() - MEMORY_WINDOW_MS);
    let memoryLabel = 'Last 72h';
    if (trades.length < 5) {
      trades = compatibleTrades(Date.now() - FALLBACK_MEMORY_WINDOW_MS);
      memoryLabel = 'Up to 30d; freshest first';
    }
    if (!trades.length) return '';

    const wins = trades.filter(t => t.pnl_percent > 0);
    const losses = trades.filter(t => t.pnl_percent <= 0);
    const winRate = ((wins.length / trades.length) * 100).toFixed(0);
    const avgPnl = (trades.reduce((s, t) => s + (t.pnl_percent || 0), 0) / trades.length).toFixed(1);
    const lines = [
      `== TRADE MEMORY (${memoryLabel}: ${trades.length} shadow-live trades) ==`,
      `Stats: ${wins.length}W / ${losses.length}L, WR ${winRate}%, Avg PnL ${avgPnl}%`,
      '',
    ];

    if (wins.length) {
      lines.push('RECENT WINNERS (learn from these):');
      for (const t of wins.slice(0, 5)) {
        const info = extractTradeInfo(t);
        lines.push(`  ✅ ${t.symbol || '???'} +${(t.pnl_percent || 0).toFixed(0)}% [${info.route}] (liq $${info.liq}, holders ${info.holders}, bot ${info.botPct}%, mcap $${info.mcap})`);
      }
      lines.push('');
    }
    if (losses.length) {
      lines.push('RECENT LOSERS (avoid repeating these mistakes):');
      for (const t of losses.slice(0, 5)) {
        const info = extractTradeInfo(t);
        lines.push(`  ❌ ${t.symbol || '???'} ${(t.pnl_percent || 0).toFixed(0)}% exit:${t.exit_reason || '?'} [${info.route}] (liq $${info.liq}, holders ${info.holders}, bot ${info.botPct}%, mcap $${info.mcap})`);
      }
      lines.push('');
    }
    const patterns = detectPatterns(trades);
    if (patterns.length) {
      lines.push('DATA-DRIVEN PATTERNS:');
      for (const p of patterns) lines.push(`  ⚠️ ${p}`);
    }
    return lines.join('\n');
  } catch (err) {
    console.error(`[tradeMemory] Error building trade memory: ${err.message}`);
    return '';
  }
}

function extractTradeInfo(trade) {
  const result = { route: '?', liq: '?', holders: '?', botPct: '?', mcap: '?' };
  try {
    if (!trade.snapshot_json) return result;
    const snap = JSON.parse(trade.snapshot_json);
    const candidate = snap.candidate || {};
    const metrics = candidate.metrics || {};
    const audit = candidate.jupiterAsset?.audit || {};
    result.route = snap.signalRoute || candidate.signals?.route || '?';
    result.liq = Math.round(metrics.liquidityUsd || 0).toLocaleString();
    result.holders = Math.round(metrics.holderCount || 0);
    result.botPct = (audit.botHoldersPercentage || 0).toFixed(0);
    result.mcap = Math.round(trade.entry_mcap || metrics.marketCapUsd || 0).toLocaleString();
  } catch {}
  return result;
}

function detectPatterns(trades) {
  const patterns = [];
  const withBotData = trades.filter(t => {
    try { return JSON.parse(t.snapshot_json || '{}').candidate?.jupiterAsset?.audit?.botHoldersPercentage != null; }
    catch { return false; }
  });
  if (withBotData.length >= 5) {
    const highBotTrades = withBotData.filter(t => JSON.parse(t.snapshot_json).candidate?.jupiterAsset?.audit?.botHoldersPercentage > 30);
    if (highBotTrades.length >= 3) {
      const highBotLosses = highBotTrades.filter(t => t.pnl_percent <= 0);
      const lossRate = ((highBotLosses.length / highBotTrades.length) * 100).toFixed(0);
      if (Number(lossRate) >= 65) patterns.push(`Tokens with bot% > 30% lost ${lossRate}% of the time (${highBotLosses.length}/${highBotTrades.length}). Be very cautious.`);
    }
  }

  const routeStats = {};
  for (const t of trades) {
    try {
      const snap = JSON.parse(t.snapshot_json || '{}');
      const route = snap.signalRoute || snap.candidate?.signals?.route || 'unknown';
      if (!routeStats[route]) routeStats[route] = { wins: 0, losses: 0, total: 0 };
      routeStats[route].total++;
      if (t.pnl_percent > 0) routeStats[route].wins++; else routeStats[route].losses++;
    } catch {}
  }
  for (const [route, stats] of Object.entries(routeStats)) {
    if (stats.total < 3) continue;
    const wr = ((stats.wins / stats.total) * 100).toFixed(0);
    if (Number(wr) >= 50) patterns.push(`Route "${route}" has ${wr}% win rate (${stats.wins}/${stats.total}). Favor candidates from this route.`);
    else if (Number(wr) <= 20) patterns.push(`Route "${route}" has only ${wr}% win rate (${stats.wins}/${stats.total}). Be extra skeptical.`);
  }

  const withLiqData = trades.filter(t => {
    try { return (JSON.parse(t.snapshot_json || '{}').candidate?.metrics?.liquidityUsd || 0) > 0; }
    catch { return false; }
  });
  if (withLiqData.length >= 5) {
    const lowLiqTrades = withLiqData.filter(t => (JSON.parse(t.snapshot_json).candidate?.metrics?.liquidityUsd || 0) < 8000);
    if (lowLiqTrades.length >= 3) {
      const lowLiqLosses = lowLiqTrades.filter(t => t.pnl_percent <= 0);
      const lossRate = ((lowLiqLosses.length / lowLiqTrades.length) * 100).toFixed(0);
      if (Number(lossRate) >= 65) patterns.push(`Tokens with liquidity < $8k lost ${lossRate}% of the time (${lowLiqLosses.length}/${lowLiqTrades.length}). Prefer higher liquidity.`);
    }
  }

  const exitCounts = {};
  for (const t of trades) exitCounts[t.exit_reason || 'unknown'] = (exitCounts[t.exit_reason || 'unknown'] || 0) + 1;
  const topExit = Object.entries(exitCounts).sort((a, b) => b[1] - a[1])[0];
  if (topExit && topExit[1] >= 3) patterns.push(`Most common exit: "${topExit[0]}" (${((topExit[1] / trades.length) * 100).toFixed(0)}% of trades). Adjust entry timing if this is stop-loss.`);
  return patterns;
}
