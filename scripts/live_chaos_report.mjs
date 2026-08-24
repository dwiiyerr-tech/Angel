#!/usr/bin/env node
import { db, initDb } from '../src/db/connection.js';
import { ensureLiveSafetySchema } from '../src/db/liveSafety.js';

initDb();
ensureLiveSafetySchema();

const jsonMode = process.argv.includes('--json');
const mode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
const unresolved = db.prepare(`
  SELECT id, mint, side, status, position_id, signature, error, created_at_ms, updated_at_ms
  FROM execution_operations
  WHERE status IN ('pending', 'outcome_unknown')
  ORDER BY updated_at_ms ASC
`).all();
const reservations = db.prepare(`
  SELECT r.id, r.operation_id, r.mint, r.size_sol, r.status, r.created_at_ms,
         o.status AS operation_status, o.signature
  FROM live_capital_reservations r
  LEFT JOIN execution_operations o ON o.id = r.operation_id
  WHERE r.status = 'active'
  ORDER BY r.created_at_ms ASC
`).all();
const unknownPositions = db.prepare(`
  SELECT id, mint, status, size_sol, token_amount_raw, entry_signature, exit_signature
  FROM dry_run_positions
  WHERE execution_mode = 'live'
    AND status IN ('entry_unknown', 'exit_unknown', 'partial_exit_unknown')
  ORDER BY id ASC
`).all();
const openInventoryAnomalies = db.prepare(`
  SELECT id, mint, status, token_amount_raw, entry_signature
  FROM dry_run_positions
  WHERE execution_mode = 'live' AND status = 'open'
    AND (
      token_amount_raw IS NULL OR token_amount_raw = '' OR token_amount_raw = '0'
      OR entry_signature IS NULL OR entry_signature = ''
    )
  ORDER BY id ASC
`).all();
const activeBuyWithoutReservation = db.prepare(`
  SELECT o.id, o.mint, o.status, o.signature
  FROM execution_operations o
  LEFT JOIN live_capital_reservations r
    ON r.operation_id = o.id AND r.status = 'active'
  WHERE o.side = 'buy' AND COALESCE(o.execution_mode, 'live') = 'live'
    AND o.status IN ('pending', 'outcome_unknown')
    AND o.position_id IS NULL
    AND r.id IS NULL
  ORDER BY o.id ASC
`).all();
const reservationWithoutActiveOperation = reservations.filter(row => !['pending', 'outcome_unknown'].includes(row.operation_status));
const duplicateLiveMint = db.prepare(`
  SELECT mint, COUNT(*) AS count
  FROM dry_run_positions
  WHERE execution_mode = 'live'
    AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
  GROUP BY mint HAVING COUNT(*) > 1
`).all();
const completedWithoutFinalityEvidence = db.prepare(`
  SELECT id, mint, side, signature, finalized_at_ms
  FROM execution_operations
  WHERE COALESCE(execution_mode, 'live') = 'live' AND status = 'completed'
    AND (signature IS NULL OR signature = '' OR finalized_at_ms IS NULL)
  ORDER BY id DESC LIMIT 50
`).all();

const pragmas = {
  journalMode: db.pragma('journal_mode', { simple: true }),
  synchronous: Number(db.pragma('synchronous', { simple: true })),
  busyTimeoutMs: Number(db.pragma('busy_timeout', { simple: true })),
  foreignKeys: Number(db.pragma('foreign_keys', { simple: true })),
};

const blockerCount = unresolved.length
  + reservations.length
  + unknownPositions.length
  + openInventoryAnomalies.length
  + activeBuyWithoutReservation.length
  + reservationWithoutActiveOperation.length
  + duplicateLiveMint.length;

const report = {
  generatedAt: new Date().toISOString(),
  tradingMode: mode,
  verdict: blockerCount === 0 ? 'CLEAR' : 'BLOCK_LIVE',
  blockerCount,
  pragmas,
  unresolvedExecutions: {
    count: unresolved.length,
    signatureMissing: unresolved.filter(row => !row.signature).length,
    rows: unresolved,
  },
  activeReservations: {
    count: reservations.length,
    exposureSol: reservations.reduce((sum, row) => sum + Number(row.size_sol || 0), 0),
    rows: reservations,
  },
  unknownPositions,
  openInventoryAnomalies,
  activeBuyWithoutReservation,
  reservationWithoutActiveOperation,
  duplicateLiveMint,
  legacyOrIncompleteCompletedFinalityEvidence: completedWithoutFinalityEvidence,
};

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Angel Live Safety Chaos Report V3');
  console.log('=================================');
  console.log(`Verdict: ${report.verdict}`);
  console.log(`Mode: ${mode}`);
  console.log(`Blockers: ${blockerCount}`);
  console.log(`SQLite: journal=${pragmas.journalMode} synchronous=${pragmas.synchronous} busy_timeout=${pragmas.busyTimeoutMs}ms foreign_keys=${pragmas.foreignKeys}`);
  console.log(`Unresolved operations: ${unresolved.length} (${report.unresolvedExecutions.signatureMissing} missing signature)`);
  console.log(`Active reservations: ${reservations.length} / ${report.activeReservations.exposureSol.toFixed(6)} SOL`);
  console.log(`Unknown live positions: ${unknownPositions.length}`);
  console.log(`Open inventory anomalies: ${openInventoryAnomalies.length}`);
  console.log(`Active buys missing reservation: ${activeBuyWithoutReservation.length}`);
  console.log(`Broken reservation links: ${reservationWithoutActiveOperation.length}`);
  console.log(`Duplicate active live mints: ${duplicateLiveMint.length}`);
  console.log(`Completed operations lacking V2 finality metadata (legacy/warning): ${completedWithoutFinalityEvidence.length}`);
  if (blockerCount > 0) {
    console.log('\nLive must remain blocked until blocker rows are reconciled. Use --json for details.');
  }
}
