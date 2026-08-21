import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { setSetting } from '../../src/db/settings.js';
import {
  LIVE_MAX_DAILY_ENTRIES,
  LIVE_MAX_DAILY_LOSS_SOL,
  LIVE_MAX_OPEN_POSITIONS,
} from '../../src/config.js';
import { assertLossStreakAllowed, riskControlState } from '../../src/execution/riskControls.js';

process.env.TELEGRAM_POLLING = 'false';
const { assertLiveRiskBudget } = await import('../../src/execution/router.js');

console.log('[test_shadow_live_risk_budget] Starting isolated shadow-live risk tests...');

db.exec('SAVEPOINT shadow_live_risk_budget_test');
try {
  db.prepare('DELETE FROM execution_operations').run();
  db.prepare('DELETE FROM dry_run_positions').run();

  const insertOperation = db.prepare(`
    INSERT INTO execution_operations (mint, side, status, created_at_ms, updated_at_ms)
    VALUES (?, 'buy', 'completed', ?, ?)
  `);
  for (let i = 0; i < LIVE_MAX_DAILY_ENTRIES; i++) {
    insertOperation.run(`LiveBudgetMint${i}`, Date.now(), Date.now());
  }
  assert.throws(() => assertLiveRiskBudget(0.01, 'live'), /daily live entry cap/);
  assert.doesNotThrow(
    () => assertLiveRiskBudget(0.01, 'shadow_live'),
    'live execution operations must not consume the shadow-live daily entry budget',
  );

  db.prepare('DELETE FROM execution_operations').run();
  const insertPosition = db.prepare(`
    INSERT INTO dry_run_positions (
      candidate_id, mint, symbol, status, opened_at_ms, closed_at_ms, size_sol,
      tp_percent, sl_percent, trailing_enabled, trailing_percent,
      pnl_percent, pnl_sol, execution_mode, snapshot_json
    ) VALUES (NULL, ?, ?, ?, ?, ?, ?, 60, -15, 0, 20, ?, ?, ?, '{}')
  `);

  for (let i = 0; i < LIVE_MAX_DAILY_ENTRIES; i++) {
    const at = Date.now() - i * 1000;
    insertPosition.run(`ShadowEntryMint${i}`, `SE${i}`, 'closed', at - 500, at, 0.01, 5, 0.001, 'shadow_live');
  }
  assert.throws(() => assertLiveRiskBudget(0.01, 'shadow_live'), /daily shadow-live entry cap/);
  assert.doesNotThrow(
    () => assertLiveRiskBudget(0.01, 'live'),
    'shadow-live positions must not consume the live daily entry budget',
  );

  db.prepare('DELETE FROM dry_run_positions').run();
  for (let i = 0; i < LIVE_MAX_OPEN_POSITIONS; i++) {
    const at = Date.now() - i * 1000;
    insertPosition.run(`LiveOpenMint${i}`, `LO${i}`, 'open', at, null, 0.01, null, null, 'live');
  }
  assert.throws(() => assertLiveRiskBudget(0.01, 'live'), /Hard live position cap/);
  assert.doesNotThrow(
    () => assertLiveRiskBudget(0.01, 'shadow_live'),
    'live open-position exposure must not consume the shadow-live hard budget',
  );

  db.prepare('DELETE FROM dry_run_positions').run();
  for (let i = 0; i < LIVE_MAX_OPEN_POSITIONS; i++) {
    const at = Date.now() - i * 1000;
    insertPosition.run(`ShadowOpenMint${i}`, `SO${i}`, 'open', at, null, 0.01, null, null, 'shadow_live');
  }
  assert.throws(() => assertLiveRiskBudget(0.01, 'shadow_live'), /Hard shadow-live position cap/);
  assert.doesNotThrow(
    () => assertLiveRiskBudget(0.01, 'live'),
    'shadow-live open-position exposure must not consume the real live hard budget',
  );

  db.prepare('DELETE FROM dry_run_positions').run();
  const lossAt = Date.now();
  insertPosition.run('ShadowDailyLossMint', 'SDL', 'closed', lossAt - 1000, lossAt, 0.01, -50, -LIVE_MAX_DAILY_LOSS_SOL, 'shadow_live');
  assert.throws(() => assertLiveRiskBudget(0.01, 'shadow_live'), /daily shadow-live loss limit/);
  assert.doesNotThrow(
    () => assertLiveRiskBudget(0.01, 'live'),
    'shadow-live realized PnL must not contaminate the real live daily-loss budget',
  );

  db.prepare('DELETE FROM dry_run_positions').run();
  setSetting('loss_streak_size_cut_after', '2');
  setSetting('loss_streak_pause_after', '3');
  setSetting('loss_streak_pause_ms', String(30 * 60 * 1000));
  setSetting('loss_streak_size_multiplier', '0.5');
  for (let i = 0; i < 3; i++) {
    const at = Date.now() - i * 1000;
    insertPosition.run(`LiveLossIsolationMint${i}`, `LLI${i}`, 'closed', at - 500, at, 0.01, -10, -0.01, 'live');
  }
  assert.equal(riskControlState('live').paused, true);
  assert.equal(riskControlState('shadow_live').streak, 0);
  assert.doesNotThrow(() => assertLossStreakAllowed('shadow_live'));

  for (let i = 0; i < 3; i++) {
    const at = Date.now() + 1000 + i;
    insertPosition.run(`ShadowLossIsolationMint${i}`, `SLI${i}`, 'closed', at - 500, at, 0.01, -10, -0.01, 'shadow_live');
  }
  assert.equal(riskControlState('shadow_live').paused, true);
  assert.throws(() => assertLossStreakAllowed('shadow_live'), /Entry paused after 3 consecutive losses/);

  assert.equal(assertLiveRiskBudget(0.01, 'confirm').executionMode, 'live');
  assert.throws(() => assertLiveRiskBudget(0.01, 'dry_run'), /only supports live\/confirm\/shadow_live/);
} finally {
  db.exec('ROLLBACK TO shadow_live_risk_budget_test');
  db.exec('RELEASE shadow_live_risk_budget_test');
}

console.log('[test_shadow_live_risk_budget] SUCCESS: shadow-live hard budgets and loss history are isolated from real live state.');
