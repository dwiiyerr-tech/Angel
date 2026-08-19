/**
 * Trade Memory — LLM Evaluation Prompt Builder
 * 
 * Builds a concise summary of recent closed trades so the LLM can
 * "learn" from actual outcomes WITHOUT modifying any risk parameters.
 * 
 * The LLM only uses this context to make better BUY/PASS decisions.
 * It does NOT auto-tune TP/SL/Size — that stays under human control.
 */

import { db } from '../db/connection.js';

const MEMORY_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours
const FALLBACK_MEMORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRADES_IN_PROMPT = 15;

/**
 * Fetch recent closed trades and build a compact evaluation block
 * for injecting into the LLM system prompt.
 * 
 * Returns a string like:
 *   == TRADE MEMORY (Last 72h) ==
 *   Stats: 12 trades, 4W/8L, WR 33%, Avg PnL -5.2%
 *   WINNERS: [route] symbol +25% (liq $15k, holders 200, bot 12%)
 *   LOSERS:  [route] symbol -12% exit:sl_hit (liq $4k, holders 80, bot 45%)
 *   PATTERN: Tokens with bot% > 30% lost 85% of the time. Avoid.
 */
export function buildTradeMemory() {
  try {
    const cutoff = Date.now() - MEMORY_WINDOW_MS;

    let trades = db.prepare(`
      SELECT mint, symbol, pnl_percent, pnl_sol, exit_reason, 
             entry_mcap, snapshot_json, opened_at_ms, closed_at_ms
      FROM dry_run_positions
      WHERE status = 'closed' AND closed_at_ms > ?
      ORDER BY closed_at_ms DESC
      LIMIT ?
    `).all(cutoff, MAX_TRADES_IN_PROMPT);

    // Sparse periods should not erase useful experience. Prefer fresh trades,
    // but extend to 30 days when fewer than five outcomes exist in 72 hours.
    let memoryLabel = 'Last 72h';
    if (trades.length < 5) {
      trades = db.prepare(`
        SELECT mint, symbol, pnl_percent, pnl_sol, exit_reason,
               entry_mcap, snapshot_json, opened_at_ms, closed_at_ms
        FROM dry_run_positions
        WHERE status = 'closed' AND closed_at_ms > ?
        ORDER BY closed_at_ms DESC
        LIMIT ?
      `).all(Date.now() - FALLBACK_MEMORY_WINDOW_MS, MAX_TRADES_IN_PROMPT);
      memoryLabel = 'Up to 30d; freshest first';
    }

    if (!trades || trades.length === 0) {
      return '';
    }

    const wins = trades.filter(t => t.pnl_percent > 0);
    const losses = trades.filter(t => t.pnl_percent <= 0);
    const winRate = ((wins.length / trades.length) * 100).toFixed(0);
    const avgPnl = (trades.reduce((s, t) => s + (t.pnl_percent || 0), 0) / trades.length).toFixed(1);

    const lines = [
      `== TRADE MEMORY (${memoryLabel}: ${trades.length} trades) ==`,
      `Stats: ${wins.length}W / ${losses.length}L, WR ${winRate}%, Avg PnL ${avgPnl}%`,
      '',
    ];

    // Summarize winners
    if (wins.length > 0) {
      lines.push('RECENT WINNERS (learn from these):');
      for (const t of wins.slice(0, 5)) {
        const info = extractTradeInfo(t);
        lines.push(`  ✅ ${t.symbol || '???'} +${(t.pnl_percent || 0).toFixed(0)}% [${info.route}] (liq $${info.liq}, holders ${info.holders}, bot ${info.botPct}%, mcap $${info.mcap})`);
      }
      lines.push('');
    }

    // Summarize losers
    if (losses.length > 0) {
      lines.push('RECENT LOSERS (avoid repeating these mistakes):');
      for (const t of losses.slice(0, 5)) {
        const info = extractTradeInfo(t);
        lines.push(`  ❌ ${t.symbol || '???'} ${(t.pnl_percent || 0).toFixed(0)}% exit:${t.exit_reason || '?'} [${info.route}] (liq $${info.liq}, holders ${info.holders}, bot ${info.botPct}%, mcap $${info.mcap})`);
      }
      lines.push('');
    }

    // Detect patterns from data
    const patterns = detectPatterns(trades);
    if (patterns.length > 0) {
      lines.push('DATA-DRIVEN PATTERNS:');
      for (const p of patterns) {
        lines.push(`  ⚠️ ${p}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    console.error(`[tradeMemory] Error building trade memory: ${err.message}`);
    return '';
  }
}

/**
 * Extract compact info from a trade's snapshot_json
 */
function extractTradeInfo(trade) {
  const result = {
    route: '?',
    liq: '?',
    holders: '?',
    botPct: '?',
    mcap: '?',
  };

  try {
    if (!trade.snapshot_json) return result;
    const snap = JSON.parse(trade.snapshot_json);
    const candidate = snap.candidate || {};
    const metrics = candidate.metrics || {};
    const jupiter = candidate.jupiterAsset || {};
    const audit = jupiter.audit || {};

    result.route = snap.signalRoute || candidate.signals?.route || '?';
    result.liq = Math.round(metrics.liquidityUsd || 0).toLocaleString();
    result.holders = Math.round(metrics.holderCount || 0);
    result.botPct = (audit.botHoldersPercentage || 0).toFixed(0);
    result.mcap = Math.round(trade.entry_mcap || metrics.marketCapUsd || 0).toLocaleString();
  } catch (err) {
    // Parse failed — return defaults
  }

  return result;
}

/**
 * Detect simple statistical patterns from recent trades.
 * Returns array of human-readable pattern strings.
 */
function detectPatterns(trades) {
  const patterns = [];

  // Pattern 1: Bot% correlation
  const withBotData = trades.filter(t => {
    try {
      const snap = JSON.parse(t.snapshot_json || '{}');
      const botPct = snap.candidate?.jupiterAsset?.audit?.botHoldersPercentage;
      return botPct != null;
    } catch { return false; }
  });

  if (withBotData.length >= 5) {
    const highBotTrades = withBotData.filter(t => {
      const snap = JSON.parse(t.snapshot_json);
      return (snap.candidate?.jupiterAsset?.audit?.botHoldersPercentage || 0) > 30;
    });
    if (highBotTrades.length >= 3) {
      const highBotLosses = highBotTrades.filter(t => t.pnl_percent <= 0);
      const lossRate = ((highBotLosses.length / highBotTrades.length) * 100).toFixed(0);
      if (parseInt(lossRate) >= 65) {
        patterns.push(`Tokens with bot% > 30% lost ${lossRate}% of the time (${highBotLosses.length}/${highBotTrades.length}). Be very cautious.`);
      }
    }
  }

  // Pattern 2: Route performance
  const routeStats = {};
  for (const t of trades) {
    try {
      const snap = JSON.parse(t.snapshot_json || '{}');
      const route = snap.signalRoute || snap.candidate?.signals?.route || 'unknown';
      if (!routeStats[route]) routeStats[route] = { wins: 0, losses: 0, total: 0 };
      routeStats[route].total++;
      if (t.pnl_percent > 0) routeStats[route].wins++;
      else routeStats[route].losses++;
    } catch { /* skip */ }
  }

  for (const [route, stats] of Object.entries(routeStats)) {
    if (stats.total >= 3) {
      const wr = ((stats.wins / stats.total) * 100).toFixed(0);
      if (parseInt(wr) >= 50) {
        patterns.push(`Route "${route}" has ${wr}% win rate (${stats.wins}/${stats.total}). Favor candidates from this route.`);
      } else if (parseInt(wr) <= 20) {
        patterns.push(`Route "${route}" has only ${wr}% win rate (${stats.wins}/${stats.total}). Be extra skeptical.`);
      }
    }
  }

  // Pattern 3: Liquidity correlation
  const withLiqData = trades.filter(t => {
    try {
      const snap = JSON.parse(t.snapshot_json || '{}');
      return (snap.candidate?.metrics?.liquidityUsd || 0) > 0;
    } catch { return false; }
  });

  if (withLiqData.length >= 5) {
    const lowLiqTrades = withLiqData.filter(t => {
      const snap = JSON.parse(t.snapshot_json);
      return (snap.candidate?.metrics?.liquidityUsd || 0) < 8000;
    });
    if (lowLiqTrades.length >= 3) {
      const lowLiqLosses = lowLiqTrades.filter(t => t.pnl_percent <= 0);
      const lossRate = ((lowLiqLosses.length / lowLiqTrades.length) * 100).toFixed(0);
      if (parseInt(lossRate) >= 65) {
        patterns.push(`Tokens with liquidity < $8k lost ${lossRate}% of the time (${lowLiqLosses.length}/${lowLiqTrades.length}). Prefer higher liquidity.`);
      }
    }
  }

  // Pattern 4: Exit reason analysis
  const exitCounts = {};
  for (const t of trades) {
    const reason = t.exit_reason || 'unknown';
    exitCounts[reason] = (exitCounts[reason] || 0) + 1;
  }
  const topExit = Object.entries(exitCounts).sort((a, b) => b[1] - a[1])[0];
  if (topExit && topExit[1] >= 3) {
    const pct = ((topExit[1] / trades.length) * 100).toFixed(0);
    patterns.push(`Most common exit: "${topExit[0]}" (${pct}% of trades). Adjust entry timing if this is stop-loss.`);
  }

  return patterns;
}
