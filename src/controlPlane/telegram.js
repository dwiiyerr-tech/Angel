import { TELEGRAM_CHAT_ID } from '../config.js';
import { escapeHtml } from '../format.js';
import { bot } from '../telegram/bot.js';
import { runStrategyReview, latestStrategyReview } from './analyst.js';
import { evaluateChallenger } from './challenger.js';
import {
  activeConfigVersion,
  approveProposalForTest,
  extendProposalTest,
  openStrategyProposal,
  promoteProposal,
  rejectProposal,
  rollbackToParent,
} from './registry.js';

let installed = false;

function authorized(msg) {
  return String(msg?.chat?.id) === String(TELEGRAM_CHAT_ID);
}

function parseWindow(value) {
  const text = String(value || '7d').trim().toLowerCase();
  const match = text.match(/^(\d+)(h|d)$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const amount = Math.max(1, Math.min(30, Number(match[1])));
  return amount * (match[2] === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
}

function pct(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'n/a';
}

function r(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}R` : 'n/a';
}

function proposalText(proposal) {
  if (!proposal) return 'No open proposal.';
  const changes = proposal.proposal?.changes || [];
  return [
    `Proposal <b>#${proposal.id}</b> → <b>config-v${proposal.proposed_version}</b>`,
    `Status: <b>${escapeHtml(proposal.status)}</b>`,
    ...changes.map(change => `• <code>${escapeHtml(change.key)}</code> → <code>${escapeHtml(String(change.value))}</code>`),
  ].join('\n');
}

async function safeReply(msg, fn) {
  if (!authorized(msg)) return;
  try {
    const text = await fn();
    if (text) await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (error) {
    await bot.sendMessage(msg.chat.id, `❌ Control-plane error: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
  }
}

export function setupControlPlaneTelegram() {
  if (installed) return;
  installed = true;

  bot.onText(/^\/configstatus(?:@\w+)?$/i, msg => safeReply(msg, async () => {
    const active = activeConfigVersion();
    const proposal = openStrategyProposal();
    const review = latestStrategyReview();
    return [
      '🧬 <b>ANGEL STRATEGY CONTROL PLANE</b>',
      '',
      `Active: <b>${escapeHtml(active?.label || 'not bootstrapped')}</b>`,
      `Hash: <code>${escapeHtml((active?.config_hash || '').slice(0, 16))}…</code>`,
      `Prompt set: <b>${escapeHtml(active?.prompt_set_version || 'n/a')}</b>`,
      '',
      proposalText(proposal),
      '',
      `Latest review: <b>${escapeHtml(review?.status || 'none')}</b>`,
    ].join('\n');
  }));

  bot.onText(/^\/configreview(?:@\w+)?(?:\s+(\S+))?$/i, (msg, match) => safeReply(msg, async () => {
    const result = await runStrategyReview({ windowMs: parseWindow(match?.[1]), source: 'telegram', actor: 'telegram_human' });
    if (result.status === 'proposal_created') {
      return [
        '🧠 <b>Strategy Analyst Proposal</b>',
        '',
        `Review #${result.reviewRunId}`,
        `Research: ${result.evidence.research.closed} closed · WR ${pct(result.evidence.research.winRate)} · Exp ${r(result.evidence.research.expectancyR)}`,
        '',
        `Proposal #${result.proposal.proposalId} → config-v${result.proposal.proposedVersion}`,
        ...result.proposal.changes.map(change => `• <code>${escapeHtml(change.key)}</code> → <code>${escapeHtml(String(change.value))}</code>`),
        '',
        `Approve Shadow test: <code>/configapprove ${result.proposal.proposalId}</code>`,
        `<i>No settings were changed.</i>`,
      ].join('\n');
    }
    if (result.status === 'open_proposal_exists') return proposalText(result.proposal);
    return [
      '🧠 <b>Strategy Analyst</b>',
      '',
      `Result: <b>${escapeHtml(result.status)}</b>`,
      `Research: ${result.evidence.research.closed} closed · Exp ${r(result.evidence.research.expectancyR)}`,
      escapeHtml(result.analysis?.rationale || 'No proposal.'),
      '',
      '<i>No settings were changed.</i>',
    ].join('\n');
  }));

  bot.onText(/^\/configapprove(?:@\w+)?\s+(\d+)$/i, (msg, match) => safeReply(msg, async () => {
    const proposal = approveProposalForTest(Number(match?.[1]), 'telegram_human');
    return `✅ Proposal #${proposal.id} approved for <b>Shadow challenger testing only</b> until ${new Date(proposal.test_until_ms).toISOString()}.\nNo active settings changed.`;
  }));

  bot.onText(/^\/configreject(?:@\w+)?\s+(\d+)(?:\s+(.+))?$/i, (msg, match) => safeReply(msg, async () => {
    const proposal = rejectProposal(Number(match?.[1]), match?.[2] || '', 'telegram_human');
    return `🗑️ Proposal #${proposal.id} rejected. Active config unchanged.`;
  }));

  bot.onText(/^\/configextend(?:@\w+)?\s+(\d+)(?:\s+(\d+))?$/i, (msg, match) => safeReply(msg, async () => {
    const proposal = extendProposalTest(Number(match?.[1]), Number(match?.[2] || 7), 'telegram_human');
    return `⏳ Proposal #${proposal.id} challenger extended until ${new Date(proposal.test_until_ms).toISOString()}.`;
  }));

  bot.onText(/^\/configeval(?:@\w+)?\s+(\d+)$/i, (msg, match) => safeReply(msg, async () => {
    const result = evaluateChallenger(Number(match?.[1]));
    return [
      '📊 <b>Challenger Evaluation</b>',
      '',
      `Proposal #${result.proposalId} · <b>${escapeHtml(result.status)}</b>`,
      `Control: n=${result.active.sample} · WR ${pct(result.active.winRate)} · Exp ${r(result.active.expectancyR)}`,
      `Challenger: n=${result.challenger.sample} · WR ${pct(result.challenger.winRate)} · Exp ${r(result.challenger.expectancyR)}`,
      `Δ Expectancy: ${r(result.expectancyDeltaR)}`,
      `Promotion ready: <b>${result.promotionReady ? 'YES' : 'NO'}</b>`,
    ].join('\n');
  }));

  bot.onText(/^\/configpromote(?:@\w+)?\s+(\d+)$/i, (msg, match) => safeReply(msg, async () => {
    const active = promoteProposal(Number(match?.[1]), 'telegram_human');
    return [
      `✅ <b>${escapeHtml(active.label)} promoted</b>`,
      'Promotion occurred only in Research/Shadow no-broadcast mode.',
      'Any previous Live approval checksum is now stale; create a fresh /liveapprove snapshot before Live.',
    ].join('\n');
  }));

  bot.onText(/^\/configrollback(?:@\w+)?\s+(\d+)(?:\s+(.+))?$/i, (msg, match) => safeReply(msg, async () => {
    const active = rollbackToParent(Number(match?.[1]), match?.[2] || 'manual Telegram rollback', 'telegram_human');
    return `↩️ Rolled back to <b>${escapeHtml(active.label)}</b>. Mode is forced to no-broadcast Research if needed; Live requires fresh approval.`;
  }));
}
