import sqlite3 from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env.DB_PATH || './angel.sqlite';

export function runAutoTuner() {
  console.log(`[auto-tuner] 🤖 Starting daily performance evaluation on ${dbPath}...`);
  const db = sqlite3(dbPath);

  const sevenDaysAgo = Date.now() - 7 * 86400000;

  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_percent <= 0 THEN 1 ELSE 0 END) as losses,
      AVG(pnl_percent) as avg_pnl_pct,
      SUM(pnl_sol) as total_pnl_sol
    FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms > ?
  `).get(sevenDaysAgo);

  const total = stats.total_trades || 0;
  const wins = stats.wins || 0;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const netPnlSol = stats.total_pnl_sol || 0;

  console.log(`[auto-tuner] 📊 7-Day Performance Stats:`);
  console.log(`  • Total Trades: ${total}`);
  console.log(`  • Win Rate: ${winRate.toFixed(1)}% (${wins}/${total})`);
  console.log(`  • Net PnL: ${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(4)} SOL`);
  console.log(`  • Avg PnL: ${stats.avg_pnl_pct ? stats.avg_pnl_pct.toFixed(2) : 0}%`);

  let recommendation = null;
  if (total >= 50) {
    if (winRate < 35 || netPnlSol < 0) {
      console.log(`[auto-tuner] ⚠️ Performance below target (WR < 35% or Net PnL < 0). Auto-tightening safety parameters...`);
      recommendation = { min_liquidity_usd: 6000, sideways_timeout_minutes: 4, llm_min_confidence: 45 };
    } else if (winRate >= 50 && netPnlSol > 0) {
      console.log(`[auto-tuner] 🎉 Performance strong (WR >= 50% & Net PnL > 0). Optimizing parameters for growth...`);
      recommendation = { sideways_timeout_minutes: 5, llm_min_confidence: 35 };
    }
  } else {
    console.log(`[auto-tuner] ℹ️ Insufficient trades (${total}/50) for a recommendation.`);
  }
  console.log(recommendation
    ? `[auto-tuner] ADVISORY ONLY: ${JSON.stringify(recommendation)} (nothing applied)`
    : '[auto-tuner] ADVISORY ONLY: no recommendation (nothing applied)');
  db.close();
  return { total, winRate, netPnlSol, recommendation, applied: false };
}

if (process.argv[1] && process.argv[1].endsWith('daily_autotuner.js')) {
  runAutoTuner();
}
