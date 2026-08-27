import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initDb } from '../src/db/connection.js';
import { completeReleaseRollback, pendingReleaseRollback } from '../src/release/rollbackRequest.js';

initDb();
const request = pendingReleaseRollback();
if (!request) {
  console.log(JSON.stringify({ status: 'idle' }));
  process.exit(0);
}

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'release_manager.sh');
try {
  const output = execFileSync(script, ['rollback'], { encoding: 'utf8', env: process.env }).trim();
  completeReleaseRollback(request.id, 'completed', { output, request });
  console.log(JSON.stringify({ status: 'rolled_back', requestId: request.id, output }));
} catch (error) {
  completeReleaseRollback(request.id, 'failed', { message: error.message, stderr: String(error.stderr || '') });
  console.error(JSON.stringify({ status: 'failed', requestId: request.id, error: error.message }));
  process.exit(1);
}
