import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short } from '../format.js';
import { ensureDecisionIntelligenceSchema } from './schema.js';

function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtProbability(value) {
  const n = finite(value);
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`;
}

function fmtR(value) {
  const n = finite(value);
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}R`;
}

function fmtMs(value) {
  const n = finite(value);
  if (n == null) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function horizonLabel(ms) {
  const minutes = Number(ms) / 60_000;
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function loadDecisionReceiptDetails(receiptOrId) {
  ensureDecisionIntelligenceSchema();
  const receipt = typeof receiptOrId === 'object'
    ? receiptOrId
    : db.prepare('SELECT * FROM decision_receipts WHERE id = ?').get(Number(receiptOrId));
  if (!receipt) return null;
  const probe = db.prepare('SELECT * FROM decision_execution_probes WHERE receipt_id = ?').get(receipt.id) || null;
  const observations = db.prepare(`
    SELECT * FROM decision_outcome_observations
    WHERE receipt_id = ? ORDER BY horizon_ms ASC
  `).all(receipt.id);
  const outcome = db.prepare('SELECT * FROM decision_outcomes WHERE receipt_id = ?').get(receipt.id) || null;
  return {
    receipt,
    snapshot: safeJson(receipt.snapshot_json, {}) || {},
    probe: probe ? { ...probe, profile: safeJson(probe.profile_json, null) } : null,
    observations: observations.map(row => ({ ...row, quote: safeJson(row.quote_json, null) })),
    outcome: outcome ? { ...outcome, summary: safeJson(outcome.summary_json, null) } : null,
  };
}

export function latestDecisionReceiptDetailsByMint(mint) {
  ensureDecisionIntelligenceSchema();
  const receipt = db.prepare(`
    SELECT * FROM decision_receipts WHERE mint = ?
    ORDER BY created_at_ms DESC, id DESC LIMIT 1
  `).get(String(mint || ''));
  return receipt ? loadDecisionReceiptDetails(receipt) : null;
}

export function formatDecisionReceiptHtml(details) {
  if (!details) return 'Decision receipt not found.';
  const { receipt, snapshot, probe, observations, outcome } = details;
  const safety = snapshot.safety || {};
  const metrics = snapshot.metrics || {};
  const quality = snapshot.quality || {};
  const runner = snapshot.runner || {};
  const route = snapshot.routeEdge || {};
  const combined = snapshot.combinedEdge || {};
  const decision = snapshot.decision || {};
  const source = snapshot.source || 'unknown';
  const safetyLabel = safety.passed === false ? 'REJECT' : safety.passed === true ? 'PASS' : 'UNKNOWN';
  const probeReady = probe?.status === 'ready';
  const executionLines = probeReady ? [
    `Probe: <b>READY</b> · Notional: ${fmtSol(probe.sim_notional_sol)} SOL`,
    `Decision→probe: ${fmtMs(probe.decision_to_probe_ms)} · quote→fill: ${fmtMs(probe.quote_to_fill_latency_ms)}`,
    `Quote deterioration: ${finite(probe.quote_deterioration_pct) == null ? '—' : fmtPct(probe.quote_deterioration_pct)} · roundtrip spread: ${finite(probe.roundtrip_spread_pct) == null ? '—' : fmtPct(probe.roundtrip_spread_pct)}`,
    `Size impact: ${finite(probe.size_impact_pct) == null ? '—' : fmtPct(probe.size_impact_pct)} · slippage tolerance: ${finite(probe.slippage_tolerance_bps) == null ? '—' : `${Number(probe.slippage_tolerance_bps)} bps`}`,
    `Modeled fees: entry ${finite(probe.entry_fee_sol) == null ? '—' : `${fmtSol(probe.entry_fee_sol)} SOL`} · exit ${finite(probe.expected_exit_fee_sol) == null ? '—' : `${fmtSol(probe.expected_exit_fee_sol)} SOL`}`,
  ] : [
    `Probe: <b>${escapeHtml(String(probe?.status || 'missing').toUpperCase())}</b>${probe?.error ? ` · ${escapeHtml(String(probe.error).slice(0, 180))}` : ''}`,
  ];

  const observationLines = observations.map(row => {
    if (row.status === 'ready') {
      return `${horizonLabel(row.horizon_ms)}: ${fmtR(row.r_multiple)} · ${finite(row.pnl_percent) == null ? '—' : fmtPct(row.pnl_percent)} · exit ${finite(row.out_sol) == null ? '—' : `${fmtSol(row.out_sol)} SOL`}`;
    }
    return `${horizonLabel(row.horizon_ms)}: ${escapeHtml(String(row.status))}${row.error ? ` (${escapeHtml(String(row.error).slice(0, 80))})` : ''}`;
  });

  return [
    `🧾 <b>ANGEL DECISION RECEIPT #${receipt.id}</b>`,
    '',
    `Decision: <b>${escapeHtml(receipt.verdict)}</b> · Confidence: <b>${finite(receipt.confidence) == null ? '—' : fmtPct(receipt.confidence)}</b>`,
    `Mode: <b>${escapeHtml(receipt.mode)}</b> · Source: <b>${escapeHtml(source)}</b>`,
    `Route: <b>${escapeHtml(receipt.route || 'unknown')}</b>`,
    `Token: <b>${escapeHtml(snapshot.token?.symbol || snapshot.token?.name || short(receipt.mint))}</b> · <code>${escapeHtml(receipt.mint)}</code>`,
    `Receipt hash: <code>${escapeHtml(receipt.receipt_hash.slice(0, 16))}…</code>`,
    '',
    '<b>Decision-time market</b>',
    `Mcap: ${fmtUsd(metrics.marketCapUsd)} · Liq: ${fmtUsd(metrics.liquidityUsd)} · Holders: ${metrics.holderCount ?? '?'}`,
    `Top20: ${finite(snapshot.holders?.top20Percent) == null ? '—' : fmtPct(snapshot.holders.top20Percent)} · Max holder: ${finite(snapshot.holders?.maxHolderPercent) == null ? '—' : fmtPct(snapshot.holders.maxHolderPercent)}`,
    '',
    '<b>Safety / Edge</b>',
    `Contract Safety: <b>${safetyLabel}</b>`,
    `Quality: ${finite(quality.score) == null ? '—' : `${Number(quality.score).toFixed(0)}/100`} · Momentum: ${finite(snapshot.momentum?.score) == null ? '—' : Number(snapshot.momentum.score).toFixed(3)}`,
    `P(runner): ${fmtProbability(runner.probability)} · sample: ${runner.sample ?? runner.totalSample ?? 0} · ${escapeHtml(runner.quality || 'LOW')}`,
    `Route P(win): ${fmtProbability(route.pWin)} · Expected R: ${fmtR(route.expectedR)} · sample: ${route.routeSample ?? route.sample ?? 0}`,
    `Combined opportunity: ${fmtProbability(combined.opportunityProbability)} · evidence: ${escapeHtml(combined.evidenceQuality || 'LOW')}`,
    '',
    '<b>Risk plan</b>',
    `TP: ${finite(receipt.planned_tp_percent) == null ? '—' : fmtPct(receipt.planned_tp_percent)} · SL: ${finite(receipt.planned_sl_percent) == null ? '—' : fmtPct(receipt.planned_sl_percent)} · Planned R:R: ${finite(receipt.planned_rr) == null ? '—' : `1:${Number(receipt.planned_rr).toFixed(2)}`}`,
    '',
    '<b>Executable market probe</b>',
    ...executionLines,
    '',
    '<b>Counterfactual outcome</b>',
    ...(observationLines.length ? observationLines : ['No Research outcome schedule for this mode.']),
    outcome ? `Classification: <b>${escapeHtml(outcome.classification)}</b> · sampled MFE ${fmtR(outcome.sampled_mfe_r)} · MAE ${fmtR(outcome.sampled_mae_r)} · final ${fmtR(outcome.final_r)}` : 'Classification: pending',
    '',
    decision.reason ? `<b>Decision reason</b>\n${escapeHtml(String(decision.reason).slice(0, 700))}` : null,
    '<i>Receipt core is decision-time evidence only. Later probes/outcomes are stored separately and never rewrite what was known at decision time.</i>',
  ].filter(Boolean).join('\n');
}

function cleanNumbers(values) {
  return values.map(finite).filter(value => value != null);
}

function mean(values) {
  const clean = cleanNumbers(values);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = cleanNumbers(values).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

export function decisionIntelligenceSummary(windowMs = 24 * 60 * 60 * 1000) {
  ensureDecisionIntelligenceSchema();
  const since = Date.now() - Math.max(5 * 60_000, Number(windowMs) || 24 * 60 * 60 * 1000);
  const rows = db.prepare(`
    SELECT r.*, p.status AS probe_status, p.quote_deterioration_pct,
           p.roundtrip_spread_pct, p.quote_to_fill_latency_ms, p.decision_to_probe_ms,
           o.final_r, o.sampled_mfe_r, o.sampled_mae_r, o.classification, o.data_quality
    FROM decision_receipts r
    LEFT JOIN decision_execution_probes p ON p.receipt_id = r.id
    LEFT JOIN decision_outcomes o ON o.receipt_id = r.id
    WHERE r.created_at_ms >= ?
    ORDER BY r.created_at_ms ASC
  `).all(since);

  const verdicts = { BUY: 0, WATCH: 0, PASS: 0 };
  const classifications = {};
  const routes = new Map();
  for (const row of rows) {
    if (verdicts[row.verdict] != null) verdicts[row.verdict] += 1;
    if (row.classification) classifications[row.classification] = (classifications[row.classification] || 0) + 1;
    const key = row.route || 'unknown';
    if (!routes.has(key)) routes.set(key, { route: key, count: 0, outcomes: 0, finalR: [], mfeR: [], missedRunners: 0 });
    const bucket = routes.get(key);
    bucket.count += 1;
    const finalR = finite(row.final_r);
    if (finalR != null) {
      bucket.outcomes += 1;
      bucket.finalR.push(finalR);
    }
    const mfeR = finite(row.sampled_mfe_r);
    if (mfeR != null) bucket.mfeR.push(mfeR);
    if (['FALSE_NEGATIVE_RUNNER', 'WATCH_MISSED_RUNNER'].includes(row.classification)) bucket.missedRunners += 1;
  }

  return {
    sinceMs: since,
    windowMs,
    total: rows.length,
    verdicts,
    probes: {
      ready: rows.filter(row => row.probe_status === 'ready').length,
      pending: rows.filter(row => ['pending', 'running', 'degraded'].includes(row.probe_status)).length,
      failed: rows.filter(row => row.probe_status === 'failed').length,
      medianDecisionToProbeMs: median(rows.map(row => row.decision_to_probe_ms)),
      medianQuoteToFillMs: median(rows.map(row => row.quote_to_fill_latency_ms)),
      medianQuoteDeteriorationPct: median(rows.map(row => row.quote_deterioration_pct)),
      medianRoundtripSpreadPct: median(rows.map(row => row.roundtrip_spread_pct)),
    },
    outcomes: {
      finalized: rows.filter(row => row.classification).length,
      averageFinalR: mean(rows.map(row => row.final_r)),
      medianFinalR: median(rows.map(row => row.final_r)),
      classifications,
    },
    routes: [...routes.values()].map(bucket => ({
      route: bucket.route,
      count: bucket.count,
      outcomes: bucket.outcomes,
      averageFinalR: mean(bucket.finalR),
      medianFinalR: median(bucket.finalR),
      medianSampledMfeR: median(bucket.mfeR),
      missedRunners: bucket.missedRunners,
    })).sort((a, b) => (b.averageFinalR ?? -Infinity) - (a.averageFinalR ?? -Infinity)),
  };
}

export function recentDecisionReceipts(limit = 10) {
  ensureDecisionIntelligenceSchema();
  return db.prepare(`
    SELECT r.id, r.created_at_ms, r.mint, r.verdict, r.confidence, r.route, r.mode,
           p.status AS probe_status, o.final_r, o.classification
    FROM decision_receipts r
    LEFT JOIN decision_execution_probes p ON p.receipt_id = r.id
    LEFT JOIN decision_outcomes o ON o.receipt_id = r.id
    ORDER BY r.created_at_ms DESC, r.id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(50, Number(limit) || 10)));
}
