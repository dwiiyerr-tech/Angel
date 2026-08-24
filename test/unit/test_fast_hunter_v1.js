import assert from 'node:assert/strict';
import { db, initDb } from '../../src/db/connection.js';
import { setSetting } from '../../src/db/settings.js';
import {
  ensureFastHunterSchema,
  FAST_HUNTER_VERSION,
  isFastHunterRoute,
  isFastHunterSignal,
  resetFastHunterSchemaForTests,
} from '../../src/research/fastHunter.js';

initDb();
resetFastHunterSchemaForTests();
ensureFastHunterSchema();

assert.equal(FAST_HUNTER_VERSION, 'research-fast-hunter-v1');
assert.equal(isFastHunterRoute('pumpportal_graduated'), true);
assert.equal(isFastHunterRoute('pumpfun_pregrad'), true);
assert.equal(isFastHunterRoute('trending'), false);
assert.equal(isFastHunterRoute('trenches_completed'), false);

setSetting('research_fast_hunter_enabled', 'true');
setSetting('trading_mode', 'dry_run');
assert.equal(isFastHunterSignal({ route: 'pumpportal_graduated' }), true);
assert.equal(isFastHunterSignal({ route: 'pumpfun_pregrad' }), true);
assert.equal(isFastHunterSignal({ route: 'trending' }), false);

setSetting('trading_mode', 'shadow_live');
assert.equal(isFastHunterSignal({ route: 'pumpportal_graduated' }), false, 'Shadow must stay on the full pipeline');
setSetting('trading_mode', 'live');
assert.equal(isFastHunterSignal({ route: 'pumpfun_pregrad' }), false, 'Live must never use Research Fast Hunter V1');

setSetting('trading_mode', 'dry_run');
setSetting('research_fast_hunter_enabled', 'false');
assert.equal(isFastHunterSignal({ route: 'pumpportal_graduated' }), false, 'Fast Hunter can be disabled without changing route code');

const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
assert.equal(tables.has('fast_hunter_runs'), true);
assert.equal(tables.has('fast_hunter_advisories'), true);

const columns = new Set(db.pragma('table_info(fast_hunter_runs)').map(row => row.name));
for (const expected of [
  'signal_at_ms',
  'essential_done_ms',
  'safety_done_ms',
  'momentum_done_ms',
  'decision_done_ms',
  'entry_done_ms',
  'late_enrichment_done_ms',
  'llm_done_ms',
  'full_filter_passed',
  'llm_verdict',
]) {
  assert.equal(columns.has(expected), true, `missing fast-hunter telemetry column ${expected}`);
}

console.log('[test_fast_hunter_v1] PASS');
