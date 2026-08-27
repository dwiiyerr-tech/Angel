import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { activeStrategy, boolSetting, numSetting } from '../db/settings.js';
import { latestCandidateByMint, updateCandidateSnapshot } from '../db/candidates.js';
import { buildCandidate, filterCandidate } from './candidateBuilder.js';
import { mergeCandidateEvidence } from './signalEvidence.js';
import { candidateRoutes } from './routePolicy.js';
import { applyContractSafetyGate } from '../execution/contractSafetyGate.js';
import { momentumFilter } from './momentumFilter.js';
import { now } from '../utils.js';

let schemaReady = false;

function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function json(value) {
  try { return JSON.stringify(value ?? null); } catch { return JSON.stringify({ serializationError: true }); }
}

export function ensureEvidenceWindowSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_evidence_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_key TEXT NOT NULL UNIQUE,
      mint TEXT NOT NULL,
      route TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'observed',
      candidate_id INTEGER,
      position_id INTEGER,
      processed_at_ms INTEGER,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_candidate_evidence_mint_at
      ON candidate_evidence_events(mint, observed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidate_evidence_status_at
      ON candidate_evidence_events(status, observed_at_ms);
  `);
  schemaReady = true;
}

export function resetEvidenceWindowSchemaForTests() {
  schemaReady = false;
}

export function signalEvidenceKey(signals = {}, atMs = now()) {
  const mint = String(signals.mint || '');
  const route = String(signals.route || 'unknown');
  const signature = String(signals.signature || signals.fee?.signature || '');
  const bucket = Math.floor(Number(atMs) / 60_000);
  return createHash('sha256').update(`${mint}|${route}|${signature}|${bucket}`).digest('hex');
}

export function recordSignalEvidence(signals = {}, atMs = now()) {
  ensureEvidenceWindowSchema();
  if (!signals.mint) return null;
  const key = signalEvidenceKey(signals, atMs);
  const result = db.prepare(`
    INSERT OR IGNORE INTO candidate_evidence_events
      (evidence_key, mint, route, observed_at_ms, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, String(signals.mint), String(signals.route || 'unknown'), atMs, json(signals));
  const row = db.prepare('SELECT * FROM candidate_evidence_events WHERE evidence_key = ?').get(key);
  return row ? { ...row, isNew: result.changes === 1 } : null;
}

export function markEvidenceEventsProcessed(ids = [], candidateId, status = 'screened') {
  ensureEvidenceWindowSchema();
  const update = db.prepare(`
    UPDATE candidate_evidence_events
    SET status = ?, candidate_id = ?, processed_at_ms = ?
    WHERE id = ? AND status = 'observed'
  `);
  for (const id of [...new Set(ids.map(Number).filter(Number.isInteger))]) {
    update.run(status, Number(candidateId), now(), id);
  }
}

export function isIndependentLateRoute(signals = {}, candidate = {}) {
  const existing = new Set(candidateRoutes(candidate));
  const incoming = [...new Set([...(signals.signalRoutes || []), signals.route]
    .map(String).filter(route => route && route !== 'dual_source'))];
  return incoming.some(route => !existing.has(route));
}

function activePositionByMint(mint) {
  return db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE mint = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
    ORDER BY id DESC LIMIT 1
  `).get(mint) || null;
}

export function lateEvidenceContext(signals = {}) {
  const candidateRow = latestCandidateByMint(signals.mint);
  const position = activePositionByMint(signals.mint);
  const maxAgeMs = Math.max(30_000, numSetting('late_evidence_window_ms', 3 * 60_000));
  const recent = candidateRow && Number(candidateRow.created_at_ms) >= now() - maxAgeMs;
  return {
    candidateRow: recent ? candidateRow : null,
    position,
    independent: Boolean(recent && isIndependentLateRoute(signals, candidateRow.candidate)),
    maxAgeMs,
  };
}

export async function refreshLateEvidence(signals = {}, { eventId = null } = {}) {
  ensureEvidenceWindowSchema();
  const context = lateEvidenceContext(signals);
  if (!context.candidateRow || !context.independent) return { updated: false, reason: 'not_independent_or_outside_window' };
  const event = eventId ? db.prepare('SELECT * FROM candidate_evidence_events WHERE id = ?').get(eventId) : null;
  try {
    const incoming = await buildCandidate(signals);
    const merged = mergeCandidateEvidence(context.candidateRow.candidate, incoming);
    merged.filters = filterCandidate(merged);
    const moneyMode = context.position?.execution_mode === 'live'
      || boolSetting('paper_live_parity_enabled', true);
    await applyContractSafetyGate(merged, {
      moneyMode,
      stage: 'screening',
      fetchRugcheck: moneyMode,
    });
    const momentumVetoFloor = Number(activeStrategy().momentum_veto_floor ?? 0.1);
    await momentumFilter(merged, momentumVetoFloor);
    merged.lateEvidence = {
      version: 'persistent-evidence-window-v1',
      updatedAtMs: now(),
      eventId: event?.id || eventId,
      routes: merged.signals?.routes || [],
      sourceCount: merged.signals?.sourceCount || 1,
    };
    updateCandidateSnapshot(context.candidateRow.id, merged);
    if (context.position) {
      const payload = {
        version: 'persistent-evidence-window-v1',
        updatedAtMs: now(),
        candidateId: context.candidateRow.id,
        routes: merged.signals?.routes || [],
        sourceCount: merged.signals?.sourceCount || 1,
        domainEvidence: merged.domainEvidence || null,
        edge: merged.edge || null,
        smartMoneySignal: merged.smartMoneySignal || null,
      };
      db.prepare(`
        UPDATE dry_run_positions
        SET late_evidence_json = ?, last_evidence_at_ms = ?
        WHERE id = ?
      `).run(json(payload), payload.updatedAtMs, context.position.id);
    }
    if (event?.id) {
      db.prepare(`
        UPDATE candidate_evidence_events
        SET status = 'merged', candidate_id = ?, position_id = ?, processed_at_ms = ?, result_json = ?, error = NULL
        WHERE id = ?
      `).run(
        context.candidateRow.id,
        context.position?.id || null,
        now(),
        json({ routes: merged.signals?.routes, sourceCount: merged.signals?.sourceCount, edge: merged.edge?.admission }),
        event.id,
      );
    }
    return { updated: true, candidateId: context.candidateRow.id, positionId: context.position?.id || null, candidate: merged };
  } catch (error) {
    if (event?.id) {
      db.prepare(`
        UPDATE candidate_evidence_events SET status = 'failed', processed_at_ms = ?, error = ? WHERE id = ?
      `).run(now(), error.message, event.id);
    }
    throw error;
  }
}

export function latestLateEvidence(position = {}) {
  return safeJson(position?.late_evidence_json, null);
}
