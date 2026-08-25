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

const current = report.evaluation.currentStage;
const research = report.evidence.research;
const shadow = report.evidence.shadow;
const execution = report.evidence.execution;
const safety = report.evidence.safety;

console.log('Angel Pre-Live Readiness Engine V1');
console.log('==================================');
console.log(`Window: ${formatWindow(windowMs)}`);
console.log(`Mode: ${report.currentMode}`);
console.log(`Current gate: ${current.status} (${current.score}/100)`);
console.log(`Hard blockers: ${current.hardBlockers.length}`);
console.log('');
console.log(`Research: N=${research.closedTrades}, expectancy=${research.expectancyR == null ? 'n/a' : research.expectancyR.toFixed(3)}R, PF=${research.profitFactorInfinite ? 'inf' : research.profitFactorR == null ? 'n/a' : research.profitFactorR.toFixed(2)}, maxDD=${research.maxDrawdownR.toFixed(2)}R`);
console.log(`Execution: entry coverage=${execution.entryExecutionCoverage == null ? 'n/a' : (execution.entryExecutionCoverage * 100).toFixed(1) + '%'}, ExitV3=${execution.exitV3Coverage == null ? 'n/a' : (execution.exitV3Coverage * 100).toFixed(1) + '%'}, pending=${execution.pendingExitSettlements}`);
console.log(`Shadow: N=${shadow.closedTrades}, expectancy=${shadow.expectancyR == null ? 'n/a' : shadow.expectancyR.toFixed(3)}R, PF=${shadow.profitFactorInfinite ? 'inf' : shadow.profitFactorR == null ? 'n/a' : shadow.profitFactorR.toFixed(2)}`);
console.log(`Safety: blockers=${safety.blockerCount}, circuit=${safety.circuitOpen ? 'OPEN' : 'CLOSED'}, db=${safety.pragmaHealthy ? 'OK' : 'CHECK'}`);
console.log('');
console.log('Stage gates:');
console.log(`- Research -> Shadow: ${report.evaluation.researchToShadow.status} (${report.evaluation.researchToShadow.score}/100)`);
console.log(`- Shadow -> Confirm: ${report.evaluation.shadowToConfirm.status} (${report.evaluation.shadowToConfirm.score}/100)`);
console.log(`- Confirm -> Live consideration: ${report.evaluation.confirmToLiveConsideration.status} (${report.evaluation.confirmToLiveConsideration.score}/100)`);
if (current.hardBlockers.length) {
  console.log('');
  console.log('Current hard blockers:');
  for (const blocker of current.hardBlockers) console.log(`- ${blocker.label}: ${blocker.value ?? 'n/a'} (${blocker.threshold ?? 'required'})`);
}
console.log('');
console.log('Readiness is eligibility-only. It never authorizes or enables Live.');
