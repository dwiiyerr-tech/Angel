import { safeJson } from '../utils.js';

const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

const EDGE_FEATURES = {
  entryMcapUsd: 'candidate.metrics.marketCapUsd',
  liquidityUsd: 'candidate.metrics.liquidityUsd',
  holderCount: 'candidate.metrics.holderCount',
  botHoldersPct: 'candidate.jupiterAsset.audit.botHoldersPercentage',
  topHoldersPct: 'candidate.jupiterAsset.audit.topHoldersPercentage',
  priceChange5m: 'candidate.jupiterAsset.stats5m.priceChange',
  liquidityChange5m: 'candidate.jupiterAsset.stats5m.liquidityChange',
  traders5m: 'candidate.jupiterAsset.stats5m.numTraders',
  netBuyers5m: 'candidate.jupiterAsset.stats5m.numNetBuyers',
  preScore: 'candidate.filters.preScore',
  momentumScore: 'candidate.filters.momentumScore',
};

export function edgeRecord(position) {
  const snapshot = safeJson(position.snapshot_json, {});
  const features = {};
  for (const [name, path] of Object.entries(EDGE_FEATURES)) {
    const value = Number(get(snapshot, path));
    features[name] = Number.isFinite(value) ? value : null;
  }
  const confidence = Number(position.llm_confidence);
  features.llmConfidence = Number.isFinite(confidence) ? confidence : null;
  const referencePrice = Number(snapshot?.candidate?.metrics?.priceUsd);
  const quotedPrice = Number(snapshot?.entryQuote?.effectivePriceUsd);
  features.entryPriceImpactPct = referencePrice > 0 && quotedPrice > 0
    ? (quotedPrice / referencePrice - 1) * 100
    : null;
  return {
    id: Number(position.id),
    openedAtMs: Number(position.opened_at_ms),
    pnlSol: Number(position.pnl_sol),
    pnlPercent: Number(position.pnl_percent),
    features,
  };
}

function stats(records) {
  const pnlSol = records.reduce((sum, row) => sum + row.pnlSol, 0);
  return {
    trades: records.length,
    pnlSol,
    avgPnlSol: records.length ? pnlSol / records.length : null,
    winRate: records.length ? records.filter(row => row.pnlPercent > 0).length / records.length : null,
  };
}

function apply(records, proposal) {
  return records.filter(row => {
    const value = row.features[proposal.feature];
    return value !== null && (proposal.direction === 'min' ? value >= proposal.threshold : value <= proposal.threshold);
  });
}

function runnerRecall(before, after, runnerPnlPercent = 50) {
  const runnerIds = new Set(before.filter(row => row.pnlPercent >= runnerPnlPercent).map(row => row.id));
  if (!runnerIds.size) return 1;
  const retained = after.filter(row => runnerIds.has(row.id)).length;
  return retained / runnerIds.size;
}

export function tuneAdmissionEdge(records, { minTrain = 30, minTest = 20 } = {}) {
  const ordered = records
    .filter(row => Number.isFinite(row.openedAtMs) && Number.isFinite(row.pnlSol) && Number.isFinite(row.pnlPercent))
    .sort((a, b) => a.openedAtMs - b.openedAtMs);
  const splitAt = Math.floor(ordered.length * 0.5);
  const validationAt = Math.floor(ordered.length * 0.75);
  const train = ordered.slice(0, splitAt);
  const validation = ordered.slice(splitAt, validationAt);
  const test = ordered.slice(validationAt);
  const baseline = { train: stats(train), validation: stats(validation), test: stats(test) };
  const proposals = [];

  for (const feature of [...Object.keys(EDGE_FEATURES), 'llmConfidence', 'entryPriceImpactPct']) {
    const values = train.map(row => row.features[feature]).filter(value => value !== null).sort((a, b) => a - b);
    if (values.length < minTrain) continue;
    for (const quantile of [0.2, 0.3, 0.4, 0.6, 0.7, 0.8]) {
      const threshold = values[Math.min(values.length - 1, Math.floor(values.length * quantile))];
      for (const direction of ['min', 'max']) {
        const proposal = { feature, direction, threshold };
        const trainApplied = apply(train, proposal);
        const validationApplied = apply(validation, proposal);
        const testApplied = apply(test, proposal);
        const trainStats = stats(trainApplied);
        const validationStats = stats(validationApplied);
        const testStats = stats(testApplied);
        if (trainStats.trades < minTrain || validationStats.trades < minTest) continue;
        const trainUplift = trainStats.avgPnlSol - baseline.train.avgPnlSol;
        const validationUplift = validationStats.avgPnlSol - baseline.validation.avgPnlSol;
        const testUplift = testStats.avgPnlSol - baseline.test.avgPnlSol;
        proposals.push({
          ...proposal,
          train: trainStats,
          validation: validationStats,
          test: testStats,
          trainUplift,
          validationUplift,
          testUplift,
          runnerRecall: {
            train: runnerRecall(train, trainApplied),
            validation: runnerRecall(validation, validationApplied),
            test: runnerRecall(test, testApplied),
          },
          finalHoldoutEnough: testStats.trades >= minTest,
          splitHalfPositive: testStats.trades >= minTest
            && trainStats.pnlSol > 0 && validationStats.pnlSol > 0 && testStats.pnlSol > 0
            && trainUplift > 0 && validationUplift > 0 && testUplift > 0,
        });
      }
    }
  }

  // Select on training + validation; the final chronological holdout is only
  // a confirmation gate and is never used to rank competing proposals.
  proposals.sort((a, b) => b.validationUplift - a.validationUplift || b.trainUplift - a.trainUplift);
  const selected = proposals.find(item => item.trainUplift > 0 && item.validationUplift > 0) || null;
  const runnerRecallPreserved = selected
    && selected.runnerRecall.train >= 0.8
    && selected.runnerRecall.validation >= 0.8
    && selected.runnerRecall.test >= 0.8;
  const recommended = selected?.splitHalfPositive && runnerRecallPreserved ? selected : null;
  return { sample: ordered.length, splitAt, validationAt, baseline, proposals, selected, recommended };
}
