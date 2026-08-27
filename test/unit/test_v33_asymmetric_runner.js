import assert from 'node:assert/strict';
import { db, initDb } from '../../src/db/connection.js';
import {
  estimateSurvivalProbabilityFromRecords,
  survivalLabelFromPath,
} from '../../src/edge/survivalModel.js';
import { evaluateEdgeAdmission } from '../../src/edge/edgeAssessment.js';
import { evaluateRunnerLifecycle, marketFlowSnapshot } from '../../src/execution/runnerLifecycle.js';
import { createResearchPosition } from '../../src/research/engine.js';
import { maybeScaleResearchProbe } from '../../src/research/probeScale.js';
import { buildDomainEvidence } from '../../src/edge/domainEvidence.js';
import { mergeCandidateEvidence } from '../../src/pipeline/signalEvidence.js';
import { isRouteBlocked } from '../../src/pipeline/routePolicy.js';
import { decideDeterministicBatch, effectivePositionSizeSol } from '../../src/pipeline/deterministicDecision.js';
import { pathLabelsFromObservations } from '../../src/learning/pathLabels.js';
import { compareReplayPolicies } from '../../src/learning/counterfactualReplay.js';

initDb();

const openedAtMs = 1_000_000;
assert.equal(survivalLabelFromPath({
  openedAtMs,
  closedAtMs: openedAtMs + 180_000,
  realizedR: 2,
  observations: [
    { atMs: openedAtMs + 30_000, r: -0.2 },
    { atMs: openedAtMs + 120_000, r: 0.4 },
  ],
}).survived, true);
assert.equal(survivalLabelFromPath({
  openedAtMs,
  closedAtMs: openedAtMs + 60_000,
  realizedR: -0.4,
  observations: [{ atMs: openedAtMs + 45_000, r: -0.4 }],
}).label, 'early_failed_thesis');
assert.equal(survivalLabelFromPath({
  openedAtMs,
  closedAtMs: openedAtMs + 180_000,
  realizedR: -1,
  observations: [{ atMs: openedAtMs + 50_000, r: -1.1 }],
}).label, 'early_failure');

const survivalRecords = [];
for (let i = 0; i < 40; i += 1) {
  survivalRecords.push({
    survived: i < 34,
    features: { route: 'pumpportal_graduated', quality: 'high', liquidity: 'deep', holders: 'broad', flow: 'strong' },
  });
}
for (let i = 0; i < 40; i += 1) {
  survivalRecords.push({
    survived: i < 10,
    features: { route: 'trending', quality: 'low', liquidity: 'thin', holders: 'early', flow: 'weak' },
  });
}
const survival = estimateSurvivalProbabilityFromRecords(survivalRecords, {
  route: 'pumpportal_graduated',
  buckets: { quality: 'high', liquidity: 'deep', holders: 'broad', flow: 'strong' },
}, { minSample: 30, priorStrength: 16 });
assert.equal(survival.decisionEligible, true);
assert.ok(survival.probability > 0.60);

const goodAdmission = evaluateEdgeAdmission({
  quality: { score: 80 },
  survival: { probability: 0.80, decisionEligible: true, quality: 'HIGH' },
  runner: { probability: 0.70, decisionEligible: true, quality: 'HIGH' },
  route: { expectedR: 0.90, decisionEligible: true, quality: 'HIGH' },
});
assert.equal(goodAdmission.action, 'GOOD');
assert.equal(goodAdmission.recommendedSizeFraction, 1);
assert.equal(evaluateEdgeAdmission({
  quality: { score: 80 },
  survival: { probability: 0.40, decisionEligible: true },
  runner: { probability: 0.70, decisionEligible: true },
  route: { expectedR: 0.90, decisionEligible: true },
}).action, 'REJECT');

const evidenceCandidate = {
  metrics: { liquidityUsd: 25_000, holderCount: 900 },
  jupiterAsset: {
    audit: { botHoldersPercentage: 12, topHoldersPercentage: 18, devBalancePercentage: 3, devMigrations: 1 },
    stats1h: { priceChange: 20 },
    stats5m: { numNetBuyers: 45, numTraders: 100, numBuys: 70, numSells: 30 },
  },
  trending: { bundler_rate: 0.05, organic_score: 80, smart_degen_count: 5 },
  volumeAcceleration: { volumeAcceleration: 2, buyerAcceleration: 2 },
  savedWalletExposure: { holderCount: 3 },
};
const domains = buildDomainEvidence(evidenceCandidate);
assert.equal(domains.confirmation, 'CONFIRMED');
assert.ok(domains.coreStrongCount >= 2);

const mergedEvidence = mergeCandidateEvidence({
  token: { mint: 'MergeMint' }, signals: { route: 'trending' }, metrics: { liquidityUsd: 10_000 },
}, {
  token: { mint: 'MergeMint' }, signals: { route: 'fee_trending' }, metrics: { holderCount: 500 },
});
assert.equal(mergedEvidence.signals.route, 'dual_source');
assert.deepEqual(new Set(mergedEvidence.signals.routes), new Set(['trending', 'fee_trending']));
assert.equal(isRouteBlocked(mergedEvidence, new Set(['trending'])), false, 'an unblocked independent route keeps dual-source evidence eligible');
assert.equal(isRouteBlocked('fee_trending', new Set(['trending'])), false, 'route blocking must use exact membership');

const deterministicCandidate = {
  token: { mint: 'DeterministicMint' },
  signals: { route: 'pumpportal_graduated', routes: ['pumpportal_graduated'], sourceCount: 1 },
  filters: { passed: true, softScore: 80 }, contractSafety: { passed: true }, domainEvidence: domains,
  edge: {
    quality: { score: 80 }, survival: { probability: 0.8 }, runner: { probability: 0.7 },
    route: { expectedR: 0.9 }, combined: { opportunityProbability: 0.72 },
    admission: goodAdmission,
  },
};
const deterministic = decideDeterministicBatch([{ id: 77, candidate: deterministicCandidate }], 77);
assert.equal(deterministic.verdict, 'BUY');
assert.equal(deterministic.authority, 'deterministic_edge_v1');
assert.equal(effectivePositionSizeSol({ position_size_sol: 0.1 }, {
  verdict: 'BUY', confidence: 90, recommended_size_fraction: 0.25,
}), 0.025, 'Edge size fraction must cap confidence-based size before Risk penalties');

const pathLabels = pathLabelsFromObservations([
  { atMs: openedAtMs + 10_000, r: -0.2 },
  { atMs: openedAtMs + 20_000, r: 1 },
  { atMs: openedAtMs + 30_000, r: 3.2 },
  { atMs: openedAtMs + 40_000, r: 2 },
], { openedAtMs });
assert.equal(pathLabels.runnerClass, 'runner_3r');
assert.equal(pathLabels.levels['3R'].beforeFailure, true);
const replay = compareReplayPolicies([
  { atMs: 1, r: 0 }, { atMs: 2, r: 1.2 }, { atMs: 3, r: 0.4 }, { atMs: 4, r: 3 },
]);
assert.ok(replay.v33.exitR > replay.v32.exitR, 'v33 runner policy should retain more path optionality in this path');

const strongFlow = marketFlowSnapshot({
  liquidity: 10_000,
  stats5m: { numNetBuyers: 30, numTraders: 100, numBuys: 65, numSells: 35 },
}, { entryLiquidityUsd: 10_000 });
assert.equal(evaluateRunnerLifecycle({
  persistedState: 'PROBE', ageMs: 45_000, pnlPercent: 6, peakPnl: 6, flow: strongFlow,
}).action, 'SCALE');
assert.equal(evaluateRunnerLifecycle({
  persistedState: 'PROBE', ageMs: 5_000, pnlPercent: -30, peakPnl: 0, flow: strongFlow,
}).reason, 'catastrophic_invalidation', 'catastrophic protection must remain active inside grace');
assert.equal(evaluateRunnerLifecycle({
  persistedState: 'RUNNER', ageMs: 300_000, pnlPercent: 70, peakPnl: 120,
  flow: { buyerRatio: 0.3, liquidityRetention: 1 },
}).state, 'MOON');
assert.ok(evaluateRunnerLifecycle({
  persistedState: 'RUNNER', ageMs: 300_000, pnlPercent: 70, peakPnl: 120,
  flow: { buyerRatio: 0.3, liquidityRetention: 1 },
}).trailAdjustmentPercent > 0, 'healthy moon runner needs more room');

const mint = `V33Probe${Date.now()}111111111111111111111111111`;
const created = createResearchPosition(933001, {
  token: { mint, symbol: 'V33' },
  signals: { route: 'pumpportal_graduated' },
  metrics: { priceUsd: 0.001, marketCapUsd: 20_000, liquidityUsd: 10_000 },
  jupiterAsset: { decimals: 6 },
  filters: { preScore: 80, momentumScore: 0.8 },
  edge: { admission: goodAdmission },
}, {
  id: 933001,
  confidence: 80,
  suggested_tp_percent: 60,
  suggested_sl_percent: -15,
}, {
  referenceNotional: 0.01,
  targetNotionalSol: 0.05,
  primary: {
    outputAmountRaw: '10000000', tokenAmount: 10,
    effectivePriceUsd: 0.001, effectiveMcapUsd: 20_000,
  },
  quotes: [],
  executionProfile: null,
});
assert.equal(created.isNew, true);
const persisted = db.prepare('SELECT position_stage, size_sol, target_size_sol, scale_count FROM dry_run_positions WHERE id = ?').get(created.id);
assert.equal(persisted.position_stage, 'PROBE');
assert.equal(persisted.size_sol, 0.01);
assert.equal(persisted.target_size_sol, 0.05);
assert.equal(persisted.scale_count, 0);
db.prepare('UPDATE dry_run_positions SET opened_at_ms = ? WHERE id = ?').run(Date.now() - 45_000, created.id);
const probePosition = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(created.id);
const scaled = await maybeScaleResearchProbe(probePosition, {
  assetFn: async () => ({
    decimals: 6, mcap: 21_200, liquidity: 10_000, usdPrice: 0.00106,
    stats5m: { numNetBuyers: 30, numTraders: 100, numBuys: 65, numSells: 35 },
  }),
  quoteFn: async () => ({
    outputAmountRaw: '40000000', tokenAmount: 40,
    effectivePriceUsd: 0.00106, effectiveMcapUsd: 21_200,
  }),
});
assert.equal(scaled.scaled, true);
const confirmed = db.prepare('SELECT position_stage, size_sol, target_size_sol, scale_count, token_amount_raw FROM dry_run_positions WHERE id = ?').get(created.id);
assert.equal(confirmed.position_stage, 'CONFIRMED');
assert.equal(Number(confirmed.size_sol.toFixed(8)), 0.05);
assert.equal(confirmed.scale_count, 1);
assert.equal(confirmed.token_amount_raw, '50000000');
assert.equal(db.prepare("SELECT count(*) AS count FROM dry_run_trades WHERE position_id = ? AND reason = 'PROBE_SCALE_CONFIRMED'").get(created.id).count, 1);
db.prepare('DELETE FROM dry_run_positions WHERE id = ?').run(created.id);

console.log('[v33-asymmetric-runner] survival, admission, lifecycle, and probe persistence verified');
