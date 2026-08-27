import { initDb } from '../src/db/connection.js';
import { buildNeedleCalibrationReport } from '../src/edge/needleCalibration.js';
import { SOLANA_TRENCHING_WORKFLOW } from '../src/pipeline/workflow.js';

initDb();

const report = buildNeedleCalibrationReport();
const pct = value => value == null ? 'n/a' : `${(Number(value) * 100).toFixed(1)}%`;
const number = value => value == null ? 'n/a' : Number(value).toFixed(3);

console.log('\n=== Needle v2 Calibration ===');
console.log(`Workflow: ${SOLANA_TRENCHING_WORKFLOW}`);
console.log(`Version: ${report.version}`);
console.log(`Objective: ${report.objective}`);
console.log(`Sample: ${report.sample} (train ${report.trainSample}, holdout ${report.holdoutSample})`);
console.log(`Enough sample: ${report.enoughSample ? 'YES' : 'NO'}`);
console.log(`Safety immutable: ${report.safetyImmutable ? 'YES' : 'NO'}`);
console.log('\nControl weights:');
console.log(JSON.stringify(report.controlWeights, null, 2));
console.log('\nChallenger weights:');
console.log(JSON.stringify(report.challengerWeights, null, 2));
console.log('\nHoldout comparison:');
console.log(`  Active top-quartile expectancy: ${number(report.holdout.active.topQuartileExpectancyR)}R`);
console.log(`  Challenger top-quartile expectancy: ${number(report.holdout.challenger.topQuartileExpectancyR)}R`);
console.log(`  Expectancy delta: ${number(report.holdout.expectancyDeltaR)}R`);
console.log(`  Active 5R recall: ${pct(report.holdout.active.runner5Recall)}`);
console.log(`  Challenger 5R recall: ${pct(report.holdout.challenger.runner5Recall)}`);
console.log(`  Active 10R recall: ${pct(report.holdout.active.runner10Recall)}`);
console.log(`  Challenger 10R recall: ${pct(report.holdout.challenger.runner10Recall)}`);
console.log(`Promotion ready: ${report.promotionReady ? 'YES' : 'NO'}`);
console.log(`Policy: ${report.promotionPolicy}`);
