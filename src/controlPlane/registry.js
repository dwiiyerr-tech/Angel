import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';
import { currentLiveConfig } from '../db/liveConfig.js';
import { numSetting, setSetting } from '../db/settings.js';
import { configuredTradingMode } from '../research/policy.js';
import { RESEARCH_SIMULATOR_VERSION } from '../research/engine.js';
import { RUNNER_MODEL_VERSION } from '../edge/runnerModel.js';
import { ROUTE_EDGE_MODEL_VERSION } from '../edge/routeEdgeModel.js';
import { ensureControlPlaneSchema } from './schema.js';

export const STRATEGY_PROMPT_SET_VERSION = 'strategy-control-v1';

export const CONTROL_PLANE_PROPOSABLE_SETTINGS = new Set([
  'llm_min_confidence',
  'blocked_routes',
  'min_opportunity_size_multiplier',
  'min_liquidity_usd',
  'flow_hard_price_change_pct',
  'flow_hard_net_buyer_ratio',
  'edge_min_quality_score',
  'edge_min_survival_probability',
  'edge_min_runner_probability',
  'edge_min_expected_r',
  'probe_entry_fraction',
  'runner_weakening_buyer_ratio',
]);

const PROPOSABLE_NUMERIC_RANGES = Object.freeze({
  llm_min_confidence: [30, 90],
  min_opportunity_size_multiplier: [0.25, 0.75],
  min_liquidity_usd: [1000, 100000],
  flow_hard_price_change_pct: [-80, 0],
  flow_hard_net_buyer_ratio: [-1, 0.5],
  edge_min_quality_score: [35, 80],
  edge_min_survival_probability: [0.45, 0.85],
  edge_min_runner_probability: [0.2, 0.75],
  edge_min_expected_r: [-0.1, 1.5],
  probe_entry_fraction: [0.05, 0.25],
  runner_weakening_buyer_ratio: [-0.5, 0.2],
});

const KNOWN_ROUTES = new Set([
  'pumpportal_graduated',
  'pumpfun_pregrad',
  'trenches_completed',
  'fee_trending',
  'trending',
  'graduated_trending',
  'dual_source',
  'smart_money',
  'gmgn_smart_money',
]);

const NON_VERSIONED_OPERATIONAL_SETTINGS = new Set([
  'live_circuit_breaker_open',
]);

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(sortObject(value));
}

export function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function currentManagedConfig() {
  const live = currentLiveConfig();
  const settings = Object.fromEntries(
    Object.entries(live.settings || {}).filter(([key]) => !NON_VERSIONED_OPERATIONAL_SETTINGS.has(key)),
  );
  return {
    settings,
    strategy: live.strategy,
  };
}

function modelMetadata() {
  const live = currentLiveConfig();
  return {
    promptSetVersion: STRATEGY_PROMPT_SET_VERSION,
    momentumModelHash: live.runtime?.model_sha256 || null,
    runnerModelVersion: RUNNER_MODEL_VERSION,
    routeEdgeModelVersion: ROUTE_EDGE_MODEL_VERSION,
    simulatorVersion: RESEARCH_SIMULATOR_VERSION,
  };
}

export function configVersionByNumber(version) {
  ensureControlPlaneSchema();
  const row = db.prepare('SELECT * FROM config_versions WHERE version = ?').get(Number(version));
  if (!row) return null;
  return {
    ...row,
    config: parseJson(row.config_json, {}),
    evidence: parseJson(row.evidence_json, {}),
  };
}

export function activeConfigVersion() {
  ensureControlPlaneSchema();
  const row = db.prepare("SELECT * FROM config_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1").get();
  if (!row) return null;
  return {
    ...row,
    config: parseJson(row.config_json, {}),
    evidence: parseJson(row.evidence_json, {}),
  };
}

export function bootstrapConfigRegistry(actor = 'system_bootstrap') {
  ensureControlPlaneSchema();
  const existing = activeConfigVersion();
  if (existing) return existing;
  const config = currentManagedConfig();
  const metadata = modelMetadata();
  const hash = hashJson(config);
  const now = Date.now();
  db.prepare(`
    INSERT INTO config_versions (
      version, label, parent_version, created_at_ms, created_by, status,
      config_hash, config_json, prompt_set_version, momentum_model_hash,
      runner_model_version, route_edge_model_version, simulator_version,
      evidence_window_ms, evidence_sample, evidence_json, promoted_at_ms
    ) VALUES (1, 'config-v1', NULL, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '{}', ?)
  `).run(
    now,
    actor,
    hash,
    canonicalJson(config),
    metadata.promptSetVersion,
    metadata.momentumModelHash,
    metadata.runnerModelVersion,
    metadata.routeEdgeModelVersion,
    metadata.simulatorVersion,
    now,
  );
  db.prepare(`
    INSERT INTO config_events (at_ms, event_type, config_version, proposal_id, actor, payload_json)
    VALUES (?, 'bootstrap', 1, NULL, ?, ?)
  `).run(now, actor, canonicalJson({ configHash: hash }));
  return activeConfigVersion();
}

export function assertRegistryAligned() {
  const active = bootstrapConfigRegistry();
  const currentHash = hashJson(currentManagedConfig());
  if (currentHash !== active.config_hash) {
    throw new Error(`Control-plane drift detected: active ${active.label} hash does not match current managed settings.`);
  }
  return active;
}

function normalizedBlockedRoutes(value) {
  let routes = value;
  if (typeof value === 'string') routes = parseJson(value, value.split(',').map(item => item.trim()));
  if (!Array.isArray(routes)) throw new Error('blocked_routes must be an array');
  const normalized = [...new Set(routes.map(String).map(route => route.trim()).filter(Boolean))].sort();
  for (const route of normalized) {
    if (!KNOWN_ROUTES.has(route)) throw new Error(`Unknown route in blocked_routes: ${route}`);
  }
  return JSON.stringify(normalized);
}

function validateProposableNumber(key, number) {
  const range = PROPOSABLE_NUMERIC_RANGES[key];
  if (!range) return;
  if (number < range[0] || number > range[1]) {
    throw new Error(`${key} must remain within [${range[0]}, ${range[1]}]`);
  }
}

export function validateProposalChanges(changes = []) {
  if (!Array.isArray(changes)) throw new Error('Proposal changes must be an array');
  if (changes.length > 6) throw new Error('A proposal may contain at most 6 changes');
  const seen = new Set();
  return changes.map(item => {
    const key = String(item?.key || '').trim();
    if (!CONTROL_PLANE_PROPOSABLE_SETTINGS.has(key)) {
      throw new Error(`Protected or unsupported config key: ${key || '(missing)'}`);
    }
    if (seen.has(key)) throw new Error(`Duplicate proposal key: ${key}`);
    seen.add(key);
    let value;
    if (key === 'blocked_routes') {
      value = normalizedBlockedRoutes(item.value);
    } else {
      const number = Number(item.value);
      if (!Number.isFinite(number)) throw new Error(`${key} must be numeric`);
      validateProposableNumber(key, number);
      value = String(number);
    }
    return {
      key,
      value,
      rationale: String(item?.rationale || '').slice(0, 500),
      evidence: item?.evidence ?? null,
    };
  });
}

export function applyChangesToConfig(parentConfig, changes) {
  const next = JSON.parse(JSON.stringify(parentConfig || {}));
  next.settings = { ...(next.settings || {}) };
  for (const change of validateProposalChanges(changes)) next.settings[change.key] = change.value;
  return next;
}

export function openStrategyProposal() {
  ensureControlPlaneSchema();
  const row = db.prepare(`
    SELECT * FROM strategy_proposals
    WHERE status IN ('pending_review', 'testing', 'promotion_ready', 'needs_extension')
    ORDER BY id DESC LIMIT 1
  `).get();
  if (!row) return null;
  return {
    ...row,
    proposal: parseJson(row.proposal_json, {}),
    evidence: parseJson(row.evidence_json, {}),
  };
}

export function createStrategyProposal({
  changes,
  evidence,
  analysis = {},
  source = 'strategy_analyst',
  analystMode = 'deterministic',
  actor = 'strategy_analyst',
} = {}) {
  ensureControlPlaneSchema();
  const existing = openStrategyProposal();
  if (existing) throw new Error(`Open proposal #${existing.id} must be resolved before creating another.`);
  const parent = assertRegistryAligned();
  const validated = validateProposalChanges(changes);
  if (!validated.length) throw new Error('Cannot create a no-op strategy proposal');
  const proposedConfig = applyChangesToConfig(parent.config, validated);
  const proposedHash = hashJson(proposedConfig);
  if (proposedHash === parent.config_hash) throw new Error('Proposal does not change the active configuration');

  const nextVersion = Number(db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM config_versions').get().version);
  const metadata = modelMetadata();
  const evidenceJson = canonicalJson(evidence || {});
  const evidenceHash = createHash('sha256').update(evidenceJson).digest('hex');
  const proposalPayload = {
    version: 1,
    parentVersion: parent.version,
    proposedVersion: nextVersion,
    changes: validated,
    analysis,
  };
  const proposalHash = hashJson(proposalPayload);
  const now = Date.now();
  const evidenceSample = Number(evidence?.totalClosed ?? evidence?.paper?.closed ?? evidence?.research?.closed ?? 0) || 0;
  const windowMs = Number(evidence?.windowMs || 0) || null;

  return db.transaction(() => {
    db.prepare(`
      INSERT INTO config_versions (
        version, label, parent_version, created_at_ms, created_by, status,
        config_hash, config_json, prompt_set_version, momentum_model_hash,
        runner_model_version, route_edge_model_version, simulator_version,
        evidence_window_ms, evidence_sample, evidence_json
      ) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nextVersion,
      `config-v${nextVersion}`,
      parent.version,
      now,
      actor,
      proposedHash,
      canonicalJson(proposedConfig),
      metadata.promptSetVersion,
      metadata.momentumModelHash,
      metadata.runnerModelVersion,
      metadata.routeEdgeModelVersion,
      metadata.simulatorVersion,
      windowMs,
      evidenceSample,
      evidenceJson,
    );

    const result = db.prepare(`
      INSERT INTO strategy_proposals (
        created_at_ms, parent_version, proposed_version, status, source, analyst_mode,
        proposal_json, proposal_hash, proposed_config_hash, evidence_json, evidence_hash,
        min_test_sample
      ) VALUES (?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now,
      parent.version,
      nextVersion,
      source,
      analystMode,
      canonicalJson(proposalPayload),
      proposalHash,
      proposedHash,
      evidenceJson,
      evidenceHash,
      Math.max(30, Math.floor(numSetting('control_plane_min_test_sample', 100))),
    );
    const proposalId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO config_events (at_ms, event_type, config_version, proposal_id, actor, payload_json)
      VALUES (?, 'proposal_created', ?, ?, ?, ?)
    `).run(now, nextVersion, proposalId, actor, canonicalJson({ proposalHash, evidenceHash }));
    return { proposalId, proposedVersion: nextVersion, proposalHash, proposedConfigHash: proposedHash, changes: validated };
  })();
}

export function proposalById(id) {
  ensureControlPlaneSchema();
  const row = db.prepare('SELECT * FROM strategy_proposals WHERE id = ?').get(Number(id));
  if (!row) return null;
  return {
    ...row,
    proposal: parseJson(row.proposal_json, {}),
    evidence: parseJson(row.evidence_json, {}),
  };
}

export function approveProposalForTest(id, actor = 'human') {
  ensureControlPlaneSchema();
  const proposal = proposalById(id);
  if (!proposal || !['pending_review', 'needs_extension'].includes(proposal.status)) {
    throw new Error('Proposal is not awaiting human test approval');
  }
  assertRegistryAligned();
  const now = Date.now();
  const testDays = Math.max(14, Math.floor(numSetting('control_plane_test_days', 14)));
  const until = now + testDays * 24 * 60 * 60 * 1000;
  const approvalHash = createHash('sha256')
    .update(`${proposal.proposal_hash}:${actor}:${now}`)
    .digest('hex');
  db.transaction(() => {
    db.prepare(`
      UPDATE strategy_proposals
      SET status = 'testing', decision_at_ms = ?, decision_by = ?,
          test_started_at_ms = COALESCE(test_started_at_ms, ?), test_until_ms = ?
      WHERE id = ?
    `).run(now, actor, now, until, proposal.id);
    db.prepare(`
      UPDATE config_versions
      SET status = 'testing', approved_at_ms = ?, approved_by = ?, approval_hash = ?
      WHERE version = ?
    `).run(now, actor, approvalHash, proposal.proposed_version);
    db.prepare(`
      INSERT INTO config_events (at_ms, event_type, config_version, proposal_id, actor, payload_json)
      VALUES (?, 'test_approved', ?, ?, ?, ?)
    `).run(now, proposal.proposed_version, proposal.id, actor, canonicalJson({ until, approvalHash }));
  })();
  return proposalById(id);
}

export function rejectProposal(id, note = '', actor = 'human') {
  ensureControlPlaneSchema();
  const proposal = proposalById(id);
  if (!proposal || !['pending_review', 'testing', 'promotion_ready', 'needs_extension'].includes(proposal.status)) {
    throw new Error('Proposal cannot be rejected from its current state');
  }
  const now = Date.now();
  db.transaction(() => {
    db.prepare(`
      UPDATE strategy_proposals
      SET status = 'rejected', decision_at_ms = ?, decision_by = ?, review_note = ?, rejected_at_ms = ?
      WHERE id = ?
    `).run(now, actor, String(note || '').slice(0, 1000), now, proposal.id);
    db.prepare("UPDATE config_versions SET status = 'rejected' WHERE version = ?").run(proposal.proposed_version);
    db.prepare(`
      INSERT INTO config_events (at_ms, event_type, config_version, proposal_id, actor, payload_json)
      VALUES (?, 'proposal_rejected', ?, ?, ?, ?)
    `).run(now, proposal.proposed_version, proposal.id, actor, canonicalJson({ note: String(note || '').slice(0, 1000) }));
  })();
  return proposalById(id);
}

export function extendProposalTest(id, days = 7, actor = 'human') {
  ensureControlPlaneSchema();
  const proposal = proposalById(id);
  if (!proposal || !['testing', 'needs_extension'].includes(proposal.status)) {
    throw new Error('Only an active/expired challenger test can be extended');
  }
  const extensionDays = Math.max(1, Math.min(30, Math.floor(Number(days) || 7)));
  const now = Date.now();
  const base = Math.max(now, Number(proposal.test_until_ms || now));
  const until = base + extensionDays * 24 * 60 * 60 * 1000;
  db.transaction(() => {
    db.prepare(`
      UPDATE strategy_proposals SET status = 'testing', test_until_ms = ?, decision_at_ms = ?, decision_by = ?
      WHERE id = ?
    `).run(until, now, actor, proposal.id);
    db.prepare(`
      INSERT INTO config_events (at_ms, event_type, config_version, proposal_id, actor, payload_json)
      VALUES (?, 'test_extended', ?, ?, ?, ?)
    `).run(now, proposal.proposed_version, proposal.id, actor, canonicalJson({ extensionDays, until }));
  })();
  return proposalById(id);
}

function proposalChanges(proposal) {
  return validateProposalChanges(proposal?.proposal?.changes || []);
}

function applyProposalSettings(proposal) {
  for (const change of proposalChanges(proposal)) setSetting(change.key, change.value);
}

export function promoteProposal(id, actor = 'human') {
  ensureControlPlaneSchema();
  const proposal = proposalById(id);
  if (!proposal || proposal.status !== 'promotion_ready') throw new Error('Proposal is not promotion-ready');
  if (configuredTradingMode() !== 'paper') {
    throw new Error('Promotion is allowed only in PAPER no-broadcast mode');
  }
  const unresolved = Number(db.prepare("SELECT COUNT(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get().count || 0);
  if (unresolved > 0) throw new Error(`Cannot promote with ${unresolved} unresolved execution outcome(s)`);
  const active = assertRegistryAligned();
  if (Number(active.version) !== Number(proposal.parent_version)) throw new Error('Proposal parent is no longer the active config');
  const now = Date.now();
  db.transaction(() => {
    applyProposalSettings(proposal);
    const actualHash = hashJson(currentManagedConfig());
    if (actualHash !== proposal.proposed_config_hash) throw new Error('Post-promotion config hash mismatch');
    db.prepare("UPDATE config_versions SET status = 'archived' WHERE version = ?").run(active.version);
    db.prepare("UPDATE config_versions SET status = 'active', promoted_at_ms = ? WHERE version = ?").run(now, proposal.proposed_version);
    db.prepare("UPDATE strategy_proposals SET status = 'promoted', promoted_at_ms = ?, decision_at_ms = ?, decision_by = ? WHERE id = ?")
      .run(now, now, actor, proposal.id);
    db.prepare(`
      INSERT INTO config_events (at_ms, event_type, config_version, proposal_id, actor, payload_json)
      VALUES (?, 'promoted', ?, ?, ?, ?)
    `).run(now, proposal.proposed_version, proposal.id, actor, canonicalJson({ parentVersion: active.version }));
  })();
  return activeConfigVersion();
}

export function rollbackToParent(targetVersion, reason = 'manual rollback', actor = 'human') {
  ensureControlPlaneSchema();
  const active = activeConfigVersion();
  if (!active) throw new Error('No active config version');
  const target = configVersionByNumber(targetVersion);
  if (!target) throw new Error(`Config version ${targetVersion} not found`);
  if (Number(active.parent_version) !== Number(target.version)) {
    throw new Error('Rollback target must be the direct parent of the active config');
  }

  const now = Date.now();
  db.transaction(() => {
    if (configuredTradingMode() !== 'paper') setSetting('trading_mode', 'paper');
    for (const key of CONTROL_PLANE_PROPOSABLE_SETTINGS) {
      if (target.config?.settings?.[key] !== undefined) setSetting(key, target.config.settings[key]);
    }
    const actualHash = hashJson(currentManagedConfig());
    if (actualHash !== target.config_hash) throw new Error('Rollback config hash mismatch');
    db.prepare("UPDATE config_versions SET status = 'rolled_back', rollback_at_ms = ?, rollback_reason = ? WHERE version = ?")
      .run(now, String(reason || '').slice(0, 1000), active.version);
    db.prepare("UPDATE config_versions SET status = 'active' WHERE version = ?").run(target.version);
    db.prepare(`
      UPDATE strategy_proposals
      SET status = 'rolled_back', rollback_at_ms = ?, rollback_reason = ?
      WHERE proposed_version = ? AND status = 'promoted'
    `).run(now, String(reason || '').slice(0, 1000), active.version);
    db.prepare(`
      INSERT INTO config_events (at_ms, event_type, config_version, proposal_id, actor, payload_json)
      VALUES (?, 'rollback', ?, NULL, ?, ?)
    `).run(now, target.version, actor, canonicalJson({ fromVersion: active.version, reason: String(reason || '').slice(0, 1000) }));
  })();
  return activeConfigVersion();
}

export function controlPlaneContext() {
  const active = bootstrapConfigRegistry();
  const challenger = openStrategyProposal();
  return {
    activeVersion: active.version,
    activeLabel: active.label,
    activeConfigHash: active.config_hash,
    promptSetVersion: active.prompt_set_version,
    challengerProposalId: challenger?.status === 'testing' ? challenger.id : null,
    challengerVersion: challenger?.status === 'testing' ? challenger.proposed_version : null,
  };
}
