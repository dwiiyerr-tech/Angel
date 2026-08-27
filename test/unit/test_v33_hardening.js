import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { db } from '../../src/db/connection.js';
import { setting, setSetting } from '../../src/db/settings.js';
import { evaluateChallengerRows } from '../../src/controlPlane/challenger.js';
import { ensureControlPlaneSchema } from '../../src/controlPlane/schema.js';
import { replayPathPolicy } from '../../src/learning/counterfactualReplay.js';
import { isIndependentLateRoute, signalEvidenceKey } from '../../src/pipeline/evidenceWindow.js';
import { pendingReleaseRollback, requestReleaseRollback } from '../../src/release/rollbackRequest.js';
import { ensureDecisionIntelligenceSchema } from '../../src/decisionIntelligence/schema.js';
import {
  counterfactualOutcomeRecords,
  counterfactualSurvivalRecords,
} from '../../src/decisionIntelligence/learning.js';

const policy = {
  version: 'hardening-test',
  stopR: -1,
  trailArmR: 1,
  trailGivebackR: 1,
  profitFloorR: 0,
  partialAtR: 1,
  partialSellFraction: 0.25,
};
const gap = replayPathPolicy([
  { atMs: 1, r: 0 },
  { atMs: 2, r: 2 },
  { atMs: 3, r: -2 },
], policy);
assert.equal(gap.reason, 'stop');
assert.equal(gap.terminalR, -2, 'replay must use the executable gap quote, not the ideal stop threshold');
assert.equal(gap.exitR, -1, 'partial realization and remaining gap fill must be combined');

const perArm = evaluateChallengerRows([
  { route: 'a', active_eligible: 1, challenger_eligible: 1, active_realized_r: -1, challenger_realized_r: 2 },
  { route: 'a', active_eligible: 1, challenger_eligible: 1, active_realized_r: -1, challenger_realized_r: 1 },
], { minSample: 2, minRouteSample: 2, minAgeMs: 0, startedAtMs: 0, nowMs: 1 });
assert.equal(perArm.active.expectancyR, -1);
assert.equal(perArm.challenger.expectancyR, 1.5);

const at = 120_000;
assert.equal(signalEvidenceKey({ mint: 'mint', route: 'a' }, at), signalEvidenceKey({ mint: 'mint', route: 'a' }, at + 1));
assert.notEqual(signalEvidenceKey({ mint: 'mint', route: 'a' }, at), signalEvidenceKey({ mint: 'mint', route: 'b' }, at));
assert.equal(isIndependentLateRoute({ mint: 'mint', route: 'smart_money' }, { signals: { route: 'trending' } }), true);

ensureDecisionIntelligenceSchema();
const syntheticId = Date.now();
const receiptInsert = db.prepare(`
  INSERT INTO decision_receipts (
    decision_id, candidate_id, mint, verdict, confidence, route, mode,
    created_at_ms, version, planned_tp_percent, planned_sl_percent, planned_rr,
    snapshot_json, receipt_hash
  ) VALUES (?, ?, ?, 'PASS', 0, 'trending', 'research', ?, 'unit', 60, -20, 3, ?, ?)
`).run(
  -syntheticId,
  syntheticId,
  `hardening-${syntheticId}`,
  syntheticId,
  JSON.stringify({
    token: { mint: `hardening-${syntheticId}` },
    signals: { route: 'trending' },
    metrics: { liquidityUsd: 10_000 },
  }),
  `hardening-${syntheticId}`,
);
const receiptId = Number(receiptInsert.lastInsertRowid);
db.prepare(`
  INSERT INTO decision_execution_probes (receipt_id, status, requested_at_ms, sim_notional_sol, token_amount_raw)
  VALUES (?, 'ready', ?, 0.1, '1000')
`).run(receiptId, syntheticId);
db.prepare(`
  INSERT INTO decision_outcome_observations
    (receipt_id, horizon_ms, due_at_ms, observed_at_ms, status, r_multiple)
  VALUES (?, 120000, ?, ?, 'ready', 3.2)
`).run(receiptId, syntheticId + 120_000, syntheticId + 120_000);
db.prepare(`
  INSERT INTO decision_outcomes
    (receipt_id, finalized_at_ms, final_horizon_ms, final_r, sampled_mfe_r, sampled_mae_r, classification, data_quality, summary_json)
  VALUES (?, ?, 120000, 3.2, 3.2, -0.2, 'FALSE_NEGATIVE_RUNNER', 'complete_sampled_horizons', '{}')
`).run(receiptId, syntheticId + 120_000);
assert(counterfactualOutcomeRecords(100).some(row => row.id === receiptId && row.counterfactual));
assert(counterfactualSurvivalRecords({ limit: 100 }).some(row => row.id === receiptId && row.survived));
db.prepare('DELETE FROM decision_outcomes WHERE receipt_id = ?').run(receiptId);
db.prepare('DELETE FROM decision_outcome_observations WHERE receipt_id = ?').run(receiptId);
db.prepare('DELETE FROM decision_execution_probes WHERE receipt_id = ?').run(receiptId);
db.prepare('DELETE FROM decision_receipts WHERE id = ?').run(receiptId);

ensureControlPlaneSchema();
const originalEnabled = setting('release_rollback_enabled', '0');
const originalCurrent = setting('release_current_label', 'v33');
const originalParent = setting('release_parent_label', 'v32');
db.prepare('DELETE FROM release_rollback_requests').run();
setSetting('release_rollback_enabled', '1');
setSetting('release_current_label', 'v33');
setSetting('release_parent_label', 'v32');
const request = requestReleaseRollback({ configVersion: 33, reason: 'unit test' });
assert.equal(request.requested, true);
assert.equal(pendingReleaseRollback().to_release, 'v32');
db.prepare('DELETE FROM release_rollback_requests').run();
setSetting('release_rollback_enabled', originalEnabled);
setSetting('release_current_label', originalCurrent);
setSetting('release_parent_label', originalParent);

const releaseRoot = mkdtempSync(join(tmpdir(), 'angel-release-test-'));
try {
  for (const label of ['v32', 'v33']) {
    const directory = join(releaseRoot, 'releases', label);
    mkdirSync(join(directory, 'src'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(join(directory, 'index.js'), '');
    writeFileSync(join(directory, 'src', 'app.js'), '');
  }
  const manager = resolve('scripts/release_manager.sh');
  const env = { ...process.env, ANGEL_RELEASE_ROOT: releaseRoot };
  execFileSync(manager, ['activate', 'v32'], { env });
  execFileSync(manager, ['activate', 'v33'], { env });
  assert.equal(readlinkSync(join(releaseRoot, 'current')), join(releaseRoot, 'releases', 'v33'));
  execFileSync(manager, ['rollback'], { env });
  assert.equal(readlinkSync(join(releaseRoot, 'current')), join(releaseRoot, 'releases', 'v32'));
} finally {
  rmSync(releaseRoot, { recursive: true, force: true });
}

console.log('[v33-hardening] gap-aware replay, per-arm outcomes, late evidence, and atomic release rollback verified');
