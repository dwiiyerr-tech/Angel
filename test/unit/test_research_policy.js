import assert from 'node:assert/strict';
import {
  normalizeConfiguredMode,
  isResearchSimulationMode,
  requiresMoneyGradeEvidence,
  isRealMoneyMode,
  modeCapabilities,
} from '../../src/research/policy.js';
import { normalizeTradingModeStorage } from '../../src/db/settings.js';

assert.equal(normalizeConfiguredMode('dry_run'), 'research');
assert.equal(normalizeConfiguredMode('simulation'), 'research');
assert.equal(normalizeConfiguredMode('research'), 'research');
assert.equal(normalizeConfiguredMode('shadow_live'), 'shadow_live');
assert.equal(normalizeConfiguredMode('confirm'), 'confirm');
assert.equal(normalizeConfiguredMode('live'), 'live');
assert.equal(normalizeConfiguredMode('unknown-mode'), 'research');

// User-facing aliases normalize to explicit semantic modes, while persisted
// Research remains legacy-compatible `dry_run` so older no-money guards cannot
// accidentally become fail-closed or wallet-aware after the rebuild.
assert.equal(normalizeTradingModeStorage('research'), 'dry_run');
assert.equal(normalizeTradingModeStorage('simulation'), 'dry_run');
assert.equal(normalizeTradingModeStorage('dry-run'), 'dry_run');
assert.equal(normalizeTradingModeStorage('shadow'), 'shadow_live');
assert.equal(normalizeTradingModeStorage('shadow_live'), 'shadow_live');
assert.equal(normalizeTradingModeStorage('confirm'), 'confirm');
assert.equal(normalizeTradingModeStorage('live'), 'live');
assert.throws(() => normalizeTradingModeStorage('definitely-invalid'), /Unknown trading mode/);

assert.equal(isResearchSimulationMode('simulation'), true);
assert.equal(isResearchSimulationMode('shadow_live'), false);
assert.equal(requiresMoneyGradeEvidence('dry_run'), false);
assert.equal(requiresMoneyGradeEvidence('simulation'), false);
assert.equal(requiresMoneyGradeEvidence('shadow_live'), true);
assert.equal(requiresMoneyGradeEvidence('confirm'), true);
assert.equal(requiresMoneyGradeEvidence('live'), true);
assert.equal(isRealMoneyMode('shadow_live'), false);
assert.equal(isRealMoneyMode('confirm'), true);
assert.equal(isRealMoneyMode('live'), true);

assert.deepEqual(modeCapabilities('simulation'), {
  mode: 'research',
  research: true,
  walletRequired: false,
  broadcastAllowed: false,
  perTradeConfirmationRequired: false,
  autonomousBroadcastAllowed: false,
  moneyGradeEvidence: false,
});

assert.deepEqual(modeCapabilities('shadow_live'), {
  mode: 'shadow_live',
  research: false,
  walletRequired: true,
  broadcastAllowed: false,
  perTradeConfirmationRequired: false,
  autonomousBroadcastAllowed: false,
  moneyGradeEvidence: true,
});

assert.deepEqual(modeCapabilities('confirm'), {
  mode: 'confirm',
  research: false,
  walletRequired: true,
  broadcastAllowed: true,
  perTradeConfirmationRequired: true,
  autonomousBroadcastAllowed: false,
  moneyGradeEvidence: true,
});

assert.deepEqual(modeCapabilities('live'), {
  mode: 'live',
  research: false,
  walletRequired: true,
  broadcastAllowed: true,
  perTradeConfirmationRequired: false,
  autonomousBroadcastAllowed: true,
  moneyGradeEvidence: true,
});

console.log('[research-policy] mode separation, capability, and storage invariants passed');
