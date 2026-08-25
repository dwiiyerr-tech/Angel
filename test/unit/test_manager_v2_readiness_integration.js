import assert from 'node:assert/strict';
import { db, initDb } from '../../src/db/connection.js';
import { ensureResearchSchema } from '../../src/research/schema.js';
import { ensureControlPlaneSchema } from '../../src/controlPlane/schema.js';
import { buildReadinessEvidence } from '../../src/readiness/engine.js';
import { buildManagerEvidence } from '../../src/manager/tools.js';

initDb();
ensureResearchSchema();
ensureControlPlaneSchema();

const marker = `readiness-shadow-${Date.now()}`;
const openedAt = Date.now() - 30 * 60_000;
const closedAt = Date.now() - 20 * 60_000;

// Shadow historically does not guarantee native realized_r. Readiness must
// derive R from realized PnL / initial risk without rewriting the historical row.
const inserted = db.prepare(`
  INSERT INTO dry_run_positions (
    mint, symbol, status, opened_at_ms, closed_at_ms, size_sol,
    entry_price, entry_mcap, high_water_price, high_water_mcap,
    tp_percent, sl_percent, trailing_enabled, trailing_percent, trailing_armed,
    exit_price, exit_mcap, exit_reason, pnl_percent, pnl_sol,
    execution_mode, snapshot_json, initial_risk_sol, realized_r
  ) VALUES (?, 'RDY', 'closed', ?, ?, 0.05,
    1, 100000, 1.2, 120000,
    60, -20, 1, 20, 1,
    1.2, 120000, 'UNIT_TEST', 20, 0.01,
    'shadow_live', '{}', 0.01, NULL)
`).run(marker, openedAt, closedAt);
const positionId = Number(inserted.lastInsertRowid);

const readinessEvidence = buildReadinessEvidence(60 * 60_000);
assert.ok(readinessEvidence.shadow.closedTrades >= 1);
assert.ok(readinessEvidence.shadow.derivedRealizedRSample >= 1);
assert.ok(readinessEvidence.shadow.realizedRCoverage > 0);
assert.equal(db.prepare('SELECT realized_r FROM dry_run_positions WHERE id = ?').get(positionId).realized_r, null);

const readinessQuestion = buildManagerEvidence('Angel apakah sekarang siap Live?');
assert.equal(readinessQuestion.evidenceVersion, 'angel-manager-evidence-v2');
assert.equal(readinessQuestion.questionWindowMs, 7 * 24 * 60 * 60 * 1000);
assert.ok(readinessQuestion.preLiveReadiness?.evaluation?.currentStage);
assert.equal(readinessQuestion.preLiveReadiness.evaluation.authority.canApproveLive, false);
assert.equal(readinessQuestion.preLiveReadiness.evaluation.authority.canEnableLive, false);
assert.equal(readinessQuestion.authority.canBroadcastTransactions, false);

const explicitWindow = buildManagerEvidence('Apakah siap Confirm berdasarkan 3d terakhir?');
assert.equal(explicitWindow.questionWindowMs, 3 * 24 * 60 * 60 * 1000);
const ordinaryQuestion = buildManagerEvidence('Bagaimana performa terakhir?');
assert.equal(ordinaryQuestion.questionWindowMs, 24 * 60 * 60 * 1000);

// Current storage intentionally does not fabricate a separate Confirm sample.
assert.equal(readinessQuestion.preLiveReadiness.evidence.telemetryCaveat.confirmTradesSeparatelyAttributed, false);
assert.match(readinessQuestion.preLiveReadiness.evidence.telemetryCaveat.reason, /does not invent/i);

db.prepare('DELETE FROM dry_run_positions WHERE id = ?').run(positionId);

console.log('[manager-v2-readiness] 7d readiness grounding, Shadow R derivation, and owner-only authority verified');
