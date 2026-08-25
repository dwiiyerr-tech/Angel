import assert from 'node:assert/strict';
import { db, initDb } from '../../src/db/connection.js';
import { ensureResearchSchema } from '../../src/research/schema.js';
import { ensureControlPlaneSchema } from '../../src/controlPlane/schema.js';
import { buildReadinessEvidence } from '../../src/readiness/engine.js';
import { buildManagerEvidence } from '../../src/manager/tools.js';

initDb();
ensureResearchSchema();
ensureControlPlaneSchema();

const marker = `readiness-paper-${Date.now()}`;
const openedAt = Date.now() - 30 * 60_000;
const closedAt = Date.now() - 20 * 60_000;

// PAPER keeps the mature Research ledger label internally. Public readiness must
// expose it as Paper without rewriting historical storage.
const inserted = db.prepare(`
  INSERT INTO dry_run_positions (
    mint, symbol, status, opened_at_ms, closed_at_ms, size_sol,
    entry_price, entry_mcap, high_water_price, high_water_mcap,
    tp_percent, sl_percent, trailing_enabled, trailing_percent, trailing_armed,
    exit_price, exit_mcap, exit_reason, pnl_percent, pnl_sol,
    execution_mode, snapshot_json, initial_risk_sol, realized_r
  ) VALUES (?, 'PPR', 'closed', ?, ?, 0.05,
    1, 100000, 1.2, 120000,
    60, -20, 1, 20, 1,
    1.2, 120000, 'UNIT_TEST', 20, 0.01,
    'research', '{}', 0.01, 1.0)
`).run(marker, openedAt, closedAt);
const positionId = Number(inserted.lastInsertRowid);

const readinessEvidence = buildReadinessEvidence(60 * 60_000);
assert.equal(readinessEvidence.currentMode, 'paper');
assert.ok(readinessEvidence.paper.closedTrades >= 1);
assert.ok(readinessEvidence.paper.nativeRealizedRSample >= 1);
assert.equal(readinessEvidence.storageCompatibility.paperPositionExecutionMode, 'research');
assert.deepEqual(readinessEvidence.storageCompatibility.publicModes, ['paper', 'live']);
assert.equal('shadow' in readinessEvidence, false);

const readinessQuestion = buildManagerEvidence('Angel apakah sekarang siap Live?');
assert.equal(readinessQuestion.evidenceVersion, 'angel-manager-evidence-v3-two-mode');
assert.equal(readinessQuestion.questionWindowMs, 7 * 24 * 60 * 60 * 1000);
assert.deepEqual(readinessQuestion.modeModel.publicModes, ['paper', 'live']);
assert.ok(readinessQuestion.preLiveReadiness?.evaluation?.paperToLiveConsideration);
assert.equal(readinessQuestion.preLiveReadiness.evaluation.authority.canApproveLive, false);
assert.equal(readinessQuestion.preLiveReadiness.evaluation.authority.canEnableLive, false);
assert.equal(readinessQuestion.authority.canBroadcastTransactions, false);

const explicitWindow = buildManagerEvidence('Apakah siap Live berdasarkan 3d terakhir?');
assert.equal(explicitWindow.questionWindowMs, 3 * 24 * 60 * 60 * 1000);
const ordinaryQuestion = buildManagerEvidence('Bagaimana performa terakhir?');
assert.equal(ordinaryQuestion.questionWindowMs, 24 * 60 * 60 * 1000);

assert.equal('telemetryCaveat' in readinessQuestion.preLiveReadiness.evidence, false);
assert.equal('shadowToConfirm' in readinessQuestion.preLiveReadiness.evaluation, false);
assert.equal('confirmToLiveConsideration' in readinessQuestion.preLiveReadiness.evaluation, false);

assert.equal(db.prepare('SELECT execution_mode FROM dry_run_positions WHERE id = ?').get(positionId).execution_mode, 'research');
db.prepare('DELETE FROM dry_run_positions WHERE id = ?').run(positionId);

console.log('[manager-two-mode] PAPER/LIVE readiness grounding and owner-only authority verified');
