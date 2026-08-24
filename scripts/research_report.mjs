import { db, initDb } from '../src/db/connection.js';
import { ensureResearchSchema } from '../src/research/schema.js';
import { captureEfficiency } from '../src/research/rr.js';

initDb();
ensureResearchSchema();

function avg(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function rounded(value, digits = 4) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
}

const rows = db.prepare(`
  SELECT id, mint, symbol, opened_at_ms, closed_at_ms, pnl_percent, pnl_sol,
         initial_risk_sol, planned_rr, realized_r, mfe_r, mae_r,
         time_to_mfe_ms, time_to_mae_ms, research_data_quality,
         sim_notional_sol, real_capital_sol, exit_reason,
         entry_latency_ms, entry_quote_deterioration_pct, entry_roundtrip_spread_pct,
         entry_size_impact_pct, entry_fee_sol, entry_priority_fee_sol, entry_jito_tip_sol,
         modeled_exit_fee_sol, modeled_net_pnl_sol, modeled_net_pnl_percent
  FROM dry_run_positions
  WHERE execution_mode = 'research' AND status = 'closed'
  ORDER BY id ASC
`).all();

const realized = rows.map(row => Number(row.realized_r)).filter(Number.isFinite);
const winners = realized.filter(value => value > 0);
const losers = realized.filter(value => value <= 0);
const grossWinR = winners.reduce((sum, value) => sum + value, 0);
const grossLossR = Math.abs(losers.reduce((sum, value) => sum + value, 0));
const capture = rows
  .map(row => captureEfficiency(row.realized_r, row.mfe_r))
  .filter(Number.isFinite);

const report = {
  simulator: 'zero_capital_execution_cost_v2',
  closedTrades: rows.length,
  realCapitalUsedSol: 0,
  winRate: rows.length ? winners.length / rows.length : null,
  expectancyR: avg(realized),
  medianR: median(realized),
  averageWinnerR: avg(winners),
  averageLoserR: avg(losers),
  profitFactorR: grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? Infinity : null),
  medianMfeR: median(rows.map(row => row.mfe_r)),
  medianMaeR: median(rows.map(row => row.mae_r)),
  averageCaptureEfficiency: avg(capture),
  medianTimeToMfeMinutes: median(rows.map(row => Number(row.time_to_mfe_ms) / 60000)),
  executionCost: {
    medianQuoteToFillLatencyMs: median(rows.map(row => row.entry_latency_ms)),
    medianQuoteDeteriorationPct: median(rows.map(row => row.entry_quote_deterioration_pct)),
    medianRoundTripExecutableSpreadPct: median(rows.map(row => row.entry_roundtrip_spread_pct)),
    medianSizeImpactPct: median(rows.map(row => row.entry_size_impact_pct)),
    averageEntryFeeSol: avg(rows.map(row => row.entry_fee_sol)),
    averagePriorityFeeSol: avg(rows.map(row => row.entry_priority_fee_sol)),
    averageJitoTipSol: avg(rows.map(row => row.entry_jito_tip_sol)),
    averageModeledExitFeeSol: avg(rows.map(row => row.modeled_exit_fee_sol)),
    averageModeledNetPnlSol: avg(rows.map(row => row.modeled_net_pnl_sol)),
  },
  dataQuality: rows.reduce((acc, row) => {
    const key = row.research_data_quality || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}),
};

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalize(nested)]));
  }
  return typeof value === 'number' && Number.isFinite(value) ? rounded(value) : value;
}

console.log(JSON.stringify(normalize(report), null, 2));
