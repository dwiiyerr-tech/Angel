import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { setSetting } from '../../src/db/settings.js';
import { storeLearningRun } from '../../src/learning/lessons.js';
import { momentumFilter } from '../../src/pipeline/momentumFilter.js';

process.env.TELEGRAM_POLLING = 'false';
const { assertLiveRiskBudget, assertSafeLiveDecision } = await import('../../src/execution/router.js');

console.log('[test_live_money_safety] Starting live-money guardrail tests...');

assert.doesNotThrow(() => assertLiveRiskBudget(0.05));
assert.doesNotThrow(() => assertSafeLiveDecision({ verdict: 'BUY', confidence: 80, suggested_tp_percent: 50, suggested_sl_percent: -20 }, {}));
assert.throws(() => assertSafeLiveDecision({ verdict: 'BUY', confidence: 80, suggested_tp_percent: 50, suggested_sl_percent: 10 }, {}), /Unsafe stop-loss/);
const insertOperation = db.prepare(`
  INSERT INTO execution_operations (mint, side, status, created_at_ms, updated_at_ms)
  VALUES (?, 'buy', 'completed', ?, ?)
`);
for (let i = 0; i < 5; i++) insertOperation.run(`DailyCapMint${i}`, Date.now(), Date.now());
assert.throws(() => assertLiveRiskBudget(0.01), /daily live entry cap/);
db.prepare('DELETE FROM execution_operations').run();

const summary49 = { positions: { closed: 49 } };
const insufficientRun = storeLearningRun(7 * 24 * 60 * 60 * 1000, summary49, [{ lesson: 'weak evidence', evidence: {} }], {});
assert.equal(db.prepare('SELECT status FROM learning_lessons WHERE run_id = ?').get(insufficientRun).status, 'insufficient');
const summary50 = { positions: { closed: 50 } };
const candidateRun = storeLearningRun(7 * 24 * 60 * 60 * 1000, summary50, [{ lesson: 'approval required', evidence: {} }], {});
assert.equal(db.prepare('SELECT status FROM learning_lessons WHERE run_id = ?').get(candidateRun).status, 'candidate');

setSetting('trading_mode', 'dry_run');
assert.equal((await momentumFilter({ token: { mint: 'NoPriceMint' }, gmgn: {} })).passed, true);
db.prepare("UPDATE settings SET value = 'live' WHERE key = 'trading_mode'").run();
assert.equal((await momentumFilter({ token: { mint: 'NoPriceMint' }, gmgn: {} })).passed, false, 'live/confirm ML fallback must fail closed');
db.prepare("UPDATE settings SET value = 'dry_run' WHERE key = 'trading_mode'").run();

console.log('[test_live_money_safety] SUCCESS: hard budgets, lesson approval gate, and live ML fail-closed verified.');
process.exit(0);
