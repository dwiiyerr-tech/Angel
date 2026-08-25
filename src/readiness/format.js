import { escapeHtml } from '../format.js';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value) {
  const n = finite(value);
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`;
}

function rawPct(value) {
  const n = finite(value);
  return n == null ? '—' : `${n.toFixed(2)}%`;
}

function r(value) {
  const n = finite(value);
  return n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
}

function pf(performance) {
  if (performance?.profitFactorInfinite) return '∞';
  const n = finite(performance?.profitFactorR);
  return n == null ? '—' : n.toFixed(2);
}

function statusIcon(stage) {
  return stage?.eligible ? '✅' : '⛔';
}

function blockerLines(stage, max = 6) {
  const rows = stage?.hardBlockers || [];
  if (!rows.length) return ['• none'];
  return rows.slice(0, max).map(row => `• ${escapeHtml(row.label)}: ${escapeHtml(String(row.value ?? '—'))} (${escapeHtml(String(row.threshold ?? 'required'))})`);
}

function warningLines(stage, max = 4) {
  const rows = stage?.warnings || [];
  if (!rows.length) return ['• none'];
  return rows.slice(0, max).map(row => `• ${escapeHtml(row.label)}: ${escapeHtml(String(row.value ?? '—'))} (${escapeHtml(String(row.threshold ?? 'preferred'))})`);
}

export function formatReadinessHtml(report) {
  const evidence = report?.evidence || {};
  const evaluation = report?.evaluation || {};
  const paper = evidence.paper || evidence.research || {};
  const execution = evidence.execution || {};
  const decisions = evidence.decisions || {};
  const safety = evidence.safety || {};
  const gate = evaluation.paperToLiveConsideration || evaluation.currentStage || {};

  return [
    '🛡️ <b>ANGEL PAPER → LIVE READINESS</b>',
    `Mode: <b>${escapeHtml(String(evidence.currentMode || 'paper').toUpperCase())}</b> · Window: ${(Number(report?.windowMs || 0) / 86_400_000).toFixed(1)}d`,
    `Gate: ${statusIcon(gate)} <b>${escapeHtml(gate.status || 'NOT_READY')}</b> · score <b>${Number(gate.score || 0)}/100</b>`,
    '',
    '<b>Paper evidence</b>',
    `Closed ${paper.closedTrades || 0} · span ${finite(paper.evidenceSpanHours) == null ? '—' : `${Number(paper.evidenceSpanHours).toFixed(1)}h`} · expectancy ${r(paper.expectancyR)} · PF ${pf(paper)} · max DD ${r(paper.maxDrawdownR == null ? null : -Math.abs(Number(paper.maxDrawdownR)))}`,
    `Native R coverage ${pct(paper.realizedRCoverage)} · executable entry ${pct(execution.entryExecutionCoverage)} · realistic exit ${pct(execution.exitV3Coverage)} · pending exits ${execution.pendingExitSettlements || 0}`,
    `Median quote deterioration ${rawPct(execution.medianEntryQuoteDeteriorationPct)} · roundtrip spread ${rawPct(execution.medianRoundtripSpreadPct)}`,
    '',
    '<b>Decision quality</b>',
    `Finalized ${decisions.finalizedOutcomes || 0}/${decisions.totalReceipts || 0} · probes ${pct(decisions.probeReadyRate)} · BUY false-positive ${pct(decisions.falsePositiveRate)} · missed-runner ${pct(decisions.missedRunnerRate)}`,
    '',
    '<b>Live safety state</b>',
    `Blockers ${safety.blockerCount ?? '—'} · circuit ${safety.circuitOpen ? 'OPEN' : 'CLOSED'} · unresolved ${safety.unresolvedExecutions ?? '—'} · reservations ${safety.activeReservations ?? '—'} · DB durability ${safety.pragmaHealthy ? 'OK' : 'CHECK'}`,
    '',
    '<b>Hard blockers</b>',
    ...blockerLines(gate),
    '',
    '<b>Warnings</b>',
    ...warningLines(gate),
    '',
    '<i>READY_FOR_LIVE_REVIEW only means the Paper evidence is eligible for owner review. It never approves, enables, signs, or broadcasts Live.</i>',
  ].join('\n');
}
