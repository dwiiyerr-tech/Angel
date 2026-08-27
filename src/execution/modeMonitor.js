import { db } from '../db/connection.js';
import { refreshPosition } from './positions.js';
import { monitorResearchPositions } from '../research/monitor.js';
import { fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { sendPositionExit } from '../telegram/send.js';
import { reconcileUnknownExecutions } from './reconciler.js';
import { publicExecutionMode } from '../tradingModePresentation.js';

async function monitorExecutionPositions() {
  const positions = db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE status = 'open' AND coalesce(execution_mode, 'dry_run') != 'research'
    ORDER BY opened_at_ms ASC
  `).all();

  let liveFailures = 0;
  let checked = 0;
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(position => publicExecutionMode(position.execution_mode) === 'LIVE')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }

  for (const position of positions) {
    checked += 1;
    const isLivePosition = publicExecutionMode(position.execution_mode) === 'LIVE';
    // Historical `confirm` is a LIVE compatibility alias. Normalize it only in
    // memory so the shared position engine applies real-money protective-exit
    // semantics without rewriting historical storage rows.
    const monitoredPosition = isLivePosition && position.execution_mode !== 'live'
      ? { ...position, execution_mode: 'live' }
      : position;
    try {
      // Missing/ambiguous live token amounts are resolved only by the durable
      // finalized-signature reconciler. Position monitoring must not infer a
      // completed swap from a current wallet balance alone.
      const jupiterPnl = isLivePosition
        ? (walletPnlData[position.mint]?.pnl || null)
        : null;
      const result = await refreshPosition(monitoredPosition, { autoExit: true, jupiterPnl });
      if (result?.exitReason) {
        try {
          await sendPositionExit(result);
        } catch (error) {
          console.error(`[mode-monitor] sendPositionExit failed for ${position.id}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`[mode-monitor] position ${position.id} (${position.execution_mode}) ${error.message}`);
      if (isLivePosition) liveFailures += 1;
    }
  }

  if (liveFailures > 0) {
    throw new Error(`${liveFailures} live position(s) failed monitoring in this cycle`);
  }
  return { checked, liveFailures };
}

export async function monitorAllPositionsByMode() {
  // Reconcile money-grade UNKNOWN operations first. A finalized failure can
  // restore an unknown sell to open; a finalized success can recover an orphan
  // buy/exit. Irreducibly ambiguous operations remain latched and block Live.
  const reconciliation = await reconcileUnknownExecutions();

  // Research monitor catches and reports its own quote/data failures because no
  // money can be lost. Execution monitor throws only for live-position failures,
  // which keeps the existing circuit-breaker escalation semantics intact.
  const research = await monitorResearchPositions();
  const execution = await monitorExecutionPositions();
  return {
    checked: Number(research.checked || 0) + Number(execution.checked || 0),
    researchChecked: Number(research.checked || 0),
    researchFailures: Number(research.failures || 0),
    executionChecked: Number(execution.checked || 0),
    liveFailures: Number(execution.liveFailures || 0),
    reconciliationChecked: Number(reconciliation.checked || 0),
    reconciliationResolved: Number(reconciliation.resolved || 0),
    reconciliationPending: Number(reconciliation.pending || 0),
  };
}
