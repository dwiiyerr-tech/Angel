import { db, initDb } from '../src/db/connection.js';
import { numSetting } from '../src/db/settings.js';
import { safeJson } from '../src/utils.js';
import { ensureResearchSchema } from '../src/research/schema.js';
import { runnerLabelFromPosition, RUNNER_MODEL_VERSION } from '../src/edge/runnerModel.js';
import { marketRegimeKey, ROUTE_EDGE_MODEL_VERSION } from '../src/edge/routeEdgeModel.js';
import { paperWalletSummary } from '../src/research/virtualWallet.js';

initDb();
ensureResearchSchema();

const runnerMfeR = Math.max(1, numSetting('runner_label_mfe_r', 3));
const maxMaeR = Math.max(0.25, numSetting('runner_label_max_mae_r', 1));
const maxTimeToMfeMs = Math.max(0, numSetting('runner_label_max_time_minutes', 30)) * 60_000;

const rows = db.prepare(`
  SELECT id, realized_r, mfe_r, mae_r, time_to_mfe_ms, snapshot_json
  FROM dry_run_positions
  WHERE execution_mode = 'research' AND status = 'closed'
  ORDER BY closed_at_ms ASC
`).all();

const grouped = new Map();
let cleanRunners = 0;
let messyRunners = 0;
let nonRunners = 0;
let unknownLabels = 0;

for (const row of rows) {
  const snapshot = safeJson(row.snapshot_json, {});
  const candidate = snapshot?.candidate || {};
  const route = String(snapshot?.signalRoute || candidate?.signals?.route || 'unknown');
  const regime = String(candidate?.edge?.route?.regime || marketRegimeKey(candidate));
  const label = runnerLabelFromPosition(row, { runnerMfeR, maxMaeR, maxTimeToMfeMs });
  if (label.label === 'runner') cleanRunners += 1;
  else if (label.label === 'messy_runner') messyRunners += 1;
  else if (label.label === 'non_runner') nonRunners += 1;
  else unknownLabels += 1;

  const key = `${route}::${regime}`;
  const group = grouped.get(key) || {
    route,
    regime,
    sample: 0,
    wins: 0,
    sumR: 0,
    labeled: 0,
    runners: 0,
  };
  const realizedR = Number(row.realized_r);
  if (Number.isFinite(realizedR)) {
    group.sample += 1;
    group.sumR += realizedR;
    if (realizedR > 0) group.wins += 1;
  }
  if (label.isRunner !== null) {
    group.labeled += 1;
    if (label.isRunner) group.runners += 1;
  }
  grouped.set(key, group);
}

const routeRegimes = [...grouped.values()]
  .map(group => ({
    ...group,
    winRate: group.sample ? group.wins / group.sample : null,
    expectancyR: group.sample ? group.sumR / group.sample : null,
    cleanRunnerRate: group.labeled ? group.runners / group.labeled : null,
  }))
  .sort((a, b) => (b.sample - a.sample) || (b.expectancyR ?? -Infinity) - (a.expectancyR ?? -Infinity));

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  models: {
    runner: RUNNER_MODEL_VERSION,
    routeEdge: ROUTE_EDGE_MODEL_VERSION,
  },
  runnerLabelDefinition: {
    mfeRAtLeast: runnerMfeR,
    maeRAtLeast: -maxMaeR,
    timeToMfeMsAtMost: maxTimeToMfeMs,
  },
  totalClosedResearch: rows.length,
  labels: {
    cleanRunners,
    messyRunners,
    nonRunners,
    unknown: unknownLabels,
  },
  paperWallet: paperWalletSummary(),
  routeRegimes,
}, null, 2));
