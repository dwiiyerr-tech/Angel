import { db } from '../db/connection.js';
import { refreshPosition } from '../execution/positions.js';
import { sendPositionExit } from '../telegram/send.js';
import { ensureResearchSchema } from './schema.js';
import { recordResearchObservation } from './engine.js';

export async function monitorResearchPositions() {
  ensureResearchSchema();
  const positions = db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'open'
    ORDER BY opened_at_ms ASC
  `).all();

  let checked = 0;
  let failures = 0;
  for (const position of positions) {
    checked += 1;
    try {
      // Reuse the mature position/exit implementation. Research mode differs in
      // capital/wallet semantics, not in how a hypothetical position experiences
      // the market. This prevents a second exit engine from drifting over time.
      const result = await refreshPosition(position, { autoExit: true, jupiterPnl: null });
      if (!result) continue;
      recordResearchObservation(position.id, result);
      if (result.exitReason) {
        try {
          await sendPositionExit({ ...result, execution_mode: 'research' });
        } catch (error) {
          console.error(`[research] sendPositionExit failed for ${position.id}: ${error.message}`);
        }
      }
    } catch (error) {
      failures += 1;
      console.error(`[research] position ${position.id} monitor failed: ${error.message}`);
    }
  }

  return { checked, failures, liveFailures: 0 };
}
