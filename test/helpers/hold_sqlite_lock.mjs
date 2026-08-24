import Database from 'better-sqlite3';

const [dbPath, holdMsText = '350'] = process.argv.slice(2);
if (!dbPath) throw new Error('database path is required');
const holdMs = Math.max(50, Number(holdMsText) || 350);

const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
process.stdout.write('LOCKED\n');

setTimeout(() => {
  try {
    db.exec('COMMIT');
    db.close();
    process.stdout.write('RELEASED\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(2);
  }
}, holdMs);
