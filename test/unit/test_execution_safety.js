import assert from 'node:assert';
import { db } from '../../src/db/connection.js';
import { claimExecutionOperation, updateExecutionOperation } from '../../src/db/executionOperations.js';
import { setActiveStrategy, activeStrategy, setSetting, updateStrategyConfig } from '../../src/db/settings.js';
import { assertLiveConfigApproved, approveLiveConfigSnapshot, createLiveConfigSnapshot, currentLiveConfig } from '../../src/db/liveConfig.js';

console.log('[test_execution_safety] Starting durable execution safety tests...');

const mint = 'ExecutionSafetyMint111111111111111111111111111';
const first = claimExecutionOperation({ mint, side: 'buy', inputAmount: '1000' });
assert.strictEqual(first.ok, true, 'first buy operation should claim the mint');
const duplicate = claimExecutionOperation({ mint, side: 'buy', inputAmount: '1000' });
assert.strictEqual(duplicate.ok, false, 'second active buy must be blocked');

updateExecutionOperation(first.operationId, 'failed', { error: 'known pre-broadcast failure' });
const retry = claimExecutionOperation({ mint, side: 'buy', inputAmount: '1000' });
assert.strictEqual(retry.ok, true, 'known failure should allow a later retry');
updateExecutionOperation(retry.operationId, 'outcome_unknown', { error: 'transport timeout' });
const ambiguousRetry = claimExecutionOperation({ mint, side: 'buy', inputAmount: '1000' });
assert.strictEqual(ambiguousRetry.ok, false, 'ambiguous broadcast must block automatic retry');
updateExecutionOperation(retry.operationId, 'failed', { error: 'test cleanup after ambiguity assertion' });

const previousStrategy = activeStrategy().id;
assert.throws(() => setActiveStrategy('missing-strategy'), /Unknown strategy/);
assert.strictEqual(activeStrategy().id, previousStrategy, 'invalid strategy selection must preserve the active strategy');

const orphanPositionId = 999999999;
assert.throws(() => db.prepare(`
  INSERT INTO dry_run_trades
    (position_id, mint, side, at_ms, payload_json)
  VALUES (?, ?, 'buy', ?, '{}')
`).run(orphanPositionId, mint, Date.now()), /requires position/);

const snapshot = createLiveConfigSnapshot();
assert.match(currentLiveConfig().runtime.code_sha256, /^[a-f0-9]{64}$/);
assert.match(currentLiveConfig().runtime.model_sha256, /^[a-f0-9]{64}$/);
assert.throws(() => approveLiveConfigSnapshot(snapshot.id, 'bad-checksum'), /checksum mismatch/);
approveLiveConfigSnapshot(snapshot.id, snapshot.checksum);
assert(assertLiveConfigApproved(), 'approved unchanged snapshot should unlock live mode');
db.prepare('UPDATE live_config_snapshots SET approved_at_ms = ? WHERE id = ?').run(Date.now() - 25 * 60 * 60 * 1000, snapshot.id);
assert.throws(() => assertLiveConfigApproved(), /approved configuration snapshot/, 'expired approval must fail even when config is unchanged');
db.prepare('UPDATE live_config_snapshots SET approved_at_ms = ? WHERE id = ?').run(Date.now(), snapshot.id);
setSetting('trading_mode', 'live');
assert.throws(() => setSetting('llm_min_confidence', '90'), /Cannot change/);
assert.throws(() => updateStrategyConfig(activeStrategy().id, activeStrategy()), /Cannot change strategy configuration/);
setSetting('trading_mode', 'dry_run');
setSetting('llm_min_confidence', '61');
assert.throws(() => assertLiveConfigApproved(), /approved configuration snapshot/);

console.log('[test_execution_safety] SUCCESS: execution claims, live approval, and relation guards verified.');
