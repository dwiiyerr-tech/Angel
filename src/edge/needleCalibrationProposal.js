import { setting } from '../db/settings.js';
import { createStrategyProposal, openStrategyProposal } from '../controlPlane/registry.js';
import { needleCalibrationSnapshot } from './needleCalibration.js';
import { BASE_NEEDLE_WEIGHTS, parseNeedleWeights } from './needleWeights.js';

function activeWeights() {
  return parseNeedleWeights(setting('needle_weights_json', ''), BASE_NEEDLE_WEIGHTS);
}

export function createNeedleCalibrationProposal({ actor = 'needle_calibrator' } = {}) {
  const open = openStrategyProposal();
  if (open) throw new Error(`Open strategy proposal #${open.id} must be resolved before Needle calibration can propose another config.`);

  const current = activeWeights();
  const calibration = needleCalibrationSnapshot(current);
  if (!calibration?.enoughSample) {
    throw new Error(`Needle calibration needs more PAPER evidence (${calibration?.usableSample || 0}/${calibration?.minSample || 0}).`);
  }
  if (!calibration?.promotionReady) {
    const validation = calibration?.validation || {};
    throw new Error(`Needle challenger is not out-of-sample ready (utility lift ${Number(validation.utilityLift || 0).toFixed(4)}, runner-index lift ${Number(validation.weightedRunnerLift || 0).toFixed(4)}).`);
  }

  const weightsJson = JSON.stringify(calibration.challengerWeights);
  return createStrategyProposal({
    changes: [{
      key: 'needle_weights_json',
      value: weightsJson,
      rationale: `Empirical Needle calibration from ${calibration.usableSample} closed PAPER positions; Safety remains fixed at 20.`,
      evidence: {
        calibrationVersion: calibration.version,
        trainingSample: calibration.trainingSample,
        validationSample: calibration.validationSample,
        validation: calibration.validation,
      },
    }],
    evidence: {
      totalClosed: calibration.usableSample,
      windowMs: calibration.historyStartMs && calibration.historyEndMs
        ? calibration.historyEndMs - calibration.historyStartMs
        : null,
      needleCalibration: calibration,
    },
    analysis: {
      type: 'needle_weight_calibration',
      activeWeights: current,
      challengerWeights: calibration.challengerWeights,
      invariant: 'Safety weight fixed at 20; Contract Safety remains binary authority.',
    },
    source: 'needle_calibration',
    analystMode: 'deterministic_out_of_sample',
    actor,
  });
}
