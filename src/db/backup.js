import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { db } from './connection.js';

const BACKUP_DIR = path.resolve(process.cwd(), 'backups');
const BACKUP_RETENTION = Math.max(3, Number(process.env.DB_BACKUP_RETENTION || 14));

function pruneOldBackups(keep = BACKUP_RETENTION) {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('angel_backup_') && f.endsWith('.sqlite'))
    .sort()
    .reverse();

  for (const file of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
    } catch (error) {
      console.error(`[backup] failed to prune ${file}: ${error.message}`);
    }
  }

  for (const file of fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sqlite-journal'))) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
    } catch (error) {
      console.error(`[backup] failed to remove stale journal ${file}: ${error.message}`);
    }
  }
}

export async function runBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // Reclaim space before creating the next multi-gigabyte backup. Pruning only
  // after db.backup() deadlocks recovery when the disk is already full.
  pruneOldBackups(BACKUP_RETENTION - 1);

  const iso = new Date().toISOString();
  const timestamp = `${iso.slice(0, 10).replaceAll('-', '')}_${iso.slice(11, 19).replaceAll(':', '')}`;
  const backupPath = path.join(BACKUP_DIR, `angel_backup_${timestamp}.sqlite`);
  const partialPath = `${backupPath}.partial`;

  try {
    await db.backup(partialPath);
    const verificationDb = new Database(partialPath, { readonly: true, fileMustExist: true });
    try {
      // A full quick_check scans multi-GB JSON payloads and can exhaust the
      // process memory. The Backup API already guarantees a consistent copy;
      // verify that the published artifact is readable and structurally sane.
      const pageCount = Number(verificationDb.pragma('page_count', { simple: true }));
      const requiredTables = verificationDb.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN ('candidates', 'dry_run_positions', 'settings')
      `).get().count;
      if (pageCount <= 0 || requiredTables !== 3) {
        throw new Error(`backup structural check failed: pages=${pageCount}, required_tables=${requiredTables}`);
      }
    } finally {
      verificationDb.close();
    }
    fs.renameSync(partialPath, backupPath);
    pruneOldBackups();
    return backupPath;
  } catch (error) {
    try {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    } catch (cleanupError) {
      console.error(`[backup] failed to remove partial backup: ${cleanupError.message}`);
    }
    throw error;
  }
}

export function getBackupStatus() {
  if (!fs.existsSync(BACKUP_DIR)) {
    return { last_backup: null, size_mb: 0, count: 0, recent: [] };
  }

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('angel_backup_') && f.endsWith('.sqlite'))
    .sort()
    .reverse();
    
  if (files.length === 0) {
    return { last_backup: null, size_mb: 0, count: 0, recent: [] };
  }
  
  const lastFile = path.join(BACKUP_DIR, files[0]);
  const stat = fs.statSync(lastFile);
  
  return {
    last_backup: files[0],
    size_mb: (stat.size / (1024 * 1024)).toFixed(2),
    count: files.length,
    recent: files.slice(0, 3)
  };
}
