import assert from 'node:assert/strict';
import {
  percentile,
  priorityFeeSolFromMicroLamportsPerCu,
  quoteDeteriorationPct,
  roundTripExecutableSpreadPct,
  sizeImpactPct,
  expectedFailureFeeOverheadSol,
  applyModeledExitFee,
} from '../../src/research/executionCost.js';

assert.equal(percentile([0, 100, 200, 300], 0.75), 200);
assert.equal(percentile([], 0.75), null);

// 2,500 micro-lamports/CU * 400k CU = 1,000 lamports = 0.000001 SOL.
assert.equal(priorityFeeSolFromMicroLamportsPerCu(2500, 400000), 0.000001);

assert.equal(
  Number(quoteDeteriorationPct({ tokenAmount: 1000 }, { tokenAmount: 980 }).toFixed(4)),
  2,
);
assert.equal(
  Number(roundTripExecutableSpreadPct(0.05, 0.0475).toFixed(4)),
  5,
);
assert.equal(
  Number(sizeImpactPct({ effectivePriceUsd: 1.03 }, { effectivePriceUsd: 1 }).toFixed(4)),
  3,
);
assert.equal(expectedFailureFeeOverheadSol(0.00001, 0.1, 2), 0.000002);

const overlay = applyModeledExitFee({
  result: { pnlSol: 0.01 },
  row: {
    exit_fee_sol: 0.000005,
    sim_notional_sol: 0.05,
    entry_fee_sol: 0.000006,
    realized_fee_sol: 0,
  },
  exitFees: { totalFeeSol: 0.00002 },
});
assert.ok(overlay);
assert.equal(Number(overlay.modeledPnlSol.toFixed(9)), 0.009985);
assert.equal(overlay.modeledExitFeeSol, 0.00002);
assert.ok(overlay.modeledPnlPercent > 19.9 && overlay.modeledPnlPercent < 20);

console.log('[research-execution-cost] execution-cost math invariants passed');
