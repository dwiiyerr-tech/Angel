import assert from 'node:assert/strict';
import { setSetting } from '../../src/db/settings.js';
import {
  resetResearchCapacityForTests,
  tryReserveResearchPositionSlot,
  releaseResearchPositionSlot,
  pendingResearchPositions,
  openResearchPositionCount,
  canOpenResearchPosition,
} from '../../src/research/engine.js';
import { ensureResearchSchema } from '../../src/research/schema.js';

ensureResearchSchema();
resetResearchCapacityForTests();
setSetting('research_max_open_positions', 1);

assert.equal(openResearchPositionCount(), 0);
assert.equal(canOpenResearchPosition(), true);
assert.equal(tryReserveResearchPositionSlot(), true);
assert.equal(pendingResearchPositions(), 1);
assert.equal(openResearchPositionCount(), 1);
assert.equal(canOpenResearchPosition(), false);
assert.equal(tryReserveResearchPositionSlot(), false, 'second async entry must not oversubscribe research cap');

releaseResearchPositionSlot();
assert.equal(pendingResearchPositions(), 0);
assert.equal(openResearchPositionCount(), 0);
assert.equal(canOpenResearchPosition(), true);

// Release is intentionally idempotent-safe for finally blocks.
releaseResearchPositionSlot();
assert.equal(pendingResearchPositions(), 0);

console.log('[research-capacity] async reservation invariants passed');
