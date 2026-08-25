import assert from 'node:assert/strict';
import { db, initDb } from '../../src/db/connection.js';
import { ensureResearchSchema } from '../../src/research/schema.js';
import { ensureDecisionIntelligenceSchema } from '../../src/decisionIntelligence/schema.js';
import { ensureControlPlaneSchema } from '../../src/controlPlane/schema.js';
import { upsertCandidate } from '../../src/db/candidates.js';
import { logDecisionEvent, storeDecision } from '../../src/db/decisions.js';
import {
  canonicalDecisionVerdict,
  decisionReceiptByDecisionId,
} from '../../src/decisionIntelligence/receipt.js';
import {
  classifyDecisionOutcome,
  processDecisionProbe,
  resetDecisionIntelligenceRuntimeForTests,
} from '../../src/decisionIntelligence/runtime.js';
import { loadDecisionReceiptDetails } from '../../src/decisionIntelligence/report.js';
import { buildManagerEvidence, clearManagerMessages, storeManagerMessage } from '../../src/manager/tools.js';
import { createResearchPosition } from '../../src/research/engine.js';

console.log('[test_decision_intelligence_manager_v1] starting...');
initDb();
ensureResearchSchema();
ensureDecisionIntelligenceSchema();
resetDecisionIntelligenceRuntimeForTests();

db.prepare("UPDATE settings SET value = 'dry_run' WHERE key = 'trading_mode'").run();

const prefix = `DecisionIntel_${Date.now()}`;
function candidate(mint, route = 'pumpportal_graduated') {
  return {
    token: { mint, symbol: prefix.slice(-8) },
    metrics: { priceUsd: 0.00001, marketCapUsd: 50_000, liquidityUsd: 20_000, holderCount: 250 },
    signals: { route, label: route, strategy: 'sniper' },
    contractSafety: { passed: true, reason: 'unit_test_safe' },
    jupiterAsset: { decimals: 6, mcap: 50_000, liquidity: 20_000 },
    holders: { count: 250, top20Percent: 24, maxHolderPercent: 5 },
    filters: { passed: true, strategy: 'sniper', momentumScore: 0.78, momentumPreferred: true },
    edge: {
      quality: { score: 81 },
      runner: { probability: 0.73, sample: 80, decisionEligible: true, quality: 'MEDIUM' },
      route: { pWin: 0.62, expectedR: 0.48, routeSample: 120, decisionEligible: true, quality: 'MEDIUM' },
      combined: { opportunityProbability: 0.6915, evidenceQuality: 'MEDIUM', decisionEligible: true },
    },
    riskFlags: [],
    dataQuality: { jupiterAsset: { available: true }, holders: { available: true } },
    createdAtMs: Date.now(),
  };
}

function decision(verdict = 'WATCH') {
  return {
    verdict,
    confidence: verdict === 'PASS' ? 0 : 72,
    selected_candidate_id: verdict === 'BUY' ? 1 : null,
    selected_mint: verdict === 'BUY' ? 'placeholder' : null,
    reason: `${verdict} unit test`,
    risks: [],
    suggested_tp_percent: 60,
    suggested_sl_percent: -20,
    raw: { verdict },
  };
}

// Batch display WATCH must preserve an underlying LLM PASS in the receipt.
const disguisedPass = {
  ...decision('WATCH'),
  confidence: 0,
  selected_candidate_id: null,
  selected_mint: null,
  raw: { verdict: 'PASS' },
};
assert.equal(canonicalDecisionVerdict(disguisedPass), 'PASS');

const passMint = `${prefix}111111111111111111111111111111111111111`.slice(0, 44);
const passCandidate = candidate(passMint);
const passCandidateId = upsertCandidate(passCandidate, null);
const passDecisionId = storeDecision(passCandidateId, passCandidate, disguisedPass);
const passReceipt = decisionReceiptByDecisionId(passDecisionId);
assert(passReceipt, 'PASS receipt must exist');
assert.equal(passReceipt.verdict, 'PASS');
assert.equal(passReceipt.mode, 'research');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM decision_outcome_observations WHERE receipt_id = ?').get(passReceipt.id).count, 4);
assert.equal(db.prepare('SELECT status FROM decision_execution_probes WHERE receipt_id = ?').get(passReceipt.id).status, 'pending');
assert.throws(
  () => db.prepare("UPDATE decision_receipts SET verdict = 'WATCH' WHERE id = ?").run(passReceipt.id),
  /decision receipt core is immutable/,
  'decision-time receipt core must be immutable',
);

// Fast Hunter WATCH historically existed only in decision_logs. V1 must promote
// the formal WATCH into llm_decisions + a Decision Receipt without changing it.
const watchMint = `${prefix}222222222222222222222222222222222222222`.slice(0, 44);
const watchCandidate = candidate(watchMint, 'pumpfun_pregrad');
const watchCandidateId = upsertCandidate(watchCandidate, null);
const watchDecision = { ...decision('WATCH'), raw: null, fast_hunter: { version: 'research-fast-hunter-v1' } };
logDecisionEvent({
  triggerCandidateId: watchCandidateId,
  rows: [{ id: watchCandidateId, candidate: watchCandidate }],
  decision: watchDecision,
  mode: 'research',
  action: 'research_fast_hunter_watch',
});
const watchStored = db.prepare('SELECT id FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(watchCandidateId);
assert(watchStored, 'Fast Hunter WATCH must become a durable decision');
const watchReceipt = decisionReceiptByDecisionId(watchStored.id);
assert.equal(watchReceipt.verdict, 'WATCH');

// BUY Decision Intelligence must reuse the already-computed paper-trade profile
// rather than requiring another network probe.
const buyMint = `${prefix}333333333333333333333333333333333333333`.slice(0, 44);
const buyCandidate = candidate(buyMint);
const buyCandidateId = upsertCandidate(buyCandidate, null);
const buyDecision = {
  ...decision('BUY'),
  selected_candidate_id: buyCandidateId,
  selected_mint: buyMint,
  raw: { verdict: 'BUY' },
};
const buyDecisionId = storeDecision(buyCandidateId, buyCandidate, buyDecision);
buyDecision.id = buyDecisionId;
const buyReceipt = decisionReceiptByDecisionId(buyDecisionId);
const profile = {
  version: 'execution_cost_v2',
  measuredQuoteToFillLatencyMs: 640,
  quoteDeteriorationPct: 0.22,
  roundTripSpreadPct: 0.91,
  sizeImpactPct: 0.08,
  entryFees: { totalFeeSol: 0.00002 },
  expectedExitFees: { totalFeeSol: 0.00002 },
  fillQuote: { outputAmountRaw: '2500000', effectivePriceUsd: 0.00001, effectiveMcapUsd: 50_000 },
};
const position = createResearchPosition(buyCandidateId, buyCandidate, buyDecision, {
  referenceNotional: 0.05,
  primary: { outputAmountRaw: '2500000', tokenAmount: 2.5, effectivePriceUsd: 0.00001, effectiveMcapUsd: 50_000 },
  quotes: [{ notionalSol: 0.05, quote: { outputAmountRaw: '2500000', effectivePriceUsd: 0.00001 } }],
  executionProfile: profile,
}, 'decision_intelligence_unit_test');
assert.equal(position.isNew, true);
assert.equal(await processDecisionProbe(buyReceipt.id), true);
const buyDetails = loadDecisionReceiptDetails(buyReceipt.id);
assert.equal(buyDetails.probe.status, 'ready');
assert.equal(buyDetails.probe.position_id, position.id);
assert.equal(Number(buyDetails.probe.roundtrip_spread_pct), 0.91);
assert.equal(Number(buyDetails.probe.quote_deterioration_pct), 0.22);

assert.equal(classifyDecisionOutcome('PASS', { finalR: 0.2, sampledMfeR: 3.2 }), 'FALSE_NEGATIVE_RUNNER');
assert.equal(classifyDecisionOutcome('WATCH', { finalR: 1.2, sampledMfeR: 1.4 }), 'WATCH_MISSED_UPSIDE');
assert.equal(classifyDecisionOutcome('BUY', { finalR: -0.4, sampledMfeR: 1.1 }), 'BUY_EXIT_DEPENDENT');

// Manager evidence exposes analytical context but no mutation authority.
// Also verify that manager status names stay aligned with the real Control Plane.
ensureControlPlaneSchema();
const proposalToken = `${Date.now()}_${Math.random()}`;
const proposedVersion = 900000 + Math.floor(Math.random() * 90000);
const proposalInsert = db.prepare(`
  INSERT INTO strategy_proposals (
    created_at_ms, parent_version, proposed_version, status, source, analyst_mode,
    proposal_json, proposal_hash, proposed_config_hash, evidence_json, evidence_hash
  ) VALUES (?, 1, ?, 'pending_review', 'unit_test', 'deterministic', '{}', ?, ?, '{}', ?)
`).run(Date.now(), proposedVersion, `proposal_${proposalToken}`, `config_${proposalToken}`, `evidence_${proposalToken}`);

const managerEvidence = buildManagerEvidence('bagaimana performa 24h terakhir?');
assert.equal(managerEvidence.authority.managerMode, 'read_only');
assert.equal(managerEvidence.authority.canApproveLive, false);
assert.equal(managerEvidence.authority.canEnableLive, false);
assert.equal(managerEvidence.authority.canSignTransactions, false);
assert.equal(managerEvidence.authority.canBroadcastTransactions, false);
assert.equal(managerEvidence.authority.canMutateSettings, false);
assert.equal(managerEvidence.authority.humanOwnerIsSoleLiveAuthority, true);
assert.equal(managerEvidence.controlPlane.openProposal?.id, Number(proposalInsert.lastInsertRowid));
assert.equal(managerEvidence.controlPlane.openProposal?.status, 'pending_review');
assert.equal(managerEvidence.controlPlane.openProposal?.proposed_version, proposedVersion);
db.prepare('DELETE FROM strategy_proposals WHERE id = ?').run(Number(proposalInsert.lastInsertRowid));

storeManagerMessage('unit-chat', 'user', 'hello');
storeManagerMessage('unit-chat', 'assistant', 'read-only hello');
assert.equal(clearManagerMessages('unit-chat'), 2);

// Cleanup only this test's data. Receipt children are not FK-cascaded by design.
const receiptIds = db.prepare('SELECT id FROM decision_receipts WHERE mint LIKE ?').all(`${prefix}%`).map(row => row.id);
for (const id of receiptIds) {
  db.prepare('DELETE FROM decision_outcomes WHERE receipt_id = ?').run(id);
  db.prepare('DELETE FROM decision_outcome_observations WHERE receipt_id = ?').run(id);
  db.prepare('DELETE FROM decision_execution_probes WHERE receipt_id = ?').run(id);
  db.prepare('DELETE FROM decision_receipts WHERE id = ?').run(id);
}
db.prepare('DELETE FROM dry_run_positions WHERE mint LIKE ?').run(`${prefix}%`);
db.prepare('DELETE FROM llm_decisions WHERE mint LIKE ?').run(`${prefix}%`);
db.prepare('DELETE FROM candidates WHERE mint LIKE ?').run(`${prefix}%`);
db.prepare('DELETE FROM decision_cache WHERE mint LIKE ?').run(`${prefix}%`);

console.log('[test_decision_intelligence_manager_v1] SUCCESS');
