import fs from 'node:fs';
import { db, initDb } from '../../src/db/connection.js';
import { ensureLiveSafetySchema } from '../../src/db/liveSafety.js';
import { claimExecutionOperation, updateExecutionOperation } from '../../src/db/executionOperations.js';

const [mint, stage = 'after_claim'] = process.argv.slice(2);
if (!mint) throw new Error('mint argument is required');

initDb();
ensureLiveSafetySchema();
db.prepare("UPDATE settings SET value = 'live' WHERE key = 'trading_mode'").run();

const claim = claimExecutionOperation({ mint, side: 'buy', inputAmount: 25_000_000 });
if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);

if (stage === 'after_signature') {
  updateExecutionOperation(claim.operationId, 'outcome_unknown', {
    signature: `ChaosSignature_${mint}`,
    error: 'fault_injection_process_exit_after_signature',
  });
}

fs.writeSync(1, `${JSON.stringify({ operationId: claim.operationId, stage })}\n`);
// Deliberately do not perform graceful shutdown. better-sqlite3 writes above are
// committed synchronously; the parent test verifies the ledger survives this.
process.exit(91);
