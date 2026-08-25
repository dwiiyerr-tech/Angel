import assert from 'node:assert/strict';
import {
  normalizeConfiguredMode,
  isPaperTradingMode,
  isResearchSimulationMode,
  requiresMoneyGradeEvidence,
  isRealMoneyMode,
  modeCapabilities,
} from '../../src/research/policy.js';
import { normalizeTradingModeStorage } from '../../src/db/settings.js';

for (const alias of ['paper', 'paper_trading', 'dry_run', 'dry-run', 'simulation', 'research', 'shadow', 'shadow_live']) {
  assert.equal(normalizeConfiguredMode(alias), 'paper', `${alias} must collapse to PAPER`);
  assert.equal(normalizeTradingModeStorage(alias), 'dry_run', `${alias} must persist as dry_run`);
}
for (const alias of ['confirm', 'live']) {
  assert.equal(normalizeConfiguredMode(alias), 'live', `${alias} must collapse to LIVE`);
  assert.equal(normalizeTradingModeStorage(alias), 'live', `${alias} must persist as live`);
}
assert.equal(normalizeConfiguredMode('unknown-mode'), 'paper');
assert.throws(() => normalizeTradingModeStorage('definitely-invalid'), /Unknown trading mode/);

assert.equal(isPaperTradingMode('research'), true);
assert.equal(isPaperTradingMode('shadow_live'), true);
assert.equal(isResearchSimulationMode('simulation'), true);
assert.equal(isResearchSimulationMode('shadow_live'), true);
assert.equal(isResearchSimulationMode('confirm'), false);
assert.equal(requiresMoneyGradeEvidence('dry_run'), false);
assert.equal(requiresMoneyGradeEvidence('shadow_live'), false);
assert.equal(requiresMoneyGradeEvidence('confirm'), true);
assert.equal(requiresMoneyGradeEvidence('live'), true);
assert.equal(isRealMoneyMode('shadow_live'), false);
assert.equal(isRealMoneyMode('confirm'), true);
assert.equal(isRealMoneyMode('live'), true);

assert.deepEqual(modeCapabilities('paper'), {
  mode: 'paper',
  paper: true,
  live: false,
  research: true,
  walletRequired: false,
  broadcastAllowed: false,
  perTradeConfirmationRequired: false,
  autonomousBroadcastAllowed: false,
  protectiveExitBroadcastAllowed: false,
  moneyGradeEvidence: false,
  ownerApprovalRequired: false,
});
assert.deepEqual(modeCapabilities('shadow_live'), modeCapabilities('paper'));

assert.deepEqual(modeCapabilities('live'), {
  mode: 'live',
  paper: false,
  live: true,
  research: false,
  walletRequired: true,
  broadcastAllowed: true,
  perTradeConfirmationRequired: true,
  autonomousBroadcastAllowed: false,
  protectiveExitBroadcastAllowed: true,
  moneyGradeEvidence: true,
  ownerApprovalRequired: true,
});
assert.deepEqual(modeCapabilities('confirm'), modeCapabilities('live'));

console.log('[two-mode-policy] PAPER/LIVE canonical modes and owner-approved LIVE entry verified');
