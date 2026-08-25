import { db } from './connection.js';

// Read-only audit used by startup, health checks, and scheduled diagnostics.
// It intentionally never repairs or deletes data: repair must remain an
// explicit operator action so historical evidence cannot disappear silently.
export function auditDatabaseIntegrity() {
  const positions = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
           SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
           MAX(closed_at_ms) AS latest_closed_at_ms
    FROM dry_run_positions
  `).get();
  const orphanTradeRows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM dry_run_trades t
    WHERE NOT EXISTS (SELECT 1 FROM dry_run_positions p WHERE p.id = t.position_id)
  `).get().count;
  const orphanPositionLogs = db.prepare(`
    SELECT COUNT(*) AS count
    FROM decision_logs d
    WHERE json_extract(d.execution_json, '$.positionId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM dry_run_positions p
        WHERE p.id = CAST(json_extract(d.execution_json, '$.positionId') AS INTEGER)
      )
  `).get().count;
  const unresolvedExecutions = db.prepare("SELECT COUNT(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get().count;
  return {
    positions: {
      total: Number(positions.total || 0),
      closed: Number(positions.closed || 0),
      open: Number(positions.open || 0),
      latestClosedAtMs: positions.latest_closed_at_ms || null,
    },
    orphanTradeRows: Number(orphanTradeRows || 0),
    orphanPositionLogs: Number(orphanPositionLogs || 0),
    unresolvedExecutions: Number(unresolvedExecutions || 0),
    ok: Number(orphanTradeRows || 0) === 0 && Number(orphanPositionLogs || 0) === 0,
  };
}
