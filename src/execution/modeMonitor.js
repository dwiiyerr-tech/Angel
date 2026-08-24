import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { refreshPosition } from './positions.js';
import { monitorResearchPositions } from '../research/monitor.js';
import { fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { fetchLiveTokenBalance, liveWalletPubkey } from '../liveExecutor.js';
import { sendPositionExit } from '../telegram/send.js';

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
  if (pubkey && positions.some(position => position.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }

  for (const position of positions) {
    checked += 1;
    try {
      if (position.execution_mode === 'live' && !position.token_amount_raw) {
        const recoveredAmount = await fetchLiveTokenBalance(position.mint);
        if (recoveredAmount && BigInt(recoveredAmount) > 0n) {
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?')
            .run(String(recoveredAmount), position.id);
          position.token_amount_raw = String(recoveredAmount);
          db.prepare(`
            UPDATE execution_operations
            SET output_amount = ?, status = 'completed', error = NULL, updated_at_ms = ?
            WHERE position_id = ? AND side = 'buy' AND status = 'outcome_unknown'
          `).run(String(recoveredAmount), now(), position.id);
        }
      }

      const jupiterPnl = position.execution_mode === 'live'
        ? (walletPnlData[position.mint]?.pnl || null)
        : null;
      const result = await refreshPosition(position, { autoExit: true, jupiterPnl });
      if (result?.exitReason) {
        try {
          await sendPositionExit(result);
        } catch (error) {
          console.error(`[mode-monitor] sendPositionExit failed for ${position.id}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`[mode-monitor] position ${position.id} (${position.execution_mode}) ${error.message}`);
      if (position.execution_mode === 'live') liveFailures += 1;
    }
  }

  if (liveFailures > 0) {
    throw new Error(`${liveFailures} live position(s) failed monitoring in this cycle`);
  }
  return { checked, liveFailures };
}

export async function monitorAllPositionsByMode() {
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
  };
}
