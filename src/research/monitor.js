import { db } from '../db/connection.js';
import { refreshPosition } from '../execution/positions.js';
import { sendPositionExit } from '../telegram/send.js';
import { ensureResearchSchema } from './schema.js';
import { recordResearchObservation } from './engine.js';
import { estimateResearchTransactionFees } from './executionCost.js';
import {
  ensureResearchExitSimulatorSchema,
  resumePendingResearchExitSettlements,
  settleResearchFinalExitV3,
  settleResearchPartialExitV3,
} from './exitSimulator.js';

async function recordAndReportFinalSettlement(settlement) {
  if (!settlement?.ok || settlement.kind !== 'final' || !settlement.result) return false;
  const observation = recordResearchObservation(settlement.positionId, settlement.result, {
    exitFees: settlement.profile?.fees || null,
  });
  const reported = observation
    ? {
        ...settlement.result,
        pnlSol: observation.pnlSol,
        pnl_sol: observation.pnlSol,
        pnlPercent: observation.pnlPercent,
        pnl_percent: observation.pnlPercent,
        executionCost: {
          exitV3: settlement.profile,
          exitFees: settlement.profile?.fees || null,
          modeledExitFeeSol: observation.modeledExitFeeSol,
        },
      }
    : {
        ...settlement.result,
        executionCost: { exitV3: settlement.profile, exitFees: settlement.profile?.fees || null },
      };
  try {
    await sendPositionExit({ ...reported, execution_mode: 'research' });
  } catch (error) {
    console.error(`[research] sendPositionExit failed for ${settlement.positionId}: ${error.message}`);
  }
  return true;
}

export async function monitorResearchPositions() {
  ensureResearchSchema();
  ensureResearchExitSimulatorSchema();

  // Resume crash-interrupted virtual sells before looking at new market state.
  // Research remains fail-soft: pending V3 settlement can never move real capital,
  // but it is kept durable until executable exit evidence becomes available.
  const resumed = await resumePendingResearchExitSettlements({ limit: 5 }).catch(error => {
    console.error(`[research-exit-v3] pending settlement resume failed: ${error.message}`);
    return [];
  });
  for (const settlement of resumed) {
    if (settlement?.ok && settlement.kind === 'final') {
      await recordAndReportFinalSettlement(settlement);
    }
  }

  const positions = db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE execution_mode = 'research' AND status = 'open'
    ORDER BY opened_at_ms ASC
  `).all();

  let checked = 0;
  let failures = 0;
  for (const position of positions) {
    checked += 1;
    const cycleStartedAtMs = Date.now();
    try {
      // Keep TP/SL/trailing/profit-lock/time-exit authority in the mature shared
      // position engine. Exit Simulator V3 only replaces virtual settlement
      // economics after that engine has emitted an exit or partial-TP action.
      const result = await refreshPosition(position, { autoExit: true, jupiterPnl: null });
      if (!result) continue;

      const partialSettlement = await settleResearchPartialExitV3({
        beforePosition: position,
        cycleStartedAtMs,
      }).catch(error => {
        console.error(`[research-exit-v3] partial settlement failed for ${position.id}: ${error.message}`);
        return null;
      });
      if (partialSettlement?.pending) {
        console.warn(`[research-exit-v3] partial settlement #${partialSettlement.settlementId} pending for position ${position.id}`);
      }

      if (result.exitReason) {
        const finalSettlement = await settleResearchFinalExitV3({ beforePosition: position, result }).catch(error => {
          console.error(`[research-exit-v3] final settlement failed for ${position.id}: ${error.message}`);
          return null;
        });

        if (finalSettlement?.pending) {
          console.warn(`[research-exit-v3] final settlement #${finalSettlement.settlementId} pending for position ${position.id}; delaying final Research report`);
          continue;
        }
        if (finalSettlement?.ok) {
          await recordAndReportFinalSettlement(finalSettlement);
          continue;
        }

        // Compatibility fallback for historical Research rows that predate
        // position-sized raw token tracking. New V3 positions should not use it.
        const exitFees = await estimateResearchTransactionFees('exit');
        const observation = recordResearchObservation(position.id, result, { exitFees });
        const reported = observation
          ? {
              ...result,
              pnlSol: observation.pnlSol,
              pnl_sol: observation.pnlSol,
              pnlPercent: observation.pnlPercent,
              pnl_percent: observation.pnlPercent,
              executionCost: { exitFees, modeledExitFeeSol: observation.modeledExitFeeSol, exitV3: null },
            }
          : result;
        try {
          await sendPositionExit({ ...reported, execution_mode: 'research' });
        } catch (error) {
          console.error(`[research] sendPositionExit failed for ${position.id}: ${error.message}`);
        }
        continue;
      }

      recordResearchObservation(position.id, result, { exitFees: null });
    } catch (error) {
      failures += 1;
      console.error(`[research] position ${position.id} monitor failed: ${error.message}`);
    }
  }

  return {
    checked,
    failures,
    resumedExitSettlements: resumed.filter(row => row?.ok).length,
    pendingExitSettlements: db.prepare("SELECT count(*) AS count FROM research_exit_settlements WHERE status = 'pending'").get()?.count || 0,
    liveFailures: 0,
  };
}
