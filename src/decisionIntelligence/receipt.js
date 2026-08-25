import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { configuredTradingMode } from '../research/policy.js';
import { plannedRiskReward } from '../research/rr.js';
import { now } from '../utils.js';
import {
  DECISION_OUTCOME_HORIZONS_MS,
  DECISION_RECEIPT_VERSION,
  ensureDecisionIntelligenceSchema,
} from './schema.js';

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}

function canonical(value) {
  return JSON.stringify(sortObject(value));
}

function sanitizeDecision(decision = {}) {
  const copy = { ...decision };
  if (copy.selected_row) {
    copy.selected_row = {
      id: copy.selected_row.id ?? null,
      mint: copy.selected_row.candidate?.token?.mint ?? null,
    };
  }
  return copy;
}

function decisionSource(decision = {}) {
  if (decision.fast_hunter) return 'fast_hunter';
  if (decision.research_hunter_policy) return 'research_hunter';
  if (decision.raw) return 'llm';
  return 'deterministic';
}

export function buildDecisionKnowledgeSnapshot({ candidateId, candidate, decision, mode }) {
  const tp = Number(decision?.suggested_tp_percent);
  const sl = Number(decision?.suggested_sl_percent);
  const plannedRr = plannedRiskReward(tp, sl);
  const edge = candidate?.edge || null;
  return {
    version: DECISION_RECEIPT_VERSION,
    capturedAtMs: now(),
    knowledgeBoundary: 'decision_time_only',
    candidateId,
    mode,
    source: decisionSource(decision),
    token: candidate?.token || null,
    signals: candidate?.signals || null,
    metrics: candidate?.metrics || null,
    safety: candidate?.contractSafety || null,
    holders: candidate?.holders || null,
    jupiterAsset: candidate?.jupiterAsset || null,
    quality: edge?.quality || null,
    momentum: {
      score: candidate?.filters?.momentumScore ?? null,
      preferred: candidate?.filters?.momentumPreferred ?? null,
    },
    runner: edge?.runner || null,
    routeEdge: edge?.route || null,
    combinedEdge: edge?.combined || null,
    filters: candidate?.filters || null,
    riskFlags: candidate?.riskFlags || [],
    dataQuality: candidate?.dataQuality || null,
    marketContext: {
      trending: candidate?.trending || null,
      feeClaim: candidate?.feeClaim || null,
      graduation: candidate?.graduation || null,
      pregradToken: candidate?.pregradToken || null,
      jupiterAsset: candidate?.jupiterAsset || null,
      chart: candidate?.chart || null,
      savedWalletExposure: candidate?.savedWalletExposure || null,
      twitterNarrative: candidate?.twitterNarrative || null,
      volumeAcceleration: candidate?.volumeAcceleration || null,
    },
    decision: sanitizeDecision(decision),
    riskPlan: {
      takeProfitPercent: Number.isFinite(tp) ? tp : null,
      stopLossPercent: Number.isFinite(sl) ? sl : null,
      plannedRr: Number.isFinite(plannedRr) ? plannedRr : null,
    },
  };
}

export function createDecisionReceipt({ decisionId, candidateId, candidate, decision, mode = configuredTradingMode() }) {
  ensureDecisionIntelligenceSchema();
  const verdict = String(decision?.verdict || '').toUpperCase();
  if (!['BUY', 'WATCH', 'PASS'].includes(verdict)) return null;

  const snapshot = buildDecisionKnowledgeSnapshot({ candidateId, candidate, decision, mode });
  const snapshotJson = canonical(snapshot);
  const receiptHash = createHash('sha256').update(snapshotJson).digest('hex');
  const tp = Number(decision?.suggested_tp_percent);
  const sl = Number(decision?.suggested_sl_percent);
  const plannedRr = plannedRiskReward(tp, sl);
  const createdAtMs = Number(snapshot.capturedAtMs);
  const route = candidate?.signals?.route || candidate?.signals?.label || null;

  const result = db.prepare(`
    INSERT OR IGNORE INTO decision_receipts (
      decision_id, candidate_id, mint, verdict, confidence, route, mode,
      created_at_ms, version, planned_tp_percent, planned_sl_percent, planned_rr,
      snapshot_json, receipt_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decisionId,
    candidateId,
    candidate?.token?.mint || '',
    verdict,
    Number(decision?.confidence || 0),
    route,
    mode,
    createdAtMs,
    DECISION_RECEIPT_VERSION,
    Number.isFinite(tp) ? tp : null,
    Number.isFinite(sl) ? sl : null,
    Number.isFinite(plannedRr) ? plannedRr : null,
    snapshotJson,
    receiptHash,
  );

  const receipt = result.changes === 1
    ? db.prepare('SELECT * FROM decision_receipts WHERE id = ?').get(Number(result.lastInsertRowid))
    : db.prepare('SELECT * FROM decision_receipts WHERE decision_id = ?').get(decisionId);
  if (!receipt) return null;

  const probeStatus = mode === 'research' ? 'pending' : 'not_applicable_mode';
  db.prepare(`
    INSERT OR IGNORE INTO decision_execution_probes
      (receipt_id, status, requested_at_ms, attempt_count)
    VALUES (?, ?, ?, 0)
  `).run(receipt.id, probeStatus, createdAtMs);

  if (mode === 'research') {
    const insertObservation = db.prepare(`
      INSERT OR IGNORE INTO decision_outcome_observations
        (receipt_id, horizon_ms, due_at_ms, status, attempt_count)
      VALUES (?, ?, ?, 'pending', 0)
    `);
    for (const horizonMs of DECISION_OUTCOME_HORIZONS_MS) {
      insertObservation.run(receipt.id, horizonMs, createdAtMs + horizonMs);
    }
  }

  return receipt;
}

export function decisionReceiptById(id) {
  ensureDecisionIntelligenceSchema();
  return db.prepare('SELECT * FROM decision_receipts WHERE id = ?').get(Number(id)) || null;
}

export function decisionReceiptByDecisionId(decisionId) {
  ensureDecisionIntelligenceSchema();
  return db.prepare('SELECT * FROM decision_receipts WHERE decision_id = ?').get(Number(decisionId)) || null;
}

export function latestDecisionReceiptByMint(mint) {
  ensureDecisionIntelligenceSchema();
  return db.prepare(`
    SELECT * FROM decision_receipts
    WHERE mint = ?
    ORDER BY created_at_ms DESC, id DESC
    LIMIT 1
  `).get(String(mint || '')) || null;
}
