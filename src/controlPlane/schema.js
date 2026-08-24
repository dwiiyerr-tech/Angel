import { db } from '../db/connection.js';

let initialized = false;

export function ensureControlPlaneSchema() {
  if (initialized) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS config_versions (
      version INTEGER PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      parent_version INTEGER,
      created_at_ms INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      config_json TEXT NOT NULL,
      prompt_set_version TEXT NOT NULL,
      momentum_model_hash TEXT,
      runner_model_version TEXT NOT NULL,
      route_edge_model_version TEXT NOT NULL,
      simulator_version TEXT NOT NULL,
      evidence_window_ms INTEGER,
      evidence_sample INTEGER,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      approved_at_ms INTEGER,
      approved_by TEXT,
      approval_hash TEXT,
      promoted_at_ms INTEGER,
      rollback_at_ms INTEGER,
      rollback_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS strategy_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      parent_version INTEGER NOT NULL,
      proposed_version INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      analyst_mode TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      proposal_hash TEXT NOT NULL UNIQUE,
      proposed_config_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      decision_at_ms INTEGER,
      decision_by TEXT,
      review_note TEXT,
      test_started_at_ms INTEGER,
      test_until_ms INTEGER,
      min_test_sample INTEGER NOT NULL DEFAULT 30,
      promoted_at_ms INTEGER,
      rejected_at_ms INTEGER,
      rollback_at_ms INTEGER,
      rollback_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS challenger_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      route TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      active_eligible INTEGER NOT NULL,
      challenger_eligible INTEGER NOT NULL,
      active_reason TEXT NOT NULL,
      challenger_reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(proposal_id, candidate_id)
    );

    CREATE TABLE IF NOT EXISTS config_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      config_version INTEGER,
      proposal_id INTEGER,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_review_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      active_config_version INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      analyst_json TEXT NOT NULL,
      proposal_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_config_versions_status
      ON config_versions(status, version);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_config_versions_single_active
      ON config_versions(status) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_config_versions_hash
      ON config_versions(config_hash);
    CREATE INDEX IF NOT EXISTS idx_strategy_proposals_status
      ON strategy_proposals(status, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_challenger_observations_proposal
      ON challenger_observations(proposal_id, at_ms);
    CREATE INDEX IF NOT EXISTS idx_config_events_version
      ON config_events(config_version, at_ms);
    CREATE INDEX IF NOT EXISTS idx_strategy_review_runs_created
      ON strategy_review_runs(created_at_ms);

    CREATE TRIGGER IF NOT EXISTS trg_config_versions_immutable
    BEFORE UPDATE ON config_versions
    WHEN NEW.version != OLD.version
      OR NEW.label != OLD.label
      OR COALESCE(NEW.parent_version, -1) != COALESCE(OLD.parent_version, -1)
      OR NEW.created_at_ms != OLD.created_at_ms
      OR NEW.created_by != OLD.created_by
      OR NEW.config_hash != OLD.config_hash
      OR NEW.config_json != OLD.config_json
      OR NEW.prompt_set_version != OLD.prompt_set_version
      OR COALESCE(NEW.momentum_model_hash, '') != COALESCE(OLD.momentum_model_hash, '')
      OR NEW.runner_model_version != OLD.runner_model_version
      OR NEW.route_edge_model_version != OLD.route_edge_model_version
      OR NEW.simulator_version != OLD.simulator_version
      OR COALESCE(NEW.evidence_window_ms, -1) != COALESCE(OLD.evidence_window_ms, -1)
      OR COALESCE(NEW.evidence_sample, -1) != COALESCE(OLD.evidence_sample, -1)
      OR NEW.evidence_json != OLD.evidence_json
    BEGIN
      SELECT RAISE(ABORT, 'config version payload is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_strategy_proposals_payload_immutable
    BEFORE UPDATE ON strategy_proposals
    WHEN NEW.parent_version != OLD.parent_version
      OR NEW.proposed_version != OLD.proposed_version
      OR NEW.proposal_json != OLD.proposal_json
      OR NEW.proposal_hash != OLD.proposal_hash
      OR NEW.proposed_config_hash != OLD.proposed_config_hash
      OR NEW.evidence_json != OLD.evidence_json
      OR NEW.evidence_hash != OLD.evidence_hash
    BEGIN
      SELECT RAISE(ABORT, 'strategy proposal payload is immutable');
    END;
  `);
  initialized = true;
}

export function resetControlPlaneSchemaForTests() {
  initialized = false;
}
