import { db, initDb } from '../src/db/connection.js';
import { ensureResearchSchema } from '../src/research/schema.js';
import { ensureFastHunterSchema, fastHunterStats, FAST_HUNTER_VERSION } from '../src/research/fastHunter.js';

initDb();
ensureResearchSchema();
ensureFastHunterSchema();

function parseWindow(raw = '24h') {
  const match = String(raw).trim().match(/^(\d+(?:\.\d+)?)(m|h|d)$/i);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Math.max(60_000, value * multiplier);
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function latencySummary(rows, key) {
  const values = rows.map(row => Number(row[key])).filter(Number.isFinite);
  return {
    sample: values.length,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

const windowMs = parseWindow(process.argv[2] || '24h');
const sinceMs = Date.now() - windowMs;
const rows = fastHunterStats({ sinceMs });

const positionRows = db.prepare(`
  SELECT id, status, realized_r, mfe_r, mae_r
  FROM dry_run_positions
  WHERE execution_mode = 'research' AND id IN (
    SELECT position_id FROM fast_hunter_runs
    WHERE position_id IS NOT NULL AND signal_at_ms >= ?
  )
`).all(sinceMs);
const positions = new Map(positionRows.map(row => [Number(row.id), row]));
const closed = positionRows.filter(row => row.status === 'closed' && Number.isFinite(Number(row.realized_r)));
const wins = closed.filter(row => Number(row.realized_r) > 0).length;
const expectancyR = closed.length
  ? closed.reduce((sum, row) => sum + Number(row.realized_r), 0) / closed.length
  : null;

let fullFilterDisagreements = 0;
let llmDisagreements = 0;
let comparableFull = 0;
let comparableLlm = 0;
for (const row of rows) {
  if (row.full_filter_passed != null && row.fast_decision) {
    comparableFull += 1;
    const fullWouldBuy = Boolean(row.full_filter_passed);
    const fastBought = row.fast_decision === 'BUY';
    if (fullWouldBuy !== fastBought) fullFilterDisagreements += 1;
  }
  if (row.llm_verdict && row.fast_decision) {
    comparableLlm += 1;
    const llmWouldBuy = row.llm_verdict === 'BUY';
    const fastBought = row.fast_decision === 'BUY';
    if (llmWouldBuy !== fastBought) llmDisagreements += 1;
  }
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  version: FAST_HUNTER_VERSION,
  windowMs,
  sample: rows.length,
  routes: Object.fromEntries([...new Set(rows.map(row => row.route))].map(route => [
    route,
    rows.filter(row => row.route === route).length,
  ])),
  decisions: {
    buy: rows.filter(row => row.fast_decision === 'BUY').length,
    watch: rows.filter(row => row.fast_decision === 'WATCH').length,
    safetyRejected: rows.filter(row => row.status === 'safety_rejected').length,
  },
  latency: {
    signalToEssential: latencySummary(rows, 'signalToEssentialMs'),
    signalToSafety: latencySummary(rows, 'signalToSafetyMs'),
    signalToMomentum: latencySummary(rows, 'signalToMomentumMs'),
    signalToDecision: latencySummary(rows, 'signalToDecisionMs'),
    signalToEntry: latencySummary(rows, 'signalToEntryMs'),
    signalToLateContext: latencySummary(rows, 'signalToLateContextMs'),
    signalToLlm: latencySummary(rows, 'signalToLlmMs'),
  },
  counterfactual: {
    fullContextComparable: comparableFull,
    fullContextDisagreements: fullFilterDisagreements,
    llmComparable: comparableLlm,
    llmDisagreements,
  },
  outcomes: {
    positions: positionRows.length,
    closed: closed.length,
    wins,
    winRate: closed.length ? wins / closed.length : null,
    expectancyR,
    open: positionRows.filter(row => row.status === 'open').length,
  },
}, null, 2));
