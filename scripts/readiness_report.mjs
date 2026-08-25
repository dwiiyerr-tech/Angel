#!/usr/bin/env node
import { initDb } from '../src/db/connection.js';
import { parseWindowMs, formatWindow } from '../src/utils.js';
import { preLiveReadinessReport } from '../src/readiness/engine.js';

initDb();

const windowArg = process.argv.find(arg => /^\d+(?:\.\d+)?[mhd]$/i.test(arg)) || '7d';
const windowMs = parseWindowMs(windowArg);
const report = preLiveReadinessReport(windowMs);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const gate = report.evaluation.paperToLiveConsideration || report.evaluation.currentStage;
const paper = report.evidence.paper || report.evidence.research;
const execution = report.evidence.execution;
const safety = report.evidence.safety;

console.log('Angel Paper -> Live Readiness V2');
console.log('================================');
console.log(`Window: ${formatWindow(windowMs)}`);
console.log(`Mode: ${String(report.currentMode || 'paper').toUpperCase()}`);
console.log(`Gate: ${gate.status} (${gate.score}/100)`);
console.log(`Hard blockers: ${gate.hardBlockers.length}`);
console.log(`Warnings: ${gate.warnings.length}`);
console.log('');
console.log(`Paper: N=${paper.closedTrades}, expectancy=${paper.expectancyR == null ? 'n/a' : paper.expectancyR.toFixed(3)}R, PF=${paper.profitFactorInfinite ? 'inf' : paper.profitFactorR == null ? 'n/a' : paper.profitFactorR.toFixed(2)}, maxDD=${Number(paper.maxDrawdownR || 0).toFixed(2)}R`);
console.log(`Execution: entry coverage=${execution.entryExecutionCoverage == null ? 'n/a' : (execution.entryExecutionCoverage * 100).toFixed(1) + '%'}, realistic exit=${execution.exitV3Coverage == null ? 'n/a' : (execution.exitV3Coverage * 100).toFixed(1) + '%'}, pending=${execution.pendingExitSettlements}`);
console.log(`Safety: blockers=${safety.blockerCount}, circuit=${safety.circuitOpen ? 'OPEN' : 'CLOSED'}, db=${safety.pragmaHealthy ? 'OK' : 'CHECK'}`);
if (gate.hardBlockers.length) {
  console.log('');
  console.log('Hard blockers:');
  for (const blocker of gate.hardBlockers) console.log(`- ${blocker.label}: ${blocker.value ?? 'n/a'} (${blocker.threshold ?? 'required'})`);
}
if (gate.warnings.length) {
  console.log('');
  console.log('Warnings:');
  for (const warning of gate.warnings) console.log(`- ${warning.label}: ${warning.value ?? 'n/a'} (${warning.threshold ?? 'preferred'})`);
}
console.log('');
console.log('READY_FOR_LIVE_REVIEW is evidence eligibility only. Only the authenticated owner can authorize Live.');
