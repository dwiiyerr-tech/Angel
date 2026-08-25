import assert from 'node:assert/strict';
import { modeCapabilities, normalizeConfiguredMode } from '../../src/research/policy.js';

const paper = modeCapabilities('paper');
assert.equal(paper.mode, 'paper');
assert.equal(paper.walletRequired, false);
assert.equal(paper.broadcastAllowed, false);
assert.equal(paper.autonomousBroadcastAllowed, false);
assert.equal(paper.protectiveExitBroadcastAllowed, false);
assert.equal(paper.ownerApprovalRequired, false);

// Legacy Shadow is now only a migration alias for PAPER.
const legacyShadow = modeCapabilities('shadow_live');
assert.deepEqual(legacyShadow, paper);
assert.equal(normalizeConfiguredMode('shadow_live'), 'paper');

const live = modeCapabilities('live');
assert.equal(live.mode, 'live');
assert.equal(live.walletRequired, true);
assert.equal(live.broadcastAllowed, true);
assert.equal(live.perTradeConfirmationRequired, true);
assert.equal(live.autonomousBroadcastAllowed, false);
assert.equal(live.protectiveExitBroadcastAllowed, true);
assert.equal(live.ownerApprovalRequired, true);

// Legacy Confirm is a migration alias for LIVE, not a selectable third mode.
const legacyConfirm = modeCapabilities('confirm');
assert.deepEqual(legacyConfirm, live);
assert.equal(normalizeConfiguredMode('confirm'), 'live');

console.log('[two-mode-capabilities] legacy aliases collapse safely and LIVE entries require owner confirmation');
