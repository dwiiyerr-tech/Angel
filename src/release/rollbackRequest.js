import { db } from '../db/connection.js';
import { boolSetting, setting } from '../db/settings.js';
import { ensureControlPlaneSchema } from '../controlPlane/schema.js';

export function requestReleaseRollback({ configVersion = null, reason }) {
  ensureControlPlaneSchema();
  if (!boolSetting('release_rollback_enabled', false)) {
    return { requested: false, reason: 'release_rollback_not_enabled' };
  }
  const fromRelease = setting('release_current_label', process.env.ANGEL_RELEASE_VERSION || 'v33');
  const toRelease = setting('release_parent_label', process.env.ANGEL_PARENT_RELEASE_VERSION || 'v32');
  const existing = db.prepare(`
    SELECT * FROM release_rollback_requests
    WHERE status = 'pending' AND from_release = ? AND to_release = ?
    ORDER BY id DESC LIMIT 1
  `).get(fromRelease, toRelease);
  if (existing) return { requested: true, duplicate: true, request: existing };
  const result = db.prepare(`
    INSERT INTO release_rollback_requests
      (requested_at_ms, from_release, to_release, config_version, reason, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(Date.now(), fromRelease, toRelease, configVersion, String(reason || 'performance_guard'));
  return {
    requested: true,
    duplicate: false,
    request: db.prepare('SELECT * FROM release_rollback_requests WHERE id = ?').get(Number(result.lastInsertRowid)),
  };
}

export function pendingReleaseRollback() {
  ensureControlPlaneSchema();
  return db.prepare(`
    SELECT * FROM release_rollback_requests WHERE status = 'pending'
    ORDER BY requested_at_ms ASC, id ASC LIMIT 1
  `).get() || null;
}

export function completeReleaseRollback(id, status, result = {}) {
  ensureControlPlaneSchema();
  if (!['completed', 'failed'].includes(status)) throw new Error('Invalid release rollback terminal status');
  db.prepare(`
    UPDATE release_rollback_requests
    SET status = ?, consumed_at_ms = ?, result_json = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, Date.now(), JSON.stringify(result), Number(id));
}
