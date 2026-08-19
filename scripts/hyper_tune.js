#!/usr/bin/env node
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'angel.sqlite');

const db = new Database(DB_PATH);

function runTuning() {
  const positions = db.prepare(`SELECT * FROM dry_run_positions WHERE status = 'closed'`).all();
  if (positions.length < 10) {
    console.log("Not enough closed positions for tuning (need at least 10).");
    return;
  }
  
  const tpRange = [20, 25, 30, 40, 50, 75, 100];
  const slRange = [-10, -15, -20, -25, -30, -50];
  
  let best = { tp: 0, sl: 0, winRate: 0, pnl: -9999, total: positions.length };
  
  console.log(`Starting hyper-parameter scan across ${positions.length} historical trades...`);
  
  for (const tp of tpRange) {
    for (const sl of slRange) {
      let pnl = 0;
      let wins = 0;
      for (const pos of positions) {
        const entry = pos.entry_mcap || 1;
        const max = pos.high_water_mcap || pos.entry_mcap || 1;
        const highPct = ((max - entry) / entry) * 100;
        const actualPct = pos.pnl_percent || 0;
        
        let simPct = actualPct;
        
        // Very basic simulation using high water mark
        if (highPct >= tp) {
          simPct = tp; // Hit TP
        } else if (actualPct <= sl) {
          simPct = sl; // Hit SL
        }
        
        pnl += simPct;
        if (simPct > 0) wins++;
      }
      
      const wr = wins / positions.length;
      if (pnl > best.pnl) {
        best = { tp, sl, winRate: wr, pnl, total: positions.length };
      }
    }
  }
  
  console.log("\n🧪 Tuning Results (Simulated):");
  console.log(`Best TP: +${best.tp}%`);
  console.log(`Best SL: ${best.sl}%`);
  console.log(`Simulated Win Rate: ${(best.winRate * 100).toFixed(1)}%`);
  console.log(`Simulated Relative PnL: ${best.pnl.toFixed(1)}%`);
  console.log("\nTo apply these globally, type in Telegram:");
  console.log(`/stratset sniper tp_percent ${best.tp}`);
  console.log(`/stratset sniper sl_percent ${best.sl}`);
}

try {
  runTuning();
} catch(err) {
  console.error("Tuning script error:", err.message);
}
