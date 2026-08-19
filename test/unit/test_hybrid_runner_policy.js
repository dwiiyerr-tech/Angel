import assert from 'node:assert/strict';
import { evaluateHybridAdmission, evaluateKaiserComplements, filterCandidate } from '../../src/pipeline/candidateBuilder.js';
import { relativeTrailPercent, shouldExitTrailing, settleWithin } from '../../src/execution/positions.js';
import { positionSizeBreakdown } from '../../src/db/positions.js';
import { validateTuningProposal } from '../../src/learning/autoApply.js';
import { calculateVolumeAcceleration } from '../../src/pipeline/volumeAcceleration.js';

const runner = {
  token: { mint: 'HybridRunner11111111111111111111111111111' },
  metrics: { marketCapUsd: 50000, liquidityUsd: 12000, holderCount: 220 },
  signals: { route: 'trending' },
  trending: { rug_ratio: 0.1, bundler_rate: 0.1, swaps: 50 },
  jupiterAsset: {
    stats1h: { priceChange: 8 },
    stats5m: { numNetBuyers: 30, numTraders: 100, numBuys: 60, numSells: 40 },
    audit: { botHoldersPercentage: 5, devMigrations: 1 },
  },
  holders: { top20Percent: 20, maxHolderPercent: 5 },
  savedWalletExposure: { holderCount: 0 },
};

const admission = evaluateHybridAdmission(runner, 10, 35, false);
assert.equal(admission.passed, true, 'Kaiser runner pattern should rescue a low generic score');
assert.equal(admission.patterns.kaiserRunner, true);
assert.equal(admission.patterns.angelQuality, false);
assert.equal(admission.sizeMultiplier, 0.5, 'single-pattern rescue must use reduced risk size');

const acceleration = calculateVolumeAcceleration(
  { observedAtMs: 120000, volume5m: 3000, buys5m: 30, sells5m: 10 },
  { observedAtMs: 60000, volume5m: 1000, buys5m: 10, sells5m: 8 },
);
assert.equal(acceleration.valid, true);
assert.equal(acceleration.volumeAcceleration, 3);
assert.equal(acceleration.buyerAcceleration, 3);
assert.equal(acceleration.accelerating, true);
assert.equal(calculateVolumeAcceleration(
  { observedAtMs: 61000, volume5m: 3000, buys5m: 30 },
  { observedAtMs: 60000, volume5m: 1000, buys5m: 10 },
).valid, false, 'near-simultaneous API calls must not create fake acceleration');

const acceleratingRunner = JSON.parse(JSON.stringify(runner));
acceleratingRunner.volumeAcceleration = acceleration;
const accelerationAdmission = evaluateHybridAdmission(acceleratingRunner, 10, 35, false);
assert.equal(accelerationAdmission.patterns.acceleratingRunner, true);
assert.equal(accelerationAdmission.sizeMultiplier, 0.75, 'confirmed acceleration should raise runner size without using full size');

const thinLiquidity = JSON.parse(JSON.stringify(runner));
thinLiquidity.metrics.liquidityUsd = 6000;
thinLiquidity.metrics.marketCapUsd = 20000;
thinLiquidity.signals.route = 'trenches_completed';
const complements = evaluateKaiserComplements(thinLiquidity);
assert.equal(complements.liquidityBand, 'thin');
assert.equal(complements.liquidityMultiplier, 0.6);
assert.equal(complements.routeMcapMultiplier, 0.85);
assert.equal(complements.strictFlowPassed, true);
assert.equal(complements.mcapSweetSpot, true);

const adequateLiquidity = JSON.parse(JSON.stringify(runner));
adequateLiquidity.metrics.liquidityUsd = 8500;
assert.equal(evaluateKaiserComplements(adequateLiquidity).liquidityMultiplier, 0.8);
assert.equal(evaluateKaiserComplements(runner).liquidityMultiplier, 1);

const unsafe = JSON.parse(JSON.stringify(runner));
unsafe.metrics.liquidityUsd = 1000;
const unsafeResult = filterCandidate(unsafe);
assert.equal(unsafeResult.passed, false, 'hybrid admission must never bypass liquidity safety');
assert.equal(unsafeResult.hardPassed, false);

const repeatedRisk = JSON.parse(JSON.stringify(runner));
repeatedRisk.jupiterAsset.audit.botHoldersPercentage = 30;
repeatedRisk.jupiterAsset.audit.devMigrations = 25;
filterCandidate(repeatedRisk);
filterCandidate(repeatedRisk);
assert.equal(repeatedRisk.riskFlags.filter(flag => flag.type === 'bot_holder_risk').length, 1);
assert.equal(repeatedRisk.riskFlags.filter(flag => flag.type === 'serial_dev_risk').length, 1,
  'execution refresh must not compound derived risk flags');

const sizing = positionSizeBreakdown(
  { riskFlags: [{ type: 'risk', severity: 4 }], filters: { sourceWeight: 0.01 } },
  { verdict: 'BUY', confidence: 50 },
  { position_size_sol: 0.005 },
  14,
);
assert.equal(sizing.executable, false);
assert.equal(sizing.finalSizeSol, 0, 'dust positions must be rejected instead of submitted');
assert.equal(sizing.regimeMultiplier, 1, 'unapproved regime learning must not alter money sizing');
const runnerSizing = positionSizeBreakdown(
  { riskFlags: [], filters: { sourceWeight: 0.01 } },
  { verdict: 'BUY', confidence: 50 },
  { position_size_sol: 0.05 },
  8,
);
assert.equal(runnerSizing.sourceWeight, 0.35, 'correlated opportunity penalties must share a bounded floor');
assert.equal(runnerSizing.executable, true, 'a safe runner must not disappear due to multiplier stacking');

assert(relativeTrailPercent({ peakPnl: 100 }) > relativeTrailPercent({ peakPnl: 25 }), 'large runners need wider trails');
assert(relativeTrailPercent({ peakPnl: 200, atrPercent: 30 }) <= 30, 'relative trail must stay bounded');
assert(relativeTrailPercent({ peakPnl: 100, ageMinutes: 25 }) < relativeTrailPercent({ peakPnl: 100, ageMinutes: 5 }), 'old positions should tighten');
assert.equal(shouldExitTrailing({
  armed: true, enabled: true, pnlPercent: 1, floorPercent: 3,
  trailDropPercent: -49, trailPercent: 15,
}), true, 'an armed runner that gaps below its floor must exit immediately');
assert.equal(await settleWithin(new Promise(() => {}), 5, null), null,
  'optional GMGN enrichment must not block the fresh-runner execution path');

assert.equal(validateTuningProposal({
  param: 'trailing_percent', currentValue: 20, proposedValue: 21,
  evidence: { candidates: 250, splitHalfPositive: true, runnerRecallPreserved: true },
}).ok, true);
assert.equal(validateTuningProposal({
  param: 'trailing_percent', currentValue: 20, proposedValue: 30,
  evidence: { candidates: 250, splitHalfPositive: true, runnerRecallPreserved: true },
}).ok, false, 'tuning jumps above 10% must be rejected');
assert.equal(validateTuningProposal({
  param: 'min_liquidity_usd', currentValue: 5000, proposedValue: 4500,
  evidence: { candidates: 500, splitHalfPositive: true, runnerRecallPreserved: true },
}).reason, 'safety_parameter_locked');

console.log('[test_hybrid_runner_policy] hybrid admission, relative trail, and strict tuning verified');
process.exit(0);
