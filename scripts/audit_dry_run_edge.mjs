#!/usr/bin/env node
import { db } from '../src/db/connection.js';
import { parseWindowMs, formatWindow } from '../src/utils.js';
import { validateDryRunRows } from '../src/learning/dataQuality.js';
import { edgeRecord, tuneAdmissionEdge } from '../src/learning/edgeTuner.js';
import { DRY_RUN_SIMULATOR_VERSION } from '../src/learning/simulatorVersion.js';

const windowMs = parseWindowMs(process.argv[2] || '3d');
const cutoff = Date.now() - windowMs;
const positions = db.prepare(`
  SELECT p.*, l.confidence AS llm_confidence
  FROM dry_run_positions p
  LEFT JOIN llm_decisions l ON l.id = p.llm_decision_id
  WHERE p.status = 'closed' AND p.closed_at_ms >= ?
    AND COALESCE(p.execution_mode, 'dry_run') = 'dry_run'
    AND json_extract(p.snapshot_json, '$.simulatorVersion') = ?
  ORDER BY p.opened_at_ms
`).all(cutoff, DRY_RUN_SIMULATOR_VERSION);
const ids = positions.map(row => Number(row.id));
const trades = ids.length
  ? db.prepare(`SELECT position_id, side FROM dry_run_trades WHERE position_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  : [];
const quality = validateDryRunRows(positions, trades, { expectedSimulatorVersion: DRY_RUN_SIMULATOR_VERSION });
const tuning = tuneAdmissionEdge(positions.map(edgeRecord));

console.log(JSON.stringify({
  window: formatWindow(windowMs),
  simulatorVersion: DRY_RUN_SIMULATOR_VERSION,
  fromMs: cutoff,
  toMs: Date.now(),
  quality,
  baseline: tuning.baseline,
  sample: tuning.sample,
  recommendation: quality.learningEligible ? tuning.recommended : null,
  topHoldoutCandidates: tuning.proposals.slice(0, 5),
  advisoryOnly: true,
}, null, 2));

if (!quality.valid) process.exitCode = 2;
