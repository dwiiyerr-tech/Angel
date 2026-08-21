import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { setSetting } from '../../src/db/settings.js';
import { storeLearningRun } from '../../src/learning/lessons.js';
import { activeLessonsForPrompt } from '../../src/pipeline/llm.js';
import { momentumFilter } from '../../src/pipeline/momentumFilter.js';
import { riskControlState, assertLossStreakAllowed } from '../../src/execution/riskControls.js';
import { LIVE_SETTING_KEYS } from '../../src/db/liveConfig.js';

process.env.TELEGRAM_POLLING = 'false';
const { assertLiveRiskBudget, assertSafeLiveDecision } = await import('../../src/execution/router.js');

console.log('[test_live_money_safety] Starting live-money guardrail tests...');

assert.doesNotThrow(() => assertLiveRiskBudget(0.05));
assert.doesNotThrow(() => assertSafeLiveDecision({ verdict: 'BUY', confidence: 80, suggested_tp_percent: 50, suggested_sl_percent: -20 }, {}));
assert.throws(() => assertSafeLiveDecision({ verdict: 'BUY', confidence: 80, suggested_tp_percent: 25, suggested_sl_percent: -20 }, {}), /risk\/reward/);
assert.throws(() => assertSafeLiveDecision({ verdict: 'BUY', confidence: 80, suggested_tp_percent: 50, suggested_sl_percent: 10 }, {}), /Unsafe stop-loss/);
const insertOperation = db.prepare(`
  INSERT INTO execution_operations (mint, side, status, created_at_ms, updated_at_ms)
  VALUES (?, 'buy', 'completed', ?, ?)
`);
for (let i = 0; i < 5; i++) insertOperation.run(`DailyCapMint${i}`, Date.now(), Date.now());
assert.throws(() => assertLiveRiskBudget(0.01), /daily live entry cap/);
db.prepare('DELETE FROM execution_operations').run();

for (const key of ['max_entry_sl_percent', 'min_entry_tp_percent', 'min_executable_position_sol', 'min_opportunity_size_multiplier']) {
  assert.equal(LIVE_SETTING_KEYS.has(key), true, `${key} must invalidate live approval when changed`);
}

const summary49 = { positions: { closed: 49 } };
const insufficientRun = storeLearningRun(7 * 24 * 60 * 60 * 1000, summary49, [{ lesson: 'weak evidence', evidence: {} }], {});
assert.equal(db.prepare('SELECT status FROM learning_lessons WHERE run_id = ?').get(insufficientRun).status, 'insufficient');
const summary50 = { positions: { closed: 50 }, dataQuality: { learningEligible: true } };
const candidateRun = storeLearningRun(7 * 24 * 60 * 60 * 1000, summary50, [{ lesson: 'approval required', evidence: {} }], {});
assert.equal(db.prepare('SELECT status FROM learning_lessons WHERE run_id = ?').get(candidateRun).status, 'candidate');
const lessonId = db.prepare('SELECT id FROM learning_lessons WHERE run_id = ?').get(candidateRun).id;
db.prepare("UPDATE learning_lessons SET status='active', approved_at_ms=?, expires_at_ms=? WHERE id=?")
  .run(Date.now(), Date.now() + 30 * 86400000, lessonId);
assert.equal(activeLessonsForPrompt(['trending']).some(lesson => lesson.id === lessonId), true, 'approved unexpired lesson enters prompt context');
assert.equal(db.prepare('SELECT expires_at_ms FROM learning_lessons WHERE id = ?').get(lessonId).expires_at_ms > Date.now(), true);

setSetting('trading_mode', 'dry_run');
assert.equal((await momentumFilter({ token: { mint: 'NoPriceMint' }, gmgn: {} })).passed, true);
db.prepare("UPDATE settings SET value = 'live' WHERE key = 'trading_mode'").run();
assert.equal((await momentumFilter({ token: { mint: 'NoPriceMint' }, gmgn: {} })).passed, false, 'live/confirm ML fallback must fail closed');
db.prepare("UPDATE settings SET value = 'dry_run' WHERE key = 'trading_mode'").run();

// Regression: human-confirmed trades are still real-money trades. Confirm mode
// must use the live loss history and must fail closed when the live pause trips.
db.prepare("DELETE FROM dry_run_positions").run();
setSetting('loss_streak_size_cut_after', '2');
setSetting('loss_streak_pause_after', '3');
setSetting('loss_streak_pause_ms', String(30 * 60 * 1000));
setSetting('loss_streak_size_multiplier', '0.5');
const insertClosedPosition = db.prepare(`
  INSERT INTO dry_run_positions (
    candidate_id, mint, symbol, status, opened_at_ms, closed_at_ms, size_sol,
    pnl_percent, pnl_sol, execution_mode
  ) VALUES (NULL, ?, ?, 'closed', ?, ?, 0.01, ?, ?, ?)
`);
for (let i = 0; i < 3; i++) {
  const at = Date.now() - i * 1000;
  insertClosedPosition.run(`LiveLossMint${i}`, `LL${i}`, at - 1000, at, -10, -0.01, 'live');
}
insertClosedPosition.run('DryWinMint', 'DW', Date.now() - 5000, Date.now() - 4000, 20, 0.02, 'dry_run');
const confirmRisk = riskControlState('confirm');
assert.equal(confirmRisk.streak, 3, 'confirm mode must read live loss history');
assert.equal(confirmRisk.paused, true, 'confirm mode must inherit live loss pause');
assert.equal(confirmRisk.sizeMultiplier, 0, 'paused money mode must calculate a zero-sized entry');
assert.throws(() => assertLossStreakAllowed('confirm'), /Entry paused after 3 consecutive losses/);

console.log('[test_live_money_safety] SUCCESS: hard budgets, live approval fingerprint, lesson approval gate, live ML fail-closed, and confirm-mode loss controls verified.');
process.exit(0);
