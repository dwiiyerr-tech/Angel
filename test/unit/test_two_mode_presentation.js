import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { publicExecutionMode, isPaperExecutionMode } from '../../src/tradingModePresentation.js';
import { formatPosition } from '../../src/telegram/format.js';

console.log('[test_two_mode_presentation] Starting PAPER/LIVE presentation contract tests...');

const liveAliases = ['live', 'LIVE', ' Live ', 'confirm', 'CONFIRM'];
for (const value of liveAliases) {
  assert.strictEqual(publicExecutionMode(value), 'LIVE', `${JSON.stringify(value)} must present as LIVE`);
  assert.strictEqual(isPaperExecutionMode(value), false, `${JSON.stringify(value)} must not use PAPER semantics`);
}

const paperAliases = [
  undefined,
  null,
  '',
  'dry_run',
  'research',
  'shadow_live',
  'paper',
  'unknown-mode',
];
for (const value of paperAliases) {
  assert.strictEqual(publicExecutionMode(value), 'PAPER', `${JSON.stringify(value)} must fail closed to PAPER`);
  assert.strictEqual(isPaperExecutionMode(value), true, `${JSON.stringify(value)} must use PAPER semantics`);
}

const basePosition = {
  id: 42,
  mint: 'PresentationMint111111111111111111111111111',
  symbol: 'ANGEL',
  status: 'open',
  strategy_id: 'sniper',
  entry_mcap: 100000,
  high_water_mcap: 120000,
  size_sol: 0.25,
  sim_notional_sol: 0.5,
  pnl_percent: 20,
  pnl_sol: 0.1,
  initial_risk_sol: 0.05,
  planned_rr: 2,
  mfe_r: 3,
  mae_r: -0.5,
  tp_percent: 50,
  sl_percent: -20,
  trailing_enabled: false,
};

for (const execution_mode of ['dry_run', 'research', 'shadow_live', 'paper', 'future_internal_mode']) {
  const text = formatPosition({ ...basePosition, execution_mode });
  assert.match(text, /Mode: <b>PAPER<\/b>/, `${execution_mode} must never leak its internal mode name`);
  assert.match(text, /Capital: <b>0 SOL<\/b>/, `${execution_mode} must explicitly show zero real capital`);
  assert.match(text, /Probe:/, `${execution_mode} must label simulated notional as Probe`);
  assert.match(text, /Virtual PnL:/, `${execution_mode} must label PnL as virtual`);
  assert.doesNotMatch(text, /Mode: <b>(RESEARCH|SHADOW|DRY_RUN)/i);
  assert.doesNotMatch(text, /\nSize:/, `${execution_mode} must not present simulated notional as deposited size`);
}

for (const execution_mode of ['live', 'confirm']) {
  const text = formatPosition({ ...basePosition, execution_mode });
  assert.match(text, /Mode: <b>LIVE<\/b>/, `${execution_mode} must present as LIVE`);
  assert.match(text, /\nSize:/, `${execution_mode} must retain LIVE size semantics`);
  assert.match(text, /PnL:/, `${execution_mode} must retain LIVE PnL semantics`);
  assert.doesNotMatch(text, /Capital: <b>0 SOL<\/b>/);
  assert.doesNotMatch(text, /Virtual PnL:/);
}

for (const path of [
  'src/telegram/format.js',
  'src/visuals/entryCard.js',
  'src/visuals/exitCard.js',
]) {
  const source = readFileSync(path, 'utf8');
  assert.match(source, /publicExecutionMode/, `${path} must use the canonical public mode mapper`);
  assert.doesNotMatch(source, /SHADOW ENTRY|RESEARCH\s*[·-]\s*0 SOL/i, `${path} must not reintroduce legacy public labels`);
}

console.log('[test_two_mode_presentation] SUCCESS: public mode aliases, fail-closed PAPER semantics, and Telegram presentation contract verified.');
