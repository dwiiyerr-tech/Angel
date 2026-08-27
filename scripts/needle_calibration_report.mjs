import { initDb } from '../src/db/connection.js';
import { setting } from '../src/db/settings.js';
import { ensureResearchSchema } from '../src/research/schema.js';
import { needleCalibrationSnapshot } from '../src/edge/needleCalibration.js';
import { createNeedleCalibrationProposal } from '../src/edge/needleCalibrationProposal.js';
import { BASE_NEEDLE_WEIGHTS, parseNeedleWeights } from '../src/edge/needleWeights.js';

initDb();
ensureResearchSchema();

const activeWeights = parseNeedleWeights(setting('needle_weights_json', ''), BASE_NEEDLE_WEIGHTS);
const calibration = needleCalibrationSnapshot(activeWeights);
const propose = process.argv.includes('--propose');
let proposal = null;
let proposalError = null;
if (propose) {
  try {
    proposal = createNeedleCalibrationProposal({ actor: 'needle_calibration_cli' });
  } catch (error) {
    proposalError = error.message;
  }
}

const diagnostics = Object.fromEntries(Object.entries(calibration.diagnostics || {}).map(([key, value]) => [key, {
  skill: value.skill,
  reliability: value.reliability,
  thresholds: (value.thresholds || []).map(row => ({
    thresholdR: row.thresholdR,
    lift: row.lift,
    rawLift: row.rawLift,
    reliability: row.reliability,
    eventRate: row.eventRate,
    sampleWeight: row.sampleWeight,
  })),
}]));

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  model: calibration.version,
  invariants: {
    safetyWeightFixed: 20,
    contractSafetyBinaryAuthority: true,
    entrySnapshotOnly: true,
    chronologicalTrainValidation: true,
    liveAutoMutation: false,
  },
  activeWeights,
  calibration: {
    usableSample: calibration.usableSample,
    trainingSample: calibration.trainingSample,
    validationSample: calibration.validationSample,
    minimumSample: calibration.minSample,
    minimumValidation: calibration.minValidation,
    enoughSample: calibration.enoughSample,
    suggestionReady: calibration.suggestionReady,
    promotionReady: calibration.promotionReady,
    blend: calibration.blend,
    maxWeightChange: calibration.maxWeightChange,
    targetWeights: calibration.targetWeights,
    challengerWeights: calibration.challengerWeights,
    validation: calibration.validation,
    historyStartMs: calibration.historyStartMs,
    historyEndMs: calibration.historyEndMs,
    diagnostics,
    error: calibration.error || null,
  },
  proposalRequested: propose,
  proposal,
  proposalError,
}, null, 2));
