import assert from 'node:assert/strict';
import { modeCapabilities } from '../../src/research/policy.js';

const research = modeCapabilities('research');
assert.equal(research.walletRequired, false);
assert.equal(research.broadcastAllowed, false);
assert.equal(research.perTradeConfirmationRequired, false);
assert.equal(research.autonomousBroadcastAllowed, false);

const shadow = modeCapabilities('shadow_live');
assert.equal(shadow.walletRequired, true);
assert.equal(shadow.broadcastAllowed, false);
assert.equal(shadow.perTradeConfirmationRequired, false);
assert.equal(shadow.autonomousBroadcastAllowed, false);

const confirm = modeCapabilities('confirm');
assert.equal(confirm.walletRequired, true);
assert.equal(confirm.broadcastAllowed, true);
assert.equal(confirm.perTradeConfirmationRequired, true);
assert.equal(confirm.autonomousBroadcastAllowed, false);
assert.equal(confirm.moneyGradeEvidence, true);

const live = modeCapabilities('live');
assert.equal(live.walletRequired, true);
assert.equal(live.broadcastAllowed, true);
assert.equal(live.perTradeConfirmationRequired, false);
assert.equal(live.autonomousBroadcastAllowed, true);
assert.equal(live.moneyGradeEvidence, true);

console.log('[mode-capabilities] Research/Shadow/Confirm/Live metadata matches executor semantics');
