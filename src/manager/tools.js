import { db } from '../db/connection.js';
import { approvedLiveConfig } from '../db/liveConfig.js';
import { parseWindowMs } from '../utils.js';
import { ensureResearchSchema } from '../research/schema.js';
import {
  decisionIntelligenceSummary,
  latestDecisionReceiptDetailsByMint,
  loadDecisionReceiptDetails,
  recentDecisionReceipts,
} from '../decisionIntelligence/report.js';
import { ensureDecisionIntelligenceSchema } from '../decisionIntelligence/schema.js';
import { preLiveReadinessReport } from '../readiness/engine.js';

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function windowFromQuestion(question) {
  const text = String(question || '').toLowerCase();
  const match = text.match(/\b(\d+(?:\.\d+)?\s*(?:m|h|d))\b/);
  if (match) return parseWindowMs(match[1].replace(/\s+/g, ''));
  const readinessIntent = /(readiness|kesiapan|siap\s+(?:untuk\s+)?(?:shadow|confirm|live)|ready\s+(?:for\s+)?(?:shadow|confirm|live)|layak\s+(?:naik|masuk|dipertimbangkan))/i.test(text);
  return parseWindowMs(readinessIntent ? '7d' : '24h');
}

function receiptReferenceFromQuestion(question) {
  const text = String(question || '');
  const explicit = text.match(/(?:receipt|decision|keputusan)\s*#?\s*(\d+)/i);
  return explicit ? Number(explicit[1]) : null;
}

function mintFromQuestion(question) {
  const tokens = String(question || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  return tokens[0] || null;
}

function compactDetails(details) {
  if (!details) return null;
  const { receipt, snapshot, probe, observations, outcome } = details;
  return {
    receiptId: receipt.id,
    decisionId: receipt.decision_id,
    decisionTimeMs: receipt.created_at_ms,
    mint: receipt.mint,
    symbol: snapshot.token?.symbol || snapshot.token?.name || null,
    verdict: receipt.verdict,
    confidence: receipt.confidence,
    mode: receipt.mode,
    route: receipt.route,
    source: snapshot.source,
    safety: snapshot.safety,
    market: {
      metrics: snapshot.metrics,
      holders: {
        count: snapshot.holders?.count,
        top20Percent: snapshot.holders?.top20Percent,
        maxHolderPercent: snapshot.holders?.maxHolderPercent,
      },
    },
    edge: {
      quality: snapshot.quality,
      momentum: snapshot.momentum,
      runner: snapshot.runner,
      route: snapshot.routeEdge,
      combined: snapshot.combinedEdge,
    },
    riskPlan: snapshot.riskPlan,
    reason: snapshot.decision?.reason || null,
    risks: snapshot.decision?.risks || [],
    executionProbe: probe ? {
      status: probe.status,
      simNotionalSol: probe.sim_notional_sol,
      decisionToProbeMs: probe.decision_to_probe_ms,
      quoteToFillLatencyMs: probe.quote_to_fill_latency_ms,
      quoteDeteriorationPct: probe.quote_deterioration_pct,
      roundtripSpreadPct: probe.roundtrip_spread_pct,
      sizeImpactPct: probe.size_impact_pct,
      entryFeeSol: probe.entry_fee_sol,
      expectedExitFeeSol: probe.expected_exit_fee_sol,
      slippageToleranceBps: probe.slippage_tolerance_bps,
      error: probe.error,
    } : null,
    outcomeObservations: observations.map(row => ({
      horizonMs: row.horizon_ms,
      status: row.status,
      pnlPercent: row.pnl_percent,
      r: row.r_multiple,
      error: row.error,
    })),
    outcome: outcome ? {
      finalR: outcome.final_r,
      sampledMfeR: outcome.sampled_mfe_r,
      sampledMaeR: outcome.sampled_mae_r,
      classification: outcome.classification,
      dataQuality: outcome.data_quality,
    } : null,
  };
}

function liveSafetySnapshot() {
  const unresolved = Number(db.prepare("SELECT COUNT(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get()?.count || 0);
  const circuitOpen = ['true', '1'].includes(String(db.prepare("SELECT value FROM settings WHERE key = 'live_circuit_breaker_open'").get()?.value || 'false'));
  const activeReservations = tableExists('live_capital_reservations')
    ? db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size_sol), 0) AS exposure FROM live_capital_reservations WHERE status = 'active'").get()
    : { count: 0, exposure: 0 };
  const unknownPositions = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM dry_run_positions
    WHERE execution_mode = 'live' AND status IN ('entry_unknown', 'exit_unknown', 'partial_exit_unknown')
  `).get()?.count || 0);
  let approved = null;
  try { approved = approvedLiveConfig(); } catch { approved = null; }
  return {
    circuitOpen,
    unresolvedExecutions: unresolved,
    activeCapitalReservations: Number(activeReservations?.count || 0),
    reservedExposureSol: Number(activeReservations?.exposure || 0),
    unknownLivePositions: unknownPositions,
    currentConfigHasValidHumanApproval: Boolean(approved),
    approvedSnapshotId: approved?.id || null,
    liveEligibleFromThisTool: false,
    note: 'This is read-only evidence. Only deterministic owner commands can authorize Live.',
  };
}

function systemSnapshot() {
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
  const agentEnabled = db.prepare("SELECT value FROM settings WHERE key = 'agent_enabled'").get()?.value || 'true';
  const open = db.prepare(`
    SELECT execution_mode, COUNT(*) AS count, COALESCE(SUM(size_sol), 0) AS exposure
    FROM dry_run_positions
    WHERE status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
    GROUP BY execution_mode
  `).all();
  const strategy = db.prepare('SELECT id, name FROM strategies WHERE enabled = 1 LIMIT 1').get() || null;
  return {
    mode,
    agentEnabled: ['true', '1'].includes(String(agentEnabled)),
    activeStrategy: strategy,
    openPositionsByMode: open,
    liveSafety: liveSafetySnapshot(),
  };
}

function controlPlaneSnapshot() {
  if (!tableExists('config_versions')) return { available: false };
  const active = db.prepare("SELECT version, label, status, config_hash, created_at_ms FROM config_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1").get() || null;
  const proposal = tableExists('strategy_proposals')
    ? db.prepare("SELECT id, status, created_at_ms, proposed_version FROM strategy_proposals WHERE status IN ('pending_review', 'testing', 'promotion_ready', 'needs_extension') ORDER BY id DESC LIMIT 1").get() || null
    : null;
  return { available: true, active, openProposal: proposal };
}

function positionsSnapshot(limit = 8) {
  return db.prepare(`
    SELECT id, mint, symbol, status, execution_mode, size_sol, sim_notional_sol,
           opened_at_ms, pnl_percent, pnl_sol, realized_r, mfe_r, mae_r,
           tp_percent, sl_percent, exit_reason
    FROM dry_run_positions
    ORDER BY id DESC LIMIT ?
  `).all(Math.max(1, Math.min(20, Number(limit) || 8)));
}

export function buildManagerEvidence(question) {
  ensureResearchSchema();
  ensureDecisionIntelligenceSchema();
  const windowMs = windowFromQuestion(question);
  const receiptId = receiptReferenceFromQuestion(question);
  const mint = mintFromQuestion(question);
  let focusDecision = null;
  if (receiptId) focusDecision = compactDetails(loadDecisionReceiptDetails(receiptId));
  else if (mint) focusDecision = compactDetails(latestDecisionReceiptDetailsByMint(mint));

  return {
    evidenceVersion: 'angel-manager-evidence-v2',
    generatedAtMs: Date.now(),
    questionWindowMs: windowMs,
    authority: {
      managerMode: 'read_only',
      canApproveLive: false,
      canEnableLive: false,
      canSignTransactions: false,
      canBroadcastTransactions: false,
      canMutateSettings: false,
      canProposeAnalysis: true,
      humanOwnerIsSoleLiveAuthority: true,
    },
    system: systemSnapshot(),
    controlPlane: controlPlaneSnapshot(),
    preLiveReadiness: preLiveReadinessReport(windowMs),
    decisionIntelligence: decisionIntelligenceSummary(windowMs),
    recentDecisions: recentDecisionReceipts(10),
    recentPositions: positionsSnapshot(8),
    focusDecision,
  };
}

export function recentManagerMessages(chatId, limit = 8) {
  ensureDecisionIntelligenceSchema();
  return db.prepare(`
    SELECT role, content, created_at_ms FROM manager_messages
    WHERE chat_id = ? ORDER BY id DESC LIMIT ?
  `).all(String(chatId), Math.max(1, Math.min(20, Number(limit) || 8))).reverse();
}

export function storeManagerMessage(chatId, role, content) {
  ensureDecisionIntelligenceSchema();
  db.prepare(`
    INSERT INTO manager_messages (chat_id, role, created_at_ms, content)
    VALUES (?, ?, ?, ?)
  `).run(String(chatId), role, Date.now(), String(content || '').slice(0, 12_000));
  // Bound persistent conversational context; historical trading evidence stays in
  // its own immutable/report tables and is never deleted here.
  db.prepare(`
    DELETE FROM manager_messages
    WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM manager_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 40
    )
  `).run(String(chatId), String(chatId));
}

export function clearManagerMessages(chatId) {
  ensureDecisionIntelligenceSchema();
  return db.prepare('DELETE FROM manager_messages WHERE chat_id = ?').run(String(chatId)).changes;
}
