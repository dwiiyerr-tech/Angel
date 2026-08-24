import assert from 'node:assert/strict';
import { db, initDb } from '../../src/db/connection.js';
import { createResearchPosition, recordResearchObservation } from '../../src/research/engine.js';
import { ensureResearchSchema, resetResearchSchemaForTests } from '../../src/research/schema.js';

initDb();
resetResearchSchemaForTests();
ensureResearchSchema();

const candidate = {
  token: {
    mint: '11111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Research Test',
  },
  metrics: {
    priceUsd: 0.00001,
    marketCapUsd: 10000,
    liquidityUsd: 20000,
  },
  jupiterAsset: { decimals: 6 },
  filters: {
    passed: true,
    preScore: 75,
    momentumScore: 0.72,
  },
  riskFlags: [],
  signals: {
    route: 'unit_test',
    strategyFamily: 'edge1',
  },
};

const decision = {
  id: null,
  verdict: 'BUY',
  confidence: 80,
  suggested_tp_percent: 60,
  suggested_sl_percent: -15,
  reason: 'unit test',
};

const primaryQuote = {
  inputLamports: 50_000_000,
  outputAmountRaw: '1000000000',
  tokenAmount: 1000,
  solUsd: 150,
  effectivePriceUsd: 0.00001,
  effectiveMcapUsd: 10000,
};

const quoteBundle = {
  referenceNotional: 0.05,
  primary: primaryQuote,
  quotes: [
    { notionalSol: 0.01, quote: { ...primaryQuote, inputLamports: 10_000_000, outputAmountRaw: '200000000', tokenAmount: 200 } },
    { notionalSol: 0.05, quote: primaryQuote },
  ],
};

const created = createResearchPosition(999, candidate, decision, quoteBundle, 'unit_test');
assert.equal(created.isNew, true);
assert.ok(created.id > 0);
assert.equal(created.realCapitalSol, 0);
assert.equal(created.simNotionalSol, 0.05);
assert.equal(created.plannedRr, 4);
assert.ok(created.initialRiskSol > 0);

let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(created.id);
assert.equal(row.execution_mode, 'research');
assert.equal(row.real_capital_sol, 0);
assert.equal(row.sim_notional_sol, 0.05);
assert.equal(row.size_sol, 0.05, 'legacy size_sol must remain virtual accounting notional');
assert.equal(row.token_amount_raw, '1000000000');
assert.equal(row.initial_risk_percent, 15);
assert.equal(row.planned_rr, 4);
assert.equal(row.research_data_quality, 'entry_executable');

// DB-level fail-safe: no future code path may turn a Research record into
// capital-bearing or signed execution state.
assert.throws(
  () => db.prepare('UPDATE dry_run_positions SET real_capital_sol = 0.01 WHERE id = ?').run(created.id),
  /research invariant/,
);
assert.throws(
  () => db.prepare("UPDATE dry_run_positions SET entry_signature = 'fake-signature' WHERE id = ?").run(created.id),
  /research invariant/,
);
row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(created.id);
assert.equal(row.real_capital_sol, 0);
assert.equal(row.entry_signature, null);

const observation = recordResearchObservation(created.id, {
  price: 0.000013,
  mcap: 13000,
  pnl_percent: 30,
  pnl_sol: 0.015,
  pnlPercent: 30,
  pnlSol: 0.015,
});
assert.ok(observation.currentR > 0);
assert.equal(observation.mfePercent, 30);
assert.equal(observation.maePercent, 0);

row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(created.id);
assert.equal(row.mfe_percent, 30);
assert.ok(row.mfe_r > 0);
assert.equal(row.real_capital_sol, 0);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM research_observations WHERE position_id = ?').get(created.id).count, 1);

// Simulate the mature exit engine having closed the virtual position, then make
// sure research bookkeeping derives realized R without ever converting capital
// usage from zero into simulated notional.
db.prepare(`
  UPDATE dry_run_positions
  SET status = 'closed', closed_at_ms = ?, pnl_percent = 45, pnl_sol = 0.0225, exit_reason = 'TP'
  WHERE id = ?
`).run(Date.now(), created.id);

const closedObservation = recordResearchObservation(created.id, {
  price: 0.0000145,
  mcap: 14500,
  pnl_percent: 45,
  pnl_sol: 0.0225,
  pnlPercent: 45,
  pnlSol: 0.0225,
  exitReason: 'TP',
});
assert.ok(closedObservation.realizedR > 0);

row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(created.id);
assert.equal(row.real_capital_sol, 0);
assert.ok(row.realized_r > 0);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM research_observations WHERE position_id = ?').get(created.id).count, 2);

console.log('[research-engine] zero-capital lifecycle and DB invariants passed');
