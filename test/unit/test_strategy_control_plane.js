import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { setSetting, setting } from '../../src/db/settings.js';
import { deterministicStrategyAnalysis } from '../../src/controlPlane/analyst.js';
import {
  evaluateChallengerRows,
  evaluateEntryPolicy,
} from '../../src/controlPlane/challenger.js';
import {
  activeConfigVersion,
  approveProposalForTest,
  bootstrapConfigRegistry,
  configVersionByNumber,
  createStrategyProposal,
  promoteProposal,
  rollbackToParent,
  validateProposalChanges,
} from '../../src/controlPlane/registry.js';
import { ensureControlPlaneSchema, resetControlPlaneSchemaForTests } from '../../src/controlPlane/schema.js';

function cleanControlPlane() {
  ensureControlPlaneSchema();
  db.exec(`
    DELETE FROM challenger_observations;
    DELETE FROM config_events;
    DELETE FROM strategy_review_runs;
    DELETE FROM strategy_proposals;
    DELETE FROM config_versions;
  `);
}

cleanControlPlane();
resetControlPlaneSchemaForTests();
ensureControlPlaneSchema();

const originalMode = setting('trading_mode', 'dry_run');
setSetting('trading_mode', 'research');

const parent = bootstrapConfigRegistry('unit_test');
assert.equal(parent.version, 1);
assert.equal(parent.status, 'active');
assert.throws(
  () => validateProposalChanges([{ key: 'risk_per_trade_sol', value: 0.5 }]),
  /Protected or unsupported/,
  'Strategy Analyst must never propose Safety/Risk authority keys',
);

const currentConfidence = Number(parent.config.settings.llm_min_confidence || 65);
const nextConfidence = currentConfidence >= 85 ? currentConfidence - 5 : currentConfidence + 5;
const evidence = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  totalClosed: 60,
  proposalEligible: true,
  research: { closed: 60, winRate: 0.55, expectancyR: 0.3, byRoute: [] },
};
const created = createStrategyProposal({
  changes: [{ key: 'llm_min_confidence', value: nextConfidence, rationale: 'unit test' }],
  evidence,
  analysis: { rationale: 'unit test' },
  source: 'unit_test',
  analystMode: 'deterministic',
  actor: 'unit_test',
});
assert.equal(created.proposedVersion, 2);
const child = configVersionByNumber(2);
assert.equal(child.parent_version, 1);
assert.notEqual(child.config_hash, parent.config_hash);
assert.throws(
  () => db.prepare("UPDATE config_versions SET config_json = '{}' WHERE version = 2").run(),
  /immutable/,
  'Config payload must be immutable at SQLite level',
);
assert.throws(
  () => db.prepare("UPDATE config_versions SET evidence_json = '{}' WHERE version = 2").run(),
  /immutable/,
  'Evidence used to create a config version must also be immutable',
);

const testing = approveProposalForTest(created.proposalId, 'unit_test');
assert.equal(testing.status, 'testing');
assert.ok(Number(testing.test_until_ms) > Date.now());

const candidate = {
  signals: { route: 'pumpportal_graduated' },
  filters: { sourceWeight: 0.8 },
};
const activePolicy = evaluateEntryPolicy(candidate, { verdict: 'BUY', confidence: currentConfidence + 1 }, parent.config);
const challengerPolicy = evaluateEntryPolicy(candidate, { verdict: 'BUY', confidence: currentConfidence + 1 }, child.config);
if (nextConfidence > currentConfidence) {
  assert.equal(activePolicy.eligible, true);
  assert.equal(challengerPolicy.eligible, false);
}

const rows = [];
for (let i = 0; i < 40; i += 1) {
  rows.push({
    active_eligible: 1,
    challenger_eligible: i < 30 ? 1 : 0,
    realized_r: i < 22 ? 1 : -1,
  });
}
const evaluation = evaluateChallengerRows(rows, {
  minSample: 20,
  minAgeMs: 0,
  startedAtMs: 0,
  nowMs: 1,
  minimumExpectancyDeltaR: 0.05,
});
assert.equal(evaluation.enoughSample, true);
assert.equal(evaluation.performancePass, true);
assert.equal(evaluation.promotionReady, true);
assert.ok(evaluation.challenger.expectancyR > evaluation.active.expectancyR);

db.prepare("UPDATE strategy_proposals SET status = 'promotion_ready' WHERE id = ?").run(created.proposalId);
db.prepare("UPDATE config_versions SET status = 'promotion_ready' WHERE version = ?").run(created.proposedVersion);
const promoted = promoteProposal(created.proposalId, 'unit_test');
assert.equal(promoted.version, 2);
assert.equal(Number(setting('llm_min_confidence')), nextConfidence);

const restored = rollbackToParent(1, 'unit test rollback', 'unit_test');
assert.equal(restored.version, 1);
assert.equal(Number(setting('llm_min_confidence')), currentConfidence);
assert.equal(activeConfigVersion().version, 1);

const analyst = deterministicStrategyAnalysis({
  proposalEligible: true,
  totalClosed: 60,
  minimumProposalTrades: 50,
  research: {
    closed: 60,
    expectancyR: -0.35,
    winRate: 0.30,
    byRoute: [{ route: 'pumpportal_graduated', count: 25, expectancyR: -0.5, winRate: 0.25 }],
  },
}, parent);
assert.equal(analyst.decision, 'PROPOSE');
assert.ok(analyst.changes.length > 0);
assert.ok(analyst.changes.every(change => ['llm_min_confidence', 'blocked_routes', 'min_opportunity_size_multiplier'].includes(change.key)));

cleanControlPlane();
setSetting('trading_mode', originalMode);
console.log('[strategy-control-plane] immutable config, human gate, challenger, promotion and rollback verified');
