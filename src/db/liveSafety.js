import { db } from './connection.js';

let initialized = false;

function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (columns.length && !columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function ensureLiveSafetySchema() {
  if (initialized) return;

  // These pragmas are connection-wide. FULL synchronous is intentionally used
  // for the money-grade ledger: latency is secondary to crash durability here.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');

  ensureColumn('execution_operations', 'candidate_id', 'INTEGER');
  ensureColumn('execution_operations', 'decision_id', 'INTEGER');
  ensureColumn('execution_operations', 'execution_mode', 'TEXT');
  ensureColumn('execution_operations', 'reserved_sol', 'REAL');
  ensureColumn('execution_operations', 'finalized_at_ms', 'INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS live_capital_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id INTEGER NOT NULL UNIQUE,
      mint TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      size_sol REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at_ms INTEGER NOT NULL,
      released_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_live_capital_reservations_active
      ON live_capital_reservations(execution_mode, status, created_at_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_live_capital_reservations_active_mint
      ON live_capital_reservations(mint)
      WHERE status = 'active';

    CREATE TRIGGER IF NOT EXISTS trg_live_reservation_follow_operation
    AFTER UPDATE OF status, position_id ON execution_operations
    WHEN EXISTS (
      SELECT 1 FROM live_capital_reservations
      WHERE operation_id = NEW.id AND status = 'active'
    ) AND (NEW.status IN ('completed', 'failed') OR NEW.position_id IS NOT NULL)
    BEGIN
      UPDATE live_capital_reservations
      SET status = CASE WHEN NEW.status = 'failed' THEN 'released' ELSE 'converted' END,
          released_at_ms = CAST(strftime('%s','now') AS INTEGER) * 1000
      WHERE operation_id = NEW.id AND status = 'active';
    END;
  `);

  initialized = true;
}

export function activeLiveReservationSummary(executionMode = 'live') {
  ensureLiveSafetySchema();
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_sol), 0) AS exposure
    FROM live_capital_reservations
    WHERE execution_mode = ? AND status = 'active'
  `).get(executionMode);
  return { count: Number(row?.count || 0), exposureSol: Number(row?.exposure || 0) };
}
