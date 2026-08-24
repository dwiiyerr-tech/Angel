import { db } from '../db/connection.js';

const POSITION_COLUMNS = {
  real_capital_sol: 'REAL NOT NULL DEFAULT 0',
  sim_notional_sol: 'REAL',
  initial_risk_percent: 'REAL',
  initial_risk_sol: 'REAL',
  planned_rr: 'REAL',
  low_water_price: 'REAL',
  low_water_mcap: 'REAL',
  mfe_percent: 'REAL',
  mae_percent: 'REAL',
  mfe_r: 'REAL',
  mae_r: 'REAL',
  realized_r: 'REAL',
  time_to_mfe_ms: 'INTEGER',
  time_to_mae_ms: 'INTEGER',
  research_data_quality: 'TEXT',
  research_quote_ladder_json: 'TEXT',
};

let initialized = false;

export function ensureResearchSchema() {
  if (initialized) return;
  const tableInfo = db.pragma('table_info(dry_run_positions)');
  if (!Array.isArray(tableInfo) || tableInfo.length === 0) {
    throw new Error('dry_run_positions must exist before research schema initialization');
  }
  const existing = new Set(tableInfo.map(row => row.name));

  db.transaction(() => {
    for (const [name, definition] of Object.entries(POSITION_COLUMNS)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE dry_run_positions ADD COLUMN ${name} ${definition}`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS research_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL,
        mint TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        price REAL,
        mcap REAL,
        pnl_percent REAL,
        pnl_sol REAL,
        r_multiple REAL,
        quote_valid INTEGER,
        data_quality TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_observations_position_at
        ON research_observations(position_id, at_ms);
      CREATE INDEX IF NOT EXISTS idx_research_observations_mint_at
        ON research_observations(mint, at_ms);
    `);
  })();

  initialized = true;
}

export function resetResearchSchemaForTests() {
  initialized = false;
}
