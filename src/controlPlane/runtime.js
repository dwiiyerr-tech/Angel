import { db } from '../db/connection.js';
import { sendTelegram } from '../telegram/send.js';
import { runStrategyReview } from './analyst.js';
import { evaluateChallenger, runAutomaticRollbackCheck } from './challenger.js';
import { bootstrapConfigRegistry, openStrategyProposal } from './registry.js';
import { ensureControlPlaneSchema } from './schema.js';
import { setupControlPlaneTelegram } from './telegram.js';

let started = false;

function scheduleAfterCompletion(fn, intervalMs, firstDelayMs) {
  const run = async () => {
    try { await fn(); } catch (error) { console.error(`[control-plane] scheduled cycle failed: ${error.message}`); }
    setTimeout(run, intervalMs);
  };
  setTimeout(run, firstDelayMs);
}

async function scheduledStrategyReview() {
  const result = await runStrategyReview({ source: 'weekly_scheduler', actor: 'strategy_analyst' });
  if (result.status === 'proposal_created') {
    await sendTelegram([
      '🧬 <b>Strategy challenger proposed</b>',
      '',
      `Proposal #${result.proposal.proposalId} → config-v${result.proposal.proposedVersion}`,
      `Research evidence: ${result.evidence.research.closed} closed · expectancy ${Number(result.evidence.research.expectancyR || 0).toFixed(2)}R`,
      '',
      `Review with <code>/configstatus</code> and approve Shadow testing with <code>/configapprove ${result.proposal.proposalId}</code>.`,
      '<i>No settings were changed.</i>',
    ].join('\n'));
  } else {
    console.log(`[control-plane] weekly review: ${result.status}; no configuration changes`);
  }
}

async function guardCycle() {
  const proposal = openStrategyProposal();
  if (proposal && ['testing', 'promotion_ready'].includes(proposal.status)) {
    try {
      const evaluation = evaluateChallenger(proposal.id);
      if (evaluation.status === 'promotion_ready' && proposal.status !== 'promotion_ready') {
        await sendTelegram(`📊 <b>Config challenger #${proposal.id} is promotion-ready</b>\nUse <code>/configeval ${proposal.id}</code> to review evidence, then <code>/configpromote ${proposal.id}</code> only if you approve.`);
      }
    } catch (error) {
      console.warn(`[control-plane] challenger evaluation degraded: ${error.message}`);
    }
  }

  const rollback = runAutomaticRollbackCheck();
  if (rollback.rolledBack) {
    await sendTelegram([
      '↩️ <b>AUTOMATIC PRE-LIVE CONFIG ROLLBACK</b>',
      '',
      `Restored ${rollback.active.label}.`,
      `Sample: ${rollback.evaluation.sample}`,
      `Observed expectancy: ${Number(rollback.evaluation.expectancyR).toFixed(2)}R`,
      '',
      'Rollback is only automatic in Research/Shadow no-broadcast mode. Live approval must be recreated after any config change.',
    ].join('\n'));
  }
}

export function startControlPlaneRuntime() {
  if (started) return;
  started = true;
  ensureControlPlaneSchema();
  const active = bootstrapConfigRegistry();
  setupControlPlaneTelegram();
  console.log(`[control-plane] active ${active.label} ${active.config_hash.slice(0, 12)}…`);

  const weekMs = 14 * 24 * 60 * 60 * 1000;
  const lastReviewAt = Number(db.prepare('SELECT MAX(created_at_ms) AS at_ms FROM strategy_review_runs').get()?.at_ms || 0);
  const firstReviewDelay = lastReviewAt
    ? Math.max(60_000, weekMs - (Date.now() - lastReviewAt))
    : 2 * 60 * 60 * 1000;
  scheduleAfterCompletion(scheduledStrategyReview, weekMs, firstReviewDelay);
  scheduleAfterCompletion(guardCycle, 60 * 60 * 1000, 5 * 60 * 1000);
}
