import assert from 'node:assert/strict';
import fs from 'node:fs';

const positions = fs.readFileSync(new URL('../../src/db/positions.js', import.meta.url), 'utf8');
const router = fs.readFileSync(new URL('../../src/execution/router.js', import.meta.url), 'utf8');
const executor = fs.readFileSync(new URL('../../src/liveExecutor.js', import.meta.url), 'utf8');
const memory = fs.readFileSync(new URL('../../src/pipeline/tradeMemory.js', import.meta.url), 'utf8');
const summary = fs.readFileSync(new URL('../../src/learning/summary.js', import.meta.url), 'utf8');
const calibration = fs.readFileSync(new URL('../../src/pipeline/llmCalibrator.js', import.meta.url), 'utf8');
const evaluation = fs.readFileSync(new URL('../../src/learning/evaluation.js', import.meta.url), 'utf8');
const simulator = fs.readFileSync(new URL('../../src/learning/simulatorVersion.js', import.meta.url), 'utf8');

assert.match(positions, /mode === 'dry_run' \|\| mode === 'simulation'/);
assert.match(positions, /return 'shadow_live'/);
assert.match(router, /tradingMode\(\) === 'shadow_live'/);
assert.match(router, /assertContractSafetyForMoneyMode/);
assert.match(router, /assertLiveRiskBudget/);
assert.match(router, /simulateJupiterSwap/);
assert.match(router, /fallback mark is disabled/);
assert.match(router, /broadcast: false/);

const simulateOnly = executor.match(/export async function simulateJupiterSwap[\s\S]*?\n}\n\nexport async function executeJupiterSwap/)?.[0] || '';
assert.match(simulateOnly, /simulateAndValidateTransaction/);
assert.match(simulateOnly, /broadcast: false/);
assert.doesNotMatch(simulateOnly, /jupiterExecute\(/);
assert.doesNotMatch(simulateOnly, /jitoSendTransaction\(/);

for (const source of [memory, summary, calibration, evaluation]) {
  assert.match(source, /execution_mode = 'shadow_live'/);
  assert.match(source, /shadowLiveCompatible/);
  assert.match(source, /position_sized/);
}
assert.match(simulator, /MAX_ENTRY_QUOTE_FALLBACK_RATE = 0/);

console.log('simulation/shadow-live parity, no-broadcast, and learning hygiene invariants passed');