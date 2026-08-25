import { sendManagerMessage } from '../telegram/managerSend.js';
import { buildManagerEvidence, clearManagerMessages, recentManagerMessages, storeManagerMessage } from './tools.js';
import { answerManagerQuestion } from './llm.js';
import { collectGmgnResearch } from './gmgn.js';
import { createOwnerConfigProposal } from './configAssistant.js';

function liveAuthorizationIntent(text) {
  const value = String(text || '').toLowerCase();
  if (!/\blive\b/.test(value)) return false;
  return /(aktifkan|nyalakan|approve|setujui|otorisasi|enable|turn\s*on|mulai\s+live|go\s+live|jalankan\s+live)/i.test(value);
}

function chunkText(text, max = 3800) {
  const value = String(text || '').trim();
  if (value.length <= max) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function fallbackSummary(evidence, error) {
  const d = evidence?.decisionIntelligence || {};
  const s = evidence?.system || {};
  const readiness = evidence?.preLiveReadiness?.evaluation?.currentStage || {};
  const gmgn = evidence?.gmgnResearch;
  const gmgnLine = gmgn
    ? `GMGN research: ${gmgn.available === false ? gmgn.reason : `${gmgn.results?.filter(row => row.ok).length || 0}/${gmgn.plan?.length || 0} queries OK`}`
    : null;
  return [
    '👼 Angel Manager V2 sedang tidak bisa menghubungi LLM, tetapi deterministic read-only evidence masih tersedia.',
    '',
    `Mode: ${s.mode || 'unknown'}`,
    `Readiness: ${readiness.status || 'NOT_READY'} (${readiness.score || 0}/100)`,
    `Hard blockers: ${readiness.hardBlockers?.length || 0}`,
    `Decisions window: ${d.total || 0} (BUY ${d.verdicts?.BUY || 0} / WATCH ${d.verdicts?.WATCH || 0} / PASS ${d.verdicts?.PASS || 0})`,
    `Finalized outcomes: ${d.outcomes?.finalized || 0}`,
    `Median final R: ${Number.isFinite(Number(d.outcomes?.medianFinalR)) ? Number(d.outcomes.medianFinalR).toFixed(2) + 'R' : '—'}`,
    `Unresolved executions: ${s.liveSafety?.unresolvedExecutions ?? '—'}`,
    `Circuit breaker: ${s.liveSafety?.circuitOpen ? 'OPEN' : 'CLOSED'}`,
    gmgnLine,
    '',
    `LLM error: ${error.message}`,
    'Tidak ada setting, approval, mode, atau transaksi yang diubah.',
  ].filter(Boolean).join('\n');
}

function configProposalReply(result) {
  const { parsed, proposal } = result;
  const renderedValue = Array.isArray(parsed.value) ? JSON.stringify(parsed.value) : String(parsed.value);
  return [
    '🧬 Angel Manager membuat <b>config proposal</b> dari perintah owner.',
    '',
    `Proposal: <b>#${proposal.proposalId}</b> → <b>config-v${proposal.proposedVersion}</b>`,
    `Field: <code>${parsed.key}</code>`,
    `Proposed value: <code>${renderedValue}</code>`,
    '',
    `<b>Belum ada active config yang berubah.</b>`,
    `Mulai PAPER challenger: <code>/configapprove ${proposal.proposalId}</code>`,
    `Evaluasi: <code>/configeval ${proposal.proposalId}</code>`,
    `Batalkan: <code>/configreject ${proposal.proposalId}</code>`,
    '',
    '<i>Promotion baru diizinkan setelah evidence PAPER memenuhi gate dan owner menjalankan /configpromote.</i>',
  ].join('\n');
}

export async function handleManagerMessage(chatId, question) {
  const text = String(question || '').trim();
  if (!text) return;

  if (liveAuthorizationIntent(text)) {
    const reply = [
      '🔐 Angel Manager V2 tidak memiliki fungsi untuk approve atau mengaktifkan Live.',
      '',
      'Saya bisa membaca deterministic readiness, menjelaskan risk/evidence, melakukan riset GMGN read-only, brainstorming, dan membuat config proposal dari perintah owner.',
      'Otorisasi Live tetap harus dilakukan sendiri oleh owner melalui kontrol deterministik /livestatus dan /liveapprove.',
    ].join('\n');
    storeManagerMessage(chatId, 'user', text);
    storeManagerMessage(chatId, 'assistant', reply);
    return sendManagerMessage(chatId, reply);
  }

  try {
    const configResult = createOwnerConfigProposal({ text, chatId });
    if (configResult) {
      const reply = configProposalReply(configResult);
      storeManagerMessage(chatId, 'user', text);
      storeManagerMessage(chatId, 'assistant', reply.replace(/<[^>]+>/g, ''));
      return sendManagerMessage(chatId, reply, { parse_mode: 'HTML' });
    }
  } catch (error) {
    const reply = `❌ Config proposal ditolak: ${String(error?.message || error).slice(0, 1200)}\nActive config tidak berubah.`;
    storeManagerMessage(chatId, 'user', text);
    storeManagerMessage(chatId, 'assistant', reply);
    return sendManagerMessage(chatId, reply);
  }

  const history = recentManagerMessages(chatId, 8);
  const evidence = buildManagerEvidence(text);
  storeManagerMessage(chatId, 'user', text);

  try {
    const gmgnResearch = await collectGmgnResearch(text);
    if (gmgnResearch) evidence.gmgnResearch = gmgnResearch;
  } catch (error) {
    evidence.gmgnResearch = {
      source: 'gmgn-cli',
      readOnly: true,
      available: false,
      reason: 'GMGN_RESEARCH_GATEWAY_ERROR',
      error: String(error?.message || error).slice(0, 1000),
    };
  }

  let answer;
  try {
    const response = await answerManagerQuestion({ question: text, evidence, history });
    answer = response.content;
  } catch (error) {
    answer = fallbackSummary(evidence, error);
  }
  storeManagerMessage(chatId, 'assistant', answer);

  for (const chunk of chunkText(answer)) {
    await sendManagerMessage(chatId, chunk, { disable_web_page_preview: true });
  }
}

export function clearManagerConversation(chatId) {
  const removed = clearManagerMessages(chatId);
  return sendManagerMessage(chatId, `🧹 Angel Manager memory cleared (${removed} message${removed === 1 ? '' : 's'} removed). Trading evidence/receipts were not deleted.`);
}
