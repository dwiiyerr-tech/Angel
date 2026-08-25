#!/usr/bin/env node
import { initDb } from '../src/db/connection.js';
import { ensureResearchSchema } from '../src/research/schema.js';
import { ensureDecisionIntelligenceSchema } from '../src/decisionIntelligence/schema.js';
import { decisionIntelligenceSummary } from '../src/decisionIntelligence/report.js';
import { formatWindow, parseWindowMs } from '../src/utils.js';

initDb();
ensureResearchSchema();
ensureDecisionIntelligenceSchema();

const arg = process.argv.find(value => /^\d+(?:\.\d+)?(?:m|h|d)$/i.test(value)) || '24h';
const jsonMode = process.argv.includes('--json');
const windowMs = parseWindowMs(arg);
const report = decisionIntelligenceSummary(windowMs);

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const fmtR = value => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}R` : '—';
const fmtPct = value => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : '—';
const fmtMs = value => Number.isFinite(Number(value)) ? `${Math.round(Number(value))}ms` : '—';

console.log(`Angel Decision Intelligence V1 · ${formatWindow(windowMs)}`);
console.log('================================================');
console.log(`Receipts: ${report.total}`);
console.log(`BUY/WATCH/PASS: ${report.verdicts.BUY}/${report.verdicts.WATCH}/${report.verdicts.PASS}`);
console.log(`Probes: ready=${report.probes.ready} pending=${report.probes.pending} failed=${report.probes.failed}`);
console.log(`Median decision→probe: ${fmtMs(report.probes.medianDecisionToProbeMs)}`);
console.log(`Median quote→fill: ${fmtMs(report.probes.medianQuoteToFillMs)}`);
console.log(`Median deterioration: ${fmtPct(report.probes.medianQuoteDeteriorationPct)}`);
console.log(`Median roundtrip spread: ${fmtPct(report.probes.medianRoundtripSpreadPct)}`);
console.log(`Outcomes finalized: ${report.outcomes.finalized}`);
console.log(`Average / median final R: ${fmtR(report.outcomes.averageFinalR)} / ${fmtR(report.outcomes.medianFinalR)}`);
console.log('');
console.log('Classifications:');
const classes = Object.entries(report.outcomes.classifications || {}).sort((a, b) => b[1] - a[1]);
if (!classes.length) console.log('  none yet');
for (const [name, count] of classes) console.log(`  ${name}: ${count}`);
console.log('');
console.log('Routes:');
if (!report.routes.length) console.log('  none yet');
for (const row of report.routes.slice(0, 15)) {
  console.log(`  ${row.route}: N=${row.count} outcomes=${row.outcomes} avg=${fmtR(row.averageFinalR)} median=${fmtR(row.medianFinalR)} MFE=${fmtR(row.medianSampledMfeR)} missed_runners=${row.missedRunners}`);
}
