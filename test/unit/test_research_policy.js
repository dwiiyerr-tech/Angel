import assert from 'node:assert/strict';
import {
  normalizeConfiguredMode,
  isResearchSimulationMode,
  requiresMoneyGradeEvidence,
  isRealMoneyMode,
  modeCapabilities,
} from '../../src/research/policy.js';

assert.equal(normalizeConfiguredMode('dry_run'), 'research');
assert.equal(normalizeConfiguredMode('simulation'), 'research');
assert.equal(normalizeConfiguredMode('research'), 'research');
assert.equal(normalizeConfiguredMode('shadow_live'), 'shadow_live');
assert.equal(normalizeConfiguredMode('confirm'), 'confirm');
assert.equal(normalizeConfiguredMode('live'), 'live');
assert.equal(normalizeConfiguredMode('unknown-mode'), 'research');

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
  moneyGradeEvidence: false,
});
assert.equal(modeCapabilities('shadow_live').walletRequired, true);
assert.equal(modeCapabilities('shadow_live').broadcastAllowed, false);
assert.equal(modeCapabilities('live').broadcastAllowed, true);

console.log('[research-policy] mode separation invariants passed');
