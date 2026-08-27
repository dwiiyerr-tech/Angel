import { db } from '../db/connection.js';

export const DECISION_RECEIPT_VERSION = 'decision-receipt-v1';
export const DECISION_OUTCOME_HORIZONS_MS = Object.freeze([
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
]);

let initialized = false;

export function ensureDecisionIntelligenceSchema() {
  if (initialized) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER NOT NULL UNIQUE,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('BUY', 'WATCH', 'PASS')),
      confidence REAL NOT NULL,
      route TEXT,
      mode TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version TEXT NOT NULL,
      planned_tp_percent REAL,
      planned_sl_percent REAL,
      planned_rr REAL,
      snapshot_json TEXT NOT NULL,
      receipt_hash TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS decision_execution_probes (
      receipt_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at_ms INTEGER,
      position_id INTEGER,
      sim_notional_sol REAL,
      token_amount_raw TEXT,
      entry_effective_price_usd REAL,
      entry_effective_mcap_usd REAL,
      quote_to_fill_latency_ms INTEGER,
      decision_to_probe_ms INTEGER,
      quote_deterioration_pct REAL,
      roundtrip_spread_pct REAL,
      size_impact_pct REAL,
      entry_fee_sol REAL,
      expected_exit_fee_sol REAL,
      slippage_tolerance_bps INTEGER,
      profile_json TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS decision_outcome_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL,
      horizon_ms INTEGER NOT NULL,
      due_at_ms INTEGER NOT NULL,
      observed_at_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      out_sol REAL,
      pnl_sol REAL,
      pnl_percent REAL,
      r_multiple REAL,
      quote_json TEXT,
      market_json TEXT,
      error TEXT,
      UNIQUE(receipt_id, horizon_ms)
    );

    CREATE TABLE IF NOT EXISTS decision_outcomes (
      receipt_id INTEGER PRIMARY KEY,
      finalized_at_ms INTEGER NOT NULL,
      final_horizon_ms INTEGER,
      final_r REAL,
      sampled_mfe_r REAL,
      sampled_mae_r REAL,
      classification TEXT NOT NULL,
      data_quality TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS manager_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      created_at_ms INTEGER NOT NULL,
      content TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_decision_receipts_created
      ON decision_receipts(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_decision_receipts_mint_created
      ON decision_receipts(mint, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_decision_receipts_verdict_created
      ON decision_receipts(verdict, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_decision_receipts_route_created
      ON decision_receipts(route, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_decision_probe_status
      ON decision_execution_probes(status, next_retry_at_ms, requested_at_ms);
    CREATE INDEX IF NOT EXISTS idx_decision_observations_due
      ON decision_outcome_observations(status, due_at_ms);
    CREATE INDEX IF NOT EXISTS idx_manager_messages_chat
      ON manager_messages(chat_id, created_at_ms);

    CREATE TRIGGER IF NOT EXISTS trg_decision_receipt_immutable
    BEFORE UPDATE ON decision_receipts
    BEGIN
      SELECT RAISE(ABORT, 'decision receipt core is immutable');
    END;
  `);

  const observationColumns = new Set(db.prepare('PRAGMA table_info(decision_outcome_observations)').all().map(row => row.name));
  if (!observationColumns.has('market_json')) {
    db.exec('ALTER TABLE decision_outcome_observations ADD COLUMN market_json TEXT');
  }

  initialized = true;
}

export function resetDecisionIntelligenceSchemaForTests() {
  initialized = false;
}
