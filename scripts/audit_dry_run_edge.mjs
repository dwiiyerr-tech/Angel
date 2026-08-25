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
    AND (
      COALESCE(p.execution_mode, 'dry_run') = 'dry_run'
      OR (
        p.execution_mode = 'shadow_live'
        AND json_extract(p.snapshot_json, '$.shadowLiveCompatible') = 1
        AND json_extract(p.snapshot_json, '$.entryQuoteMode') = 'position_sized'
      )
    )
    AND json_extract(p.snapshot_json, '$.simulatorVersion') = ?
  ORDER BY p.opened_at_ms
`).all(cutoff, DRY_RUN_SIMULATOR_VERSION);
const ids = positions.map(row => Number(row.id));
const trades = ids.length
  ? db.prepare(`SELECT position_id, side FROM dry_run_trades WHERE position_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  : [];
const quality = validateDryRunRows(positions, trades, { expectedSimulatorVersion: DRY_RUN_SIMULATOR_VERSION });
const tuning = tuneAdmissionEdge(positions.map(edgeRecord));
const buyFunnel = db.prepare(`
  SELECT action, COUNT(*) AS count
  FROM decision_logs
  WHERE at_ms >= ? AND verdict = 'BUY'
  GROUP BY action
  ORDER BY count DESC
`).all(cutoff);
const buyFunnelTotals = buyFunnel.reduce((acc, row) => {
  acc.totalBuyEvents += Number(row.count);
  if (['dry_run_entry', 'shadow_live_entry_simulated'].includes(row.action)) acc.executedEntries += Number(row.count);
  else acc.notExecutedEvents += Number(row.count);
  return acc;
}, { totalBuyEvents: 0, executedEntries: 0, notExecutedEvents: 0 });

console.log(JSON.stringify({
  window: formatWindow(windowMs),
  simulatorVersion: DRY_RUN_SIMULATOR_VERSION,
  fromMs: cutoff,
  toMs: Date.now(),
  quality,
  buyFunnel: { ...buyFunnelTotals, byAction: buyFunnel },
  baseline: tuning.baseline,
  sample: tuning.sample,
  recommendation: quality.learningEligible ? tuning.recommended : null,
  topHoldoutCandidates: tuning.proposals.slice(0, 5),
  advisoryOnly: true,
}, null, 2));

if (!quality.valid) process.exitCode = 2;
