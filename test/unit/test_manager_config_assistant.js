import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { setting, setSetting } from '../../src/db/settings.js';
import {
  bootstrapConfigRegistry,
  rejectProposal,
  validateProposalChanges,
} from '../../src/controlPlane/registry.js';
import { evaluateEntryPolicy } from '../../src/controlPlane/challenger.js';
import { ensureControlPlaneSchema, resetControlPlaneSchemaForTests } from '../../src/controlPlane/schema.js';
import {
  createOwnerConfigProposal,
  parseExplicitConfigInstruction,
} from '../../src/manager/configAssistant.js';

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
setSetting('trading_mode', 'paper');
const active = bootstrapConfigRegistry('manager_config_test');

const command = parseExplicitConfigInstruction('/configset confidence 70');
assert.equal(command.key, 'llm_min_confidence');
assert.equal(command.value, 70);

const natural = parseExplicitConfigInstruction('Angel set liquidity 7.5k');
assert.equal(natural.key, 'min_liquidity_usd');
assert.equal(natural.value, 7500);

assert.equal(
  parseExplicitConfigInstruction('bagaimana kalau confidence 70?'),
  null,
  'Brainstorming must not be interpreted as an owner mutation command',
);

assert.doesNotThrow(() => validateProposalChanges([
  { key: 'min_liquidity_usd', value: 8000 },
  { key: 'flow_hard_price_change_pct', value: -8 },
]));
assert.throws(
  () => validateProposalChanges([{ key: 'risk_per_trade_sol', value: 0.5 }]),
  /Protected or unsupported/,
);
assert.throws(
  () => validateProposalChanges([{ key: 'filter_extreme_bot_holders_pct', value: 80 }]),
  /Protected or unsupported/,
  'Non-versioned filter knobs must not be exposed through Manager yet',
);
assert.throws(
  () => validateProposalChanges([{ key: 'min_liquidity_usd', value: 500 }]),
  /within \[1000, 100000\]/,
);

const baseConfig = {
  settings: {
    llm_min_confidence: '65',
    blocked_routes: '[]',
    min_opportunity_size_multiplier: '0.35',
    min_liquidity_usd: '5000',
    flow_hard_price_change_pct: '-10',
    flow_hard_net_buyer_ratio: '0',
  },
};
const candidate = {
  signals: { route: 'trenches_completed' },
  metrics: { liquidityUsd: 6000 },
  filters: { sourceWeight: 0.8 },
  flowAssessment: { priceChange1h: -5, netBuyerRatio: 0.1 },
};
const decision = { verdict: 'BUY', confidence: 72 };

const baseResult = evaluateEntryPolicy(candidate, decision, baseConfig);
assert.equal(baseResult.eligible, true);

const liquidityChallenger = evaluateEntryPolicy(candidate, decision, {
  settings: { ...baseConfig.settings, min_liquidity_usd: '8000' },
});
assert.equal(liquidityChallenger.eligible, false);
assert.equal(liquidityChallenger.reason, 'liquidity_below_floor');

const flowChallenger = evaluateEntryPolicy(candidate, decision, {
  settings: { ...baseConfig.settings, flow_hard_price_change_pct: '-4' },
});
assert.equal(flowChallenger.eligible, false);
assert.equal(flowChallenger.reason, 'flow_severe_dump');

const confidenceBefore = Number(setting('llm_min_confidence', '65'));
const proposedConfidence = confidenceBefore >= 90 ? 85 : Math.max(30, confidenceBefore + 1);
const created = createOwnerConfigProposal({
  text: `/configset confidence ${proposedConfidence}`,
  chatId: 'unit-test-owner',
});
assert.ok(created?.proposal?.proposalId > 0);
assert.equal(Number(setting('llm_min_confidence', '65')), confidenceBefore, 'Proposal creation must not mutate active config');
const proposalRow = db.prepare('SELECT source, analyst_mode, status FROM strategy_proposals WHERE id = ?').get(created.proposal.proposalId);
assert.equal(proposalRow.source, 'manager_owner_command');
assert.equal(proposalRow.analyst_mode, 'owner_explicit');
assert.equal(proposalRow.status, 'pending_review');
rejectProposal(created.proposal.proposalId, 'test cleanup', 'unit_test');

cleanControlPlane();
setSetting('trading_mode', originalMode);
console.log('[manager-config-assistant] explicit owner proposals, no direct mutation, and PAPER filter challenger verified');
