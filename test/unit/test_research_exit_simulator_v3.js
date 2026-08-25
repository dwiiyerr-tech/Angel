import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import {
  ensureResearchExitSimulatorSchema,
  exitQuoteDeteriorationPct,
  fetchResearchExitExecutionProfile,
  finalResearchExitAccounting,
  partialResearchExitAccounting,
  RESEARCH_EXIT_SIMULATOR_VERSION,
} from '../../src/research/exitSimulator.js';

assert.equal(Number(exitQuoteDeteriorationPct(0.06, 0.057).toFixed(4)), 5);
assert.equal(exitQuoteDeteriorationPct(null, 0.057), null);

const partial = partialResearchExitAccounting({
  baselineRealizedPnlSol: -0.002,
  baselineRealizedFeeSol: 0.00001,
  soldCostSol: 0.01,
  fillOutSol: 0.013,
  exitFeeSol: 0.00002,
});
assert.ok(partial);
assert.equal(Number(partial.legNetPnlSol.toFixed(8)), 0.00298);
assert.equal(Number(partial.realizedPnlSol.toFixed(8)), 0.00098);
assert.equal(Number(partial.realizedFeeSol.toFixed(8)), 0.00003);

const final = finalResearchExitAccounting({
  baselineRealizedPnlSol: 0.003,
  realizedCostSol: 0.01,
  remainingCostSol: 0.04,
  entryFeeSol: 0.00001,
  realizedFeeSol: 0.00002,
  fillOutSol: 0.052,
  exitFeeSol: 0.00003,
});
assert.ok(final);
assert.equal(Number(final.pnlSol.toFixed(8)), 0.01496);
assert.ok(final.pnlPercent > 29.8 && final.pnlPercent < 30);

let quoteCalls = 0;
let sleptMs = null;
const quotes = [
  { outSol: 0.06, outAmount: '60000000' },
  { outSol: 0.057, outAmount: '57000000' },
];
const profile = await fetchResearchExitExecutionProfile({
  mint: 'mint-v3-test',
  rawAmount: '123456789',
  quoteFn: async (_mint, rawAmount) => {
    assert.equal(rawAmount, '123456789');
    return quotes[quoteCalls++];
  },
  feeFn: async side => ({ side, totalFeeSol: 0.00002, quality: 'dynamic' }),
  sleepFn: async ms => { sleptMs = ms; },
});
assert.equal(profile.version, RESEARCH_EXIT_SIMULATOR_VERSION);
assert.equal(profile.signalOutSol, 0.06);
assert.equal(profile.fillOutSol, 0.057);
assert.equal(Number(profile.quoteDeteriorationPct.toFixed(4)), 5);
assert.equal(profile.quality, 'latency_requoted_executable');
assert.ok(Number.isFinite(sleptMs) && sleptMs >= 0);
assert.equal(profile.fees.totalFeeSol, 0.00002);

quoteCalls = 0;
const degraded = await fetchResearchExitExecutionProfile({
  mint: 'mint-v3-degraded',
  rawAmount: '99',
  quoteFn: async () => {
    quoteCalls += 1;
    if (quoteCalls === 1) return { outSol: 0.02, outAmount: '20000000' };
    throw new Error('requote unavailable');
  },
  feeFn: async () => ({ totalFeeSol: 0.00001, quality: 'dynamic' }),
  sleepFn: async () => {},
});
assert.equal(degraded.fillOutSol, 0.02);
assert.equal(degraded.quality, 'degraded_signal_quote_fallback');
assert.match(degraded.fillError, /requote unavailable/);

ensureResearchExitSimulatorSchema();
const columns = db.pragma('table_info(research_exit_settlements)').map(row => row.name);
for (const required of ['trade_id', 'status', 'raw_amount', 'fill_out_sol', 'quote_deterioration_pct', 'fee_sol']) {
  assert.ok(columns.includes(required), `missing research_exit_settlements.${required}`);
}
const indexes = db.pragma('index_list(research_exit_settlements)').map(row => row.name);
assert.ok(indexes.some(name => name.includes('status_retry')));

console.log('[research-exit-v3] latency re-quote, signed PnL, degraded fallback, and durable schema invariants passed');
