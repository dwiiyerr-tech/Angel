import { initDb } from '../src/db/connection.js';
import { ensureResearchSchema } from '../src/research/schema.js';
import { ensureControlPlaneSchema } from '../src/controlPlane/schema.js';
import { buildStrategyEvidence } from '../src/controlPlane/evidence.js';
import { latestStrategyReview } from '../src/controlPlane/analyst.js';
import { activeConfigVersion, bootstrapConfigRegistry, openStrategyProposal } from '../src/controlPlane/registry.js';
import { pendingReleaseRollback } from '../src/release/rollbackRequest.js';

initDb();
ensureResearchSchema();
ensureControlPlaneSchema();
bootstrapConfigRegistry('report_bootstrap');

const active = activeConfigVersion();
const proposal = openStrategyProposal();
const review = latestStrategyReview();
const releaseRollback = pendingReleaseRollback();
const evidence = buildStrategyEvidence(7 * 24 * 60 * 60 * 1000);

console.log(JSON.stringify({
  active: active ? {
    version: active.version,
    label: active.label,
    status: active.status,
    configHash: active.config_hash,
    promptSetVersion: active.prompt_set_version,
    runnerModelVersion: active.runner_model_version,
    routeEdgeModelVersion: active.route_edge_model_version,
    simulatorVersion: active.simulator_version,
  } : null,
  openProposal: proposal ? {
    id: proposal.id,
    status: proposal.status,
    parentVersion: proposal.parent_version,
    proposedVersion: proposal.proposed_version,
    changes: proposal.proposal?.changes || [],
  } : null,
  latestReview: review ? {
    id: review.id,
    status: review.status,
    activeConfigVersion: review.active_config_version,
  } : null,
  pendingReleaseRollback: releaseRollback ? {
    id: releaseRollback.id,
    fromRelease: releaseRollback.from_release,
    toRelease: releaseRollback.to_release,
    requestedAtMs: releaseRollback.requested_at_ms,
    reason: releaseRollback.reason,
  } : null,
  evidence: {
    totalClosed: evidence.totalClosed,
    proposalEligible: evidence.proposalEligible,
    research: evidence.research,
    shadow: evidence.shadow,
  },
}, null, 2));
