import { db } from '../db/connection.js';
import { ensureDecisionIntelligenceSchema } from './schema.js';

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function candidateFromDecisionSnapshot(snapshotJson) {
  const snapshot = typeof snapshotJson === 'string' ? safeJson(snapshotJson, {}) : (snapshotJson || {});
  return {
    token: snapshot.token || {},
    signals: snapshot.signals || {},
    metrics: snapshot.metrics || {},
    contractSafety: snapshot.safety || null,
    holders: snapshot.holders || {},
    jupiterAsset: snapshot.jupiterAsset || snapshot.marketContext?.jupiterAsset || null,
    trending: snapshot.marketContext?.trending || null,
    feeClaim: snapshot.marketContext?.feeClaim || null,
    graduation: snapshot.marketContext?.graduation || null,
    chart: snapshot.marketContext?.chart || null,
    savedWalletExposure: snapshot.marketContext?.savedWalletExposure || { holderCount: 0, holders: [] },
    twitterNarrative: snapshot.marketContext?.twitterNarrative || null,
    volumeAcceleration: snapshot.marketContext?.volumeAcceleration || null,
    filters: snapshot.filters || {},
    riskFlags: snapshot.riskFlags || [],
    dataQuality: snapshot.dataQuality || {},
    edge: {
      quality: snapshot.quality || null,
      runner: snapshot.runner || null,
      route: snapshot.routeEdge || null,
      combined: snapshot.combinedEdge || null,
    },
  };
}

export function counterfactualOutcomeRecords(limit = 1500) {
  ensureDecisionIntelligenceSchema();
  return db.prepare(`
    SELECT r.id, r.verdict, r.route, r.snapshot_json,
           o.final_r, o.sampled_mfe_r, o.sampled_mae_r, o.classification, o.data_quality,
           (SELECT MIN(obs.horizon_ms) FROM decision_outcome_observations obs
            WHERE obs.receipt_id = r.id AND obs.status = 'ready' AND obs.r_multiple >= 3) AS first_3r_horizon_ms
    FROM decision_receipts r
    JOIN decision_outcomes o ON o.receipt_id = r.id
    JOIN decision_execution_probes p ON p.receipt_id = r.id AND p.status = 'ready'
    WHERE r.mode = 'research' AND r.verdict IN ('WATCH', 'PASS')
      AND o.final_r IS NOT NULL
    ORDER BY o.finalized_at_ms DESC
    LIMIT ?
  `).all(Math.max(1, Math.floor(limit))).map(row => ({
    ...row,
    finalR: finite(row.final_r),
    sampledMfeR: finite(row.sampled_mfe_r),
    sampledMaeR: finite(row.sampled_mae_r),
    first3rHorizonMs: finite(row.first_3r_horizon_ms),
    candidate: candidateFromDecisionSnapshot(row.snapshot_json),
    counterfactual: true,
  }));
}

export function counterfactualSurvivalRecords({ horizonMs = 120_000, limit = 1500, failureR = 1 } = {}) {
  ensureDecisionIntelligenceSchema();
  const rows = db.prepare(`
    SELECT r.id, r.verdict, r.snapshot_json, o.horizon_ms, o.r_multiple
    FROM decision_receipts r
    JOIN decision_outcome_observations o ON o.receipt_id = r.id
    JOIN decision_execution_probes p ON p.receipt_id = r.id AND p.status = 'ready'
    WHERE r.mode = 'research' AND r.verdict IN ('WATCH', 'PASS')
      AND o.status = 'ready' AND o.horizon_ms >= ? AND o.r_multiple IS NOT NULL
    ORDER BY r.created_at_ms DESC, o.horizon_ms ASC
    LIMIT ?
  `).all(Math.max(1, Number(horizonMs)), Math.max(1, Math.floor(limit * 4)));
  const seen = new Set();
  const records = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const r = finite(row.r_multiple);
    records.push({
      id: Number(row.id),
      survived: r == null ? null : r > -Math.abs(Number(failureR) || 1),
      label: r != null && r <= -Math.abs(Number(failureR) || 1) ? 'counterfactual_early_failure' : 'counterfactual_survived',
      candidate: candidateFromDecisionSnapshot(row.snapshot_json),
      counterfactual: true,
    });
    if (records.length >= limit) break;
  }
  return records;
}

export function executableDecisionPaths({ sinceMs = 0, limit = 5000 } = {}) {
  ensureDecisionIntelligenceSchema();
  const receipts = db.prepare(`
    SELECT r.*, p.status AS probe_status
    FROM decision_receipts r
    JOIN decision_execution_probes p ON p.receipt_id = r.id
    WHERE r.mode = 'research' AND p.status = 'ready' AND r.created_at_ms >= ?
    ORDER BY r.created_at_ms DESC
    LIMIT ?
  `).all(Math.max(0, Number(sinceMs) || 0), Math.max(1, Math.floor(limit)));
  const observations = db.prepare(`
    SELECT observed_at_ms, horizon_ms, r_multiple, market_json
    FROM decision_outcome_observations
    WHERE receipt_id = ? AND status = 'ready' AND r_multiple IS NOT NULL
    ORDER BY horizon_ms ASC
  `);
  return receipts.map(receipt => {
    const snapshot = safeJson(receipt.snapshot_json, {});
    return {
      receipt,
      snapshot,
      candidate: candidateFromDecisionSnapshot(snapshot),
      decision: snapshot.decision || { verdict: receipt.verdict, confidence: receipt.confidence },
      observations: observations.all(receipt.id).map(row => {
        const market = safeJson(row.market_json, null);
        const netBuyers = finite(market?.stats5m?.numNetBuyers);
        const traders = finite(market?.stats5m?.numTraders);
        return {
          atMs: Number(row.observed_at_ms || receipt.created_at_ms + row.horizon_ms),
          horizonMs: Number(row.horizon_ms),
          r: finite(row.r_multiple),
          buyerRatio: netBuyers != null && traders != null && traders > 0 ? netBuyers / traders : null,
        };
      }),
    };
  }).filter(path => path.observations.length > 0);
}
