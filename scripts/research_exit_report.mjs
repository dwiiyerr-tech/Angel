import { db, initDb } from '../src/db/connection.js';
import { ensureResearchSchema } from '../src/research/schema.js';
import { ensureResearchExitSimulatorSchema } from '../src/research/exitSimulator.js';

function parseWindow(value = '7d') {
  const match = String(value || '7d').trim().toLowerCase().match(/^(\d+)(h|d)$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const amount = Math.max(1, Number(match[1]));
  return amount * (match[2] === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
}

function percentile(values, p) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil(clean.length * p) - 1));
  return clean[index];
}

function fmt(value, digits = 3, suffix = '') {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : 'n/a';
}

initDb();
ensureResearchSchema();
ensureResearchExitSimulatorSchema();

const requested = process.argv[2] || '7d';
const windowMs = parseWindow(requested);
const since = Date.now() - windowMs;
const rows = db.prepare(`
  SELECT * FROM research_exit_settlements
  WHERE created_at_ms >= ?
  ORDER BY id ASC
`).all(since);

const completed = rows.filter(row => row.status === 'completed');
const pending = rows.filter(row => row.status === 'pending');
const partial = completed.filter(row => row.kind === 'partial');
const final = completed.filter(row => row.kind === 'final');
const deterioration = completed.map(row => row.quote_deterioration_pct).filter(Number.isFinite);
const latency = completed.map(row => row.measured_latency_ms).filter(Number.isFinite);
const fees = completed.map(row => row.fee_sol).filter(Number.isFinite);
const degraded = completed.filter(row => String(row.quality || '').startsWith('degraded'));

console.log(`Research Exit Simulator V3 — ${requested}`);
console.log('');
console.log(`settlements: ${rows.length}`);
console.log(`completed:   ${completed.length}`);
console.log(`pending:     ${pending.length}`);
console.log(`partial:     ${partial.length}`);
console.log(`final:       ${final.length}`);
console.log(`degraded:    ${degraded.length}`);
console.log('');
console.log(`quote deterioration p50: ${fmt(percentile(deterioration, 0.50), 3, '%')}`);
console.log(`quote deterioration p95: ${fmt(percentile(deterioration, 0.95), 3, '%')}`);
console.log(`quote→fill latency p50:   ${fmt(percentile(latency, 0.50), 0, 'ms')}`);
console.log(`quote→fill latency p95:   ${fmt(percentile(latency, 0.95), 0, 'ms')}`);
console.log(`exit fee p50:             ${fmt(percentile(fees, 0.50), 8, ' SOL')}`);
console.log(`exit fee p95:             ${fmt(percentile(fees, 0.95), 8, ' SOL')}`);

if (pending.length) {
  console.log('');
  console.log('Pending settlement blockers:');
  for (const row of pending.slice(0, 10)) {
    console.log(`- #${row.id} position=${row.position_id} kind=${row.kind} attempts=${row.attempt_count} error=${row.last_error || 'awaiting retry'}`);
  }
}
