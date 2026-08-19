#!/usr/bin/env node
/**
 * Angel Health Monitor - reports anomalies to stdout.
 * Checks: SL streak, recent win rate, open positions, engine stall.
 * Usage: node scripts/monitor.mjs
 */
import { db } from '../src/db/connection.js';
import { now } from '../src/utils.js';

const ms = now();

// 1. SL streak — last 3 closed exits all SL?
const closed = db.prepare(
    `SELECT exit_reason FROM dry_run_positions WHERE status='closed' ORDER BY closed_at_ms DESC LIMIT 3`
).all();
if (closed.length >= 3 && closed.every(r => r.exit_reason === 'SL')) {
  console.log('⚠️  SL streak: last 3 exits ALL STOP_LOSS');
}

// 2. Win rate (last 10 closed)
const trades = db.prepare(
    `SELECT pnl_percent FROM dry_run_positions WHERE status='closed' ORDER BY closed_at_ms DESC LIMIT 10`
).all();
if (trades.length >= 5) {
  const wins = trades.filter(t => t.pnl_percent > 0).length;
  const wr = wins / trades.length;
  if (wr < 0.25) console.log(`⚠️  Win rate ${(wr*100).toFixed(0)}% over last ${trades.length} — below 25%`);
  console.log(`📊 Win rate: ${(wr*100).toFixed(0)}% (${wins}/${trades.length}) last closed`);
}

// 3. Open positions count
const open = db.prepare(`SELECT count(*) c FROM dry_run_positions WHERE status='open'`).get().c;
console.log(`🔓 Open positions: ${open}`);

// 4. Engine stall — last signal
const lastSig = db.prepare(`SELECT MAX(at_ms) m FROM signal_events`).get().m;
const stallMin = Math.round((now() - lastSig) / 60000);
console.log(`📈 Last signal: ${stallMin} min ago`);
if (stallMin > 15) console.log(`⏳ Engine quiet — last signal ${stallMin} min ago`);

// 5. Learning data freshness
const lastLearn = db.prepare(`SELECT MAX(created_at_ms) m FROM learning_runs`).get().m;
const learnAgeH = Math.round((now() - lastLearn) / 3600000);
console.log(`📚 Last learning run: ${learnAgeH}h ago`);
