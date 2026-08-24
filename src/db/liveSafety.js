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

    -- A finalized sell is not fully complete until its position-ledger mutation
    -- commits. executeLiveSell records a recoverable pending-ledger operation;
    -- this trigger completes it in the same SQLite transaction as the normal
    -- full/partial position update. A crash before this update leaves the
    -- operation unresolved for the finalized-signature reconciler.
    CREATE TRIGGER IF NOT EXISTS trg_live_sell_operation_follow_position
    AFTER UPDATE OF status, token_amount_raw, size_sol, partial_tp_done ON dry_run_positions
    WHEN EXISTS (
      SELECT 1 FROM execution_operations
      WHERE position_id = NEW.id
        AND side = 'sell'
        AND status = 'outcome_unknown'
        AND error = 'finalized_sell_pending_position_ledger'
    ) AND (
      NEW.status = 'closed'
      OR (
        NEW.status = 'open'
        AND COALESCE(NEW.partial_tp_done, 0) = 1
        AND (
          COALESCE(OLD.partial_tp_done, 0) != COALESCE(NEW.partial_tp_done, 0)
          OR COALESCE(OLD.token_amount_raw, '') != COALESCE(NEW.token_amount_raw, '')
          OR COALESCE(OLD.size_sol, -1) != COALESCE(NEW.size_sol, -1)
        )
      )
    )
    BEGIN
      UPDATE execution_operations
      SET status = 'completed', error = NULL,
          updated_at_ms = CAST(strftime('%s','now') AS INTEGER) * 1000
      WHERE position_id = NEW.id
        AND side = 'sell'
        AND status = 'outcome_unknown'
        AND error = 'finalized_sell_pending_position_ledger';
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
