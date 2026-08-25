import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { activeStrategy, numSetting, setting } from './settings.js';

export function candidateSignalKey(candidate, signature = null) {
  const route = candidate.signals?.route || 'signal';
  const bucket = Math.floor(Number(candidate.createdAtMs || now()) / (5 * 60 * 1000));
  const sigFragment = signature ? `:${signature.slice(0, 16)}` : '';
  return `${route}:${candidate.token.mint}:${bucket}${sigFragment}`;
}

export function upsertCandidate(candidate, signature) {
  const signalKey = candidateSignalKey(candidate, signature);
  return db.transaction(() => {
    // A candidate can arrive through a new route key while carrying the same
    // on-chain signature. Resolve both unique identities before inserting.
    const existing = db.prepare(`
      SELECT id FROM candidates
      WHERE signal_key = ?
         OR (? IS NOT NULL AND signature = ? AND mint = ?)
      ORDER BY id DESC
      LIMIT 1
    `).get(signalKey, signature, signature, candidate.token.mint);
    if (existing) {
      db.prepare(`
        UPDATE candidates
        SET status = ?, updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
        WHERE id = ?
      `).run(
        candidate.filters.passed ? 'candidate' : 'filtered',
        now(),
        json(candidate),
        json(candidate.filters),
        existing.id,
      );
      return existing.id;
    }

    const result = db.prepare(`
      INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signature, signal_key, candidate_json, filter_result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.token.mint,
      candidate.filters.passed ? 'candidate' : 'filtered',
      now(),
      now(),
      signature,
      signalKey,
      json(candidate),
      json(candidate.filters),
    );
    return Number(result.lastInsertRowid);
  })();
}

export function updateCandidateStatus(candidateId, status) {
  db.prepare('UPDATE candidates SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now(), candidateId);
}

export function updateCandidateSnapshot(candidateId, candidate, status = null) {
  db.prepare(`
    UPDATE candidates
    SET status = COALESCE(?, status), updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
    WHERE id = ?
  `).run(status, now(), json(candidate), json(candidate.filters || {}), candidateId);
}

export function candidateById(id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

export function candidatesByIds(ids) {
  return ids.map(id => candidateById(Number(id))).filter(Boolean);
}

export function latestCandidateByMint(mint) {
  const row = db.prepare('SELECT * FROM candidates WHERE mint = ? ORDER BY id DESC LIMIT 1').get(mint);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

export function pruneOldFilteredCandidates({ olderThanMs = 3 * 24 * 60 * 60 * 1000, limit = 5000 } = {}) {
  const cutoff = now() - olderThanMs;
  const result = db.prepare(`
    DELETE FROM candidates
    WHERE id IN (
      SELECT c.id
      FROM candidates c
      WHERE c.created_at_ms < ?
        AND NOT EXISTS (SELECT 1 FROM llm_decisions d WHERE d.candidate_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM dry_run_positions p WHERE p.candidate_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM trade_intents i WHERE i.candidate_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.candidate_id = c.id)
      ORDER BY c.id
      LIMIT ?
    )
  `).run(cutoff, Math.max(1, Number(limit) || 5000));
  return result.changes;
}

export function pruneOldSignalEvents({ olderThanMs = 7 * 24 * 60 * 60 * 1000, limit = 20_000 } = {}) {
  const cutoff = now() - olderThanMs;
  const result = db.prepare(`
    DELETE FROM signal_events
    WHERE id IN (
      SELECT id FROM signal_events
      WHERE at_ms < ?
      ORDER BY id
      LIMIT ?
    )
  `).run(cutoff, Math.max(1, Number(limit) || 20_000));
  return result.changes;
}

export function recentEligibleCandidates(limit = 10) {
  const maxAgeMs = numSetting('llm_candidate_max_age_ms', 2 * 60 * 1000);
  const cutoff = now() - Math.max(30_000, maxAgeMs);
  const maxMcap = Number(activeStrategy()?.max_mcap_usd || 0);
  // Lesson #3: block unprofitable routes at query level — prevents blocked routes from drowning out profitable ones
  // pumpfun_pregrad: pre-grad tokens still on bonding curve, can't reliably trade yet — keep for data only
  let BLOCKED_ROUTES = [];
  try {
    BLOCKED_ROUTES = JSON.parse(setting('blocked_routes', '[]')).filter(r => r);
  } catch (e) {
    BLOCKED_ROUTES = [];
  }
  const blockedClause = BLOCKED_ROUTES.length > 0 
    ? BLOCKED_ROUTES.map(() => `signal_key NOT LIKE ? || ':%'`).join(' AND ') 
    : '1=1';
  const mcapClause = maxMcap > 0
    ? `(json_extract(candidate_json, '$.metrics.marketCapUsd') IS NULL
        OR CAST(json_extract(candidate_json, '$.metrics.marketCapUsd') AS REAL) <= ?)`
    : '1=1';
  const rows = db.prepare(`
    SELECT c.*
    FROM candidates c
    INNER JOIN (
      SELECT mint, MAX(id) as max_id
      FROM candidates
      WHERE status IN ('candidate', 'watch', 'buy', 'pass')
        AND created_at_ms >= ?
        AND id NOT IN (SELECT COALESCE(candidate_id, -1) FROM dry_run_positions WHERE status = 'open')
        AND ${blockedClause}
        AND (
          json_extract(candidate_json, '$.filters.passed') IS NULL
          OR json_extract(candidate_json, '$.filters.passed') = 1
        )
        AND ${mcapClause}
      GROUP BY mint
    ) latest ON c.id = latest.max_id
    ORDER BY c.id DESC
    LIMIT ?
  `).all(cutoff, ...BLOCKED_ROUTES, ...(maxMcap > 0 ? [maxMcap] : []), limit);
  return rows.map(row => ({ ...row, candidate: safeJson(row.candidate_json, {}) })).reverse();
}
