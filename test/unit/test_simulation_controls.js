import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectSimulationFailure, resetSimulationTicks, simulationStatusOptions, simulationTickFor, simulateConfirmation } from '../../src/execution/simulation.js';

console.log('[test_simulation_controls] Starting simulation control tests...');

const original = {
  stage: process.env.SIMULATION_RPC_FAILURE_STAGE,
  rate: process.env.SIMULATION_RPC_FAILURE_RATE,
  status: process.env.SIMULATION_CONFIRMATION_STATUS,
  delay: process.env.SIMULATION_CONFIRMATION_DELAY_MS,
  tickFile: process.env.SIMULATION_TICK_FILE,
  speed: process.env.SIMULATION_REPLAY_SPEED,
};

const restore = () => {
  for (const [key, value] of Object.entries({
    SIMULATION_RPC_FAILURE_STAGE: original.stage,
    SIMULATION_RPC_FAILURE_RATE: original.rate,
    SIMULATION_CONFIRMATION_STATUS: original.status,
    SIMULATION_CONFIRMATION_DELAY_MS: original.delay,
    SIMULATION_TICK_FILE: original.tickFile,
    SIMULATION_REPLAY_SPEED: original.speed,
  })) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  resetSimulationTicks();
};

try {
  delete process.env.SIMULATION_RPC_FAILURE_STAGE;
  delete process.env.SIMULATION_RPC_FAILURE_RATE;
  assert.doesNotThrow(() => injectSimulationFailure('rpc'));

  process.env.SIMULATION_RPC_FAILURE_STAGE = 'rpc';
  assert.throws(() => injectSimulationFailure('rpc'), /Injected simulation failure/);
  assert.doesNotThrow(() => injectSimulationFailure('order'));

  delete process.env.SIMULATION_RPC_FAILURE_STAGE;
  process.env.SIMULATION_CONFIRMATION_STATUS = 'confirmed';
  const confirmed = await simulateConfirmation({ signature: null });
  assert.deepEqual(confirmed.lifecycle, ['built', 'signed', 'rpc_simulated', 'confirmed']);
  assert.equal(confirmed.broadcast, false);

  process.env.SIMULATION_CONFIRMATION_STATUS = 'timeout';
  await assert.rejects(() => simulateConfirmation(), error => error.simulationOutcomeUnknown === true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'angel-sim-'));
  const file = path.join(dir, 'ticks.jsonl');
  const mint = 'SimulationTickMint';
  fs.writeFileSync(file, [
    JSON.stringify({ mint, at_ms: 1000, price_usd: 1, mcap_usd: 1000 }),
    JSON.stringify({ mint, at_ms: 2000, price_usd: 0.8, mcap_usd: 800 }),
  ].join('\n'));
  process.env.SIMULATION_TICK_FILE = file;
  process.env.SIMULATION_REPLAY_SPEED = '0';
  resetSimulationTicks();
  assert.equal(simulationTickFor(mint)?.mcapUsd, 1000);
  assert.equal(simulationStatusOptions().tickFile, file);
  process.env.SIMULATION_REPLAY_SPEED = '1';
  resetSimulationTicks();
  const replayStart = Date.now();
  assert.equal(simulationTickFor(mint, replayStart)?.mcapUsd, 1000);
  assert.equal(simulationTickFor(mint, replayStart + 1000)?.mcapUsd, 800);
  fs.rmSync(dir, { recursive: true, force: true });
} finally {
  restore();
}

console.log('[test_simulation_controls] SUCCESS: fault injection, confirmation lifecycle, and replay ticks verified.');
