import assert from 'node:assert/strict';
import { validateDryRunRows } from '../../src/learning/dataQuality.js';
import { tuneAdmissionEdge } from '../../src/learning/edgeTuner.js';
import { DRY_RUN_SIMULATOR_VERSION } from '../../src/learning/simulatorVersion.js';
import { buyConfidenceFloor } from '../../src/db/settings.js';

const position = { id: 1, status: 'closed', opened_at_ms: 10, closed_at_ms: 20, pnl_percent: 5, pnl_sol: 0.01, entry_mcap: 10000, size_sol: 0.1, snapshot_json: '{}' };
assert.equal(validateDryRunRows([position], [{ position_id: 1, side: 'BUY' }, { position_id: 1, side: 'sell' }]).valid, true);
assert.equal(validateDryRunRows([{ ...position, closed_at_ms: 5 }], []).issues.closeBeforeOpen, 1);
const versioned = Array.from({ length: 50 }, (_, index) => ({
  ...position,
  id: index + 1,
  snapshot_json: JSON.stringify({ simulatorVersion: DRY_RUN_SIMULATOR_VERSION, entryQuoteMode: 'position_sized', entryQuote: { outputAmountRaw: '1' } }),
}));
const versionedTrades = versioned.flatMap(row => [{ position_id: row.id, side: 'buy' }, { position_id: row.id, side: 'sell' }]);
assert.equal(validateDryRunRows(versioned, versionedTrades, { expectedSimulatorVersion: DRY_RUN_SIMULATOR_VERSION }).learningEligible, true);
const fallbackHeavy = versioned.map((row, index) => index < 11 ? { ...row, snapshot_json: JSON.stringify({ simulatorVersion: DRY_RUN_SIMULATOR_VERSION, entryQuoteMode: 'fallback_mark' }) } : row);
assert.equal(validateDryRunRows(fallbackHeavy, versionedTrades, { expectedSimulatorVersion: DRY_RUN_SIMULATOR_VERSION }).learningEligible, false);
assert.equal(validateDryRunRows(versioned, [], { expectedSimulatorVersion: DRY_RUN_SIMULATOR_VERSION }).issues.missingBuyLedger, 50);
assert.equal(validateDryRunRows([{ ...versioned[0], closed_at_ms: null }], versionedTrades, { expectedSimulatorVersion: DRY_RUN_SIMULATOR_VERSION }).issues.closedWithoutTimestamp, 1);

const records = Array.from({ length: 120 }, (_, index) => ({
  openedAtMs: index,
  pnlSol: index % 2 ? 0.02 : -0.01,
  pnlPercent: index % 2 ? 20 : -10,
  features: { liquidityUsd: index % 2 ? 100 : 1 },
}));
const result = tuneAdmissionEdge(records, { minTrain: 10, minTest: 10 });
assert.equal(result.recommended?.feature, 'liquidityUsd');
assert.equal(result.recommended?.direction, 'min');
assert.equal(result.recommended?.splitHalfPositive, true);
assert(result.recommended?.validationUplift > 0);
assert(result.recommended?.testUplift > 0, 'final chronological holdout must independently confirm the recommendation');
assert(result.validationAt > result.splitAt);

assert.equal(
  buyConfidenceFloor({ min_buy_confidence: 85, llm_min_confidence: 60 }),
  85,
  'strategy BUY floor must be stricter than the legacy LLM floor',
);
assert.equal(
  buyConfidenceFloor({ llm_min_confidence: 60 }),
  60,
  'legacy strategies must still respect the global operator floor',
);

console.log('[test_edge_tuning] data quality and chronological holdout tuning verified');
