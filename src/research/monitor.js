import { db } from '../db/connection.js';
import { refreshPosition } from '../execution/positions.js';
import { sendPositionExit } from '../telegram/send.js';
import { ensureResearchSchema } from './schema.js';
import { recordResearchObservation } from './engine.js';
import { estimateResearchTransactionFees } from './executionCost.js';

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
      // Reuse the mature position/exit implementation. Execution Cost V2 is an
      // accounting overlay around it, so research never forks the trading logic.
      const result = await refreshPosition(position, { autoExit: true, jupiterPnl: null });
      if (!result) continue;
      const exitFees = result.exitReason
        ? await estimateResearchTransactionFees('exit')
        : null;
      const observation = recordResearchObservation(position.id, result, { exitFees });
      if (result.exitReason) {
        const reported = observation
          ? {
              ...result,
              pnlSol: observation.pnlSol,
              pnl_sol: observation.pnlSol,
              pnlPercent: observation.pnlPercent,
              pnl_percent: observation.pnlPercent,
              executionCost: { exitFees, modeledExitFeeSol: observation.modeledExitFeeSol },
            }
          : result;
        try {
          await sendPositionExit({ ...reported, execution_mode: 'research' });
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
