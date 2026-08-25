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

function blockerLines(stage, max = 5) {
  const rows = stage?.hardBlockers || [];
  if (!rows.length) return ['• none'];
  return rows.slice(0, max).map(row => `• ${escapeHtml(row.label)}: ${escapeHtml(String(row.value ?? '—'))} (${escapeHtml(String(row.threshold ?? 'required'))})`);
}

export function formatReadinessHtml(report) {
  const evidence = report?.evidence || {};
  const evaluation = report?.evaluation || {};
  const research = evidence.research || {};
  const shadow = evidence.shadow || {};
  const execution = evidence.execution || {};
  const decisions = evidence.decisions || {};
  const safety = evidence.safety || {};
  const current = evaluation.currentStage || {};

  return [
    `🛡️ <b>ANGEL PRE-LIVE READINESS</b>`,
    `Mode: <b>${escapeHtml(evidence.currentMode || 'unknown')}</b> · Window: ${(Number(report?.windowMs || 0) / 86_400_000).toFixed(1)}d`,
    `Current gate: ${statusIcon(current)} <b>${escapeHtml(current.status || 'NOT_READY')}</b> · score <b>${Number(current.score || 0)}/100</b>`,
    '',
    '<b>Stage gates</b>',
    `${statusIcon(evaluation.researchToShadow)} Research → Shadow: ${escapeHtml(evaluation.researchToShadow?.status || 'NOT_READY')} (${evaluation.researchToShadow?.score || 0}/100)`,
    `${statusIcon(evaluation.shadowToConfirm)} Shadow → Confirm: ${escapeHtml(evaluation.shadowToConfirm?.status || 'NOT_READY')} (${evaluation.shadowToConfirm?.score || 0}/100)`,
    `${statusIcon(evaluation.confirmToLiveConsideration)} Confirm → Live consideration: ${escapeHtml(evaluation.confirmToLiveConsideration?.status || 'NOT_READY')} (${evaluation.confirmToLiveConsideration?.score || 0}/100)`,
    '',
    '<b>Research evidence</b>',
    `Closed ${research.closedTrades || 0} · span ${finite(research.evidenceSpanHours) == null ? '—' : `${Number(research.evidenceSpanHours).toFixed(1)}h`} · expectancy ${r(research.expectancyR)} · PF ${pf(research)} · max DD ${r(research.maxDrawdownR == null ? null : -Math.abs(Number(research.maxDrawdownR)))}`,
    `R coverage ${pct(research.realizedRCoverage)} · entry executable ${pct(execution.entryExecutionCoverage)} · Exit V3 ${pct(execution.exitV3Coverage)} · pending exits ${execution.pendingExitSettlements || 0}`,
    `Median quote deterioration ${rawPct(execution.medianEntryQuoteDeteriorationPct)} · roundtrip spread ${rawPct(execution.medianRoundtripSpreadPct)}`,
    '',
    '<b>Decision quality</b>',
    `Finalized ${decisions.finalizedOutcomes || 0}/${decisions.totalReceipts || 0} · probes ${pct(decisions.probeReadyRate)} · BUY false-positive ${pct(decisions.falsePositiveRate)} · missed-runner ${pct(decisions.missedRunnerRate)}`,
    '',
    '<b>Shadow evidence</b>',
    `Closed ${shadow.closedTrades || 0} · span ${finite(shadow.evidenceSpanHours) == null ? '—' : `${Number(shadow.evidenceSpanHours).toFixed(1)}h`} · expectancy ${r(shadow.expectancyR)} · PF ${pf(shadow)} · max DD ${r(shadow.maxDrawdownR == null ? null : -Math.abs(Number(shadow.maxDrawdownR)))}`,
    '',
    '<b>Money-grade safety</b>',
    `Blockers ${safety.blockerCount ?? '—'} · circuit ${safety.circuitOpen ? 'OPEN' : 'CLOSED'} · unresolved ${safety.unresolvedExecutions ?? '—'} · reservations ${safety.activeReservations ?? '—'} · DB durability ${safety.pragmaHealthy ? 'OK' : 'CHECK'}`,
    '',
    '<b>Current hard blockers</b>',
    ...blockerLines(current),
    '',
    '<i>Readiness is evidence eligibility only. It cannot approve, enable, sign, or broadcast Live. Live authority remains with the authenticated human owner.</i>',
  ].join('\n');
}
