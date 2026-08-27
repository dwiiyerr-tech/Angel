import assert from 'node:assert/strict';
import { db } from '../../src/db/connection.js';
import { activeStrategy } from '../../src/db/settings.js';
import {
  liveEntryBlockReason,
  openExecutionPositions,
  openPositionCount,
} from '../../src/db/positions.js';
import {
  openResearchPositionCount,
  resetResearchCapacityForTests,
} from '../../src/research/engine.js';
import { ensureResearchSchema } from '../../src/research/schema.js';

ensureResearchSchema();
resetResearchCapacityForTests();

const baselinePaper = openResearchPositionCount();
const baselineLive = openPositionCount();
const now = Date.now();
const inserted = [];

const insertPosition = ({ mint, mode, status = 'open', pnlPercent = null, closedAtMs = null }) => {
  const result = db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_mcap,
      tp_percent, sl_percent, trailing_enabled, trailing_percent,
      execution_mode, snapshot_json, pnl_percent, pnl_sol
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
  `).run(
    mint,
    mode.toUpperCase().slice(0, 10),
    status,
    now,
    closedAtMs,
    0.1,
    1000,
    50,
    -25,
    1,
    10,
    mode,
    pnlPercent,
    pnlPercent == null ? null : pnlPercent / 100 * 0.1,
  );
  inserted.push(Number(result.lastInsertRowid));
  return Number(result.lastInsertRowid);
};

const paperModes = ['research', 'dry_run', 'shadow_live', 'future_internal_mode'];
const liveModes = ['live', 'confirm'];
const idsByMode = new Map();
for (const mode of [...paperModes, ...liveModes]) {
  idsByMode.set(mode, insertPosition({ mint: `two-mode-open-${mode}`, mode }));
}

assert.equal(
  openResearchPositionCount() - baselinePaper,
  paperModes.length,
  'PAPER capacity must count every PAPER/fail-closed alias and exclude live/confirm',
);
assert.equal(
  openPositionCount() - baselineLive,
  liveModes.length,
  'capital-bearing capacity must count only live/confirm aliases',
);

const executionIds = new Set(openExecutionPositions().map(row => Number(row.id)));
for (const mode of paperModes) {
  assert.equal(executionIds.has(idsByMode.get(mode)), false, `${mode} must not consume LIVE execution slots`);
}
for (const mode of liveModes) {
  assert.equal(executionIds.has(idsByMode.get(mode)), true, `${mode} must consume LIVE execution slots`);
}

const paperHistoryMint = 'two-mode-paper-history';
insertPosition({
  mint: paperHistoryMint,
  mode: 'shadow_live',
  status: 'closed',
  pnlPercent: 25,
  closedAtMs: now - 60_000,
});
assert.equal(
  liveEntryBlockReason(paperHistoryMint, activeStrategy()),
  null,
  'zero-capital PAPER aliases must not impose LIVE re-entry cooldowns',
);

const confirmHistoryMint = 'two-mode-confirm-history';
insertPosition({
  mint: confirmHistoryMint,
  mode: 'confirm',
  status: 'closed',
  pnlPercent: 25,
  closedAtMs: now - 60_000,
});
assert.equal(
  liveEntryBlockReason(confirmHistoryMint, activeStrategy()),
  'closed_within_24h',
  'legacy confirm is LIVE and must retain LIVE cooldown semantics',
);

db.prepare(`DELETE FROM dry_run_positions WHERE id IN (${inserted.map(() => '?').join(',')})`).run(...inserted);
resetResearchCapacityForTests();
console.log('[two-mode-capital-aliases] canonical PAPER/LIVE capacity and cooldown semantics verified');
