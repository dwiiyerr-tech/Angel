import { db } from '../db/connection.js';
import { activeStrategy, boolSetting, numSetting } from '../db/settings.js';
import { candidateById, updateCandidateSnapshot, updateCandidateStatus, upsertCandidate } from '../db/candidates.js';
import { logDecisionEvent, storeDecision } from '../db/decisions.js';
import { firstPositiveNumber, marketCapFromGmgn, now, tokenPriceFromGmgn } from '../utils.js';
import { gmgnLink } from '../format.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterChartContext, fetchJupiterHolders } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { filterCandidate, signalLabel } from '../pipeline/candidateBuilder.js';
import { preScoreCandidate } from '../pipeline/preScorer.js';
import { momentumFilter } from '../pipeline/momentumFilter.js';
import { decideCandidateBatch } from '../pipeline/llm.js';
import { hunterPolicy } from '../pipeline/hunterPolicy.js';
import { applyContractSafetyGate } from '../execution/contractSafetyGate.js';
import {
  canOpenResearchPosition,
  executeResearchEntry,
  openResearchPositionCount,
  researchPositionCap,
} from './engine.js';
import { isResearchSimulationMode } from './policy.js';
import { recordSignalProcessed } from '../health/deadMansSwitch.js';
import { observeVolumeAcceleration } from '../pipeline/volumeAcceleration.js';

export const FAST_HUNTER_VERSION = 'research-fast-hunter-v1';
export const FAST_HUNTER_ROUTES = Object.freeze(['pumpportal_graduated', 'pumpfun_pregrad']);

const FAST_ROUTE_SET = new Set(FAST_HUNTER_ROUTES);
const processingMints = new Set();
let schemaReady = false;

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function raceBudget(promise, budgetMs, fallback = null) {
  const bounded = Math.max(0, Math.min(10_000, Number(budgetMs) || 0));
  if (bounded === 0) return Promise.resolve(fallback);
  return Promise.race([
    promise.catch(() => fallback),
    new Promise(resolve => setTimeout(() => resolve(fallback), bounded)),
  ]);
}

export function ensureFastHunterSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS fast_hunter_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      position_id INTEGER,
      mint TEXT NOT NULL,
      route TEXT NOT NULL,
      version TEXT NOT NULL,
      signal_at_ms INTEGER NOT NULL,
      essential_done_ms INTEGER,
      safety_done_ms INTEGER,
      momentum_done_ms INTEGER,
      decision_done_ms INTEGER,
      entry_done_ms INTEGER,
      late_enrichment_done_ms INTEGER,
      llm_done_ms INTEGER,
      fast_decision TEXT,
      fast_confidence REAL,
      full_filter_passed INTEGER,
      full_filter_score REAL,
      llm_verdict TEXT,
      llm_confidence REAL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS fast_hunter_advisories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL UNIQUE,
      candidate_id INTEGER NOT NULL,
      position_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      late_snapshot_json TEXT,
      llm_json TEXT,
      comparison_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_fast_hunter_runs_route_signal
      ON fast_hunter_runs(route, signal_at_ms);
    CREATE INDEX IF NOT EXISTS idx_fast_hunter_runs_candidate
      ON fast_hunter_runs(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_fast_hunter_advisories_candidate
      ON fast_hunter_advisories(candidate_id);
  `);
  schemaReady = true;
}

export function resetFastHunterSchemaForTests() {
  schemaReady = false;
}

export function isFastHunterRoute(route) {
  return FAST_ROUTE_SET.has(String(route || ''));
}

export function isFastHunterSignal(signals) {
  return isResearchSimulationMode()
    && boolSetting('research_fast_hunter_enabled', true)
    && isFastHunterRoute(signals?.route);
}

function insertRun({ candidateId, mint, route, signalAtMs, essentialDoneMs, safetyDoneMs, status, payload = {} }) {
  ensureFastHunterSchema();
  const result = db.prepare(`
    INSERT INTO fast_hunter_runs (
      candidate_id, mint, route, version, signal_at_ms, essential_done_ms,
      safety_done_ms, status, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    mint,
    route,
    FAST_HUNTER_VERSION,
    signalAtMs,
    essentialDoneMs,
    safetyDoneMs,
    status,
    json(payload),
  );
  return Number(result.lastInsertRowid);
}

function patchRun(runId, patch = {}) {
  ensureFastHunterSchema();
  const allowed = new Set([
    'position_id', 'momentum_done_ms', 'decision_done_ms', 'entry_done_ms',
    'late_enrichment_done_ms', 'llm_done_ms', 'fast_decision', 'fast_confidence',
    'full_filter_passed', 'full_filter_score', 'llm_verdict', 'llm_confidence', 'status',
  ]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const sql = `UPDATE fast_hunter_runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...entries.map(([, value]) => value), runId);
}

function mergeRunPayload(runId, extra = {}) {
  ensureFastHunterSchema();
  const row = db.prepare('SELECT payload_json FROM fast_hunter_runs WHERE id = ?').get(runId);
  const current = safeJson(row?.payload_json, {});
  db.prepare('UPDATE fast_hunter_runs SET payload_json = ? WHERE id = ?')
    .run(json({ ...current, ...extra }), runId);
}

function riskSeverity(candidate) {
  return (candidate?.riskFlags || []).reduce((sum, flag) => sum + Math.max(0, Number(flag?.severity) || 0), 0);
}

function fastCapacity() {
  return {
    allowed: canOpenResearchPosition(),
    open: openResearchPositionCount(),
    max: researchPositionCap(),
  };
}

function recentCandidateExists(mint, ageMs = 10 * 60 * 1000) {
  try {
    return Boolean(db.prepare(`
      SELECT id FROM candidates
      WHERE mint = ? AND created_at_ms > ?
      LIMIT 1
    `).get(mint, now() - ageMs));
  } catch {
    return false;
  }
}

function activePositionExists(mint) {
  try {
    return Boolean(db.prepare(`
      SELECT id FROM dry_run_positions
      WHERE mint = ? AND status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
      LIMIT 1
    `).get(mint));
  } catch {
    return false;
  }
}

function sourceGmgnFromSignal(signals) {
  return signals?.graduatedCoin?.gmgnInfo || null;
}

async function buildEssentialCandidate(signals, signalAtMs) {
  const { mint, graduatedCoin = null, trendingToken = null, trenchesEntry = null, pregradToken = null, route } = signals;
  const strat = activeStrategy();
  const seededGmgn = sourceGmgnFromSignal(signals);
  const gmgnPromise = seededGmgn
    ? Promise.resolve(seededGmgn)
    : fetchGmgnTokenInfo(mint).catch(() => null);
  const gmgnBudgetMs = Math.max(0, numSetting('research_fast_hunter_gmgn_budget_ms', 1500));

  const [jupiterAsset, holders, budgetedGmgn] = await Promise.all([
    fetchJupiterAsset(mint),
    fetchJupiterHolders(mint),
    raceBudget(gmgnPromise, gmgnBudgetMs, null),
  ]);
  const gmgn = budgetedGmgn || seededGmgn || null;

  const priceUsd = firstPositiveNumber(
    tokenPriceFromGmgn(gmgn),
    jupiterAsset?.usdPrice,
    trendingToken?.price,
    trenchesEntry?.price,
  );
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
    pregradToken?.usd_market_cap,
  );
  const holderCount = positiveNumber(
    gmgn?.holder_count,
    jupiterAsset?.holderCount,
    holders?.count,
    trendingToken?.holder_count,
    graduatedCoin?.numHolders,
  ) || 0;
  const liquidityUsd = positiveNumber(
    gmgn?.liquidity,
    jupiterAsset?.liquidity,
    trendingToken?.liquidity,
    trenchesEntry?.liquidity,
  ) || 0;

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || pregradToken?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || pregradToken?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || pregradToken?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || '',
      website: graduatedCoin?.website || pregradToken?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || pregradToken?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd,
      holderCount,
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? graduatedCoin?.usd_market_cap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
      dexBuys5m: nullableNumber(jupiterAsset?.stats5m?.numBuys ?? jupiterAsset?.stats5m?.buys),
      dexSells5m: nullableNumber(jupiterAsset?.stats5m?.numSells ?? jupiterAsset?.stats5m?.sells),
      pregradRssrSol: Number(pregradToken?.real_sol_reserves_sol ?? 0),
      pregradRssrPctToGrad: Number(pregradToken?.rssr_pct_to_grad ?? 0),
      pregradReplyCount: Number(pregradToken?.reply_count ?? 0),
      volumeUsd: nullableNumber(trendingToken?.volume ?? gmgn?.volume_24h),
    },
    signals: {
      route,
      label: signalLabel({
        hasFeeClaim: false,
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: false,
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signals.signature || null,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    pregradToken,
    trending: trendingToken,
    trenchesEntry,
    feeClaim: null,
    gmgn,
    jupiterAsset,
    holders: holders || {
      count: null,
      holders: [],
      top20: [],
      top20Percent: null,
      maxHolderPercent: null,
      dataQuality: { source: 'jupiter_holders', available: false },
    },
    chart: null,
    savedWalletExposure: { holderCount: 0, holders: [], deferred: true },
    twitterNarrative: null,
    dataQuality: {
      jupiterAsset: jupiterAsset?._dataQuality || { source: 'jupiter', available: false },
      holders: holders?.dataQuality || { source: 'jupiter_holders', available: false },
      gmgn: { source: 'gmgn', available: Boolean(gmgn), deferred: !gmgn },
      chart: { source: 'jupiter_chart', available: false, deferred: true },
      twitter: { source: 'fxtwitter', available: false, deferred: true },
      savedWallet: { source: 'saved_wallets', available: false, deferred: true },
    },
    fastHunter: {
      version: FAST_HUNTER_VERSION,
      enabled: true,
      researchOnly: true,
      signalReceivedAtMs: signalAtMs,
      gmgnBudgetMs,
      criticalPathSources: ['jupiter_asset', 'jupiter_holders'],
      deferredSources: ['gmgn_deep', 'jupiter_chart', 'saved_wallet', 'twitter', 'llm'],
    },
    createdAtMs: signalAtMs,
  };

  candidate.volumeAcceleration = trendingToken?.volumeAcceleration?.valid
    ? trendingToken.volumeAcceleration
    : observeVolumeAcceleration(candidate);
  candidate.filters = filterCandidate(candidate);
  return candidate;
}

function buildFastDecision(candidate, candidateId) {
  const strat = activeStrategy();
  const prescore = Number(candidate.filters?.preScore);
  const momentum = Number(candidate.filters?.momentumScore);
  const derivedConfidence = Math.max(
    numSetting('research_min_confidence', 30),
    Math.min(100, Number.isFinite(prescore) ? prescore : 50),
  );
  const policy = hunterPolicy({
    confidence: derivedConfidence,
    preScore: prescore,
    momentum,
    totalSoftRiskSeverity: riskSeverity(candidate),
    catastrophic: candidate.contractSafety?.passed === false,
  });
  const buy = policy.action === 'TRADE' && candidate.contractSafety?.passed !== false;
  return {
    verdict: buy ? 'BUY' : 'WATCH',
    confidence: Math.max(0, Math.min(100, Number(policy.score ?? derivedConfidence) || 0)),
    selected_candidate_id: buy ? candidateId : null,
    selected_mint: buy ? candidate.token.mint : null,
    selected_row: null,
    reason: `Research Fast Hunter ${policy.tier}: ${buy ? 'zero-capital sample admitted without waiting for deep enrichment/LLM' : 'insufficient deterministic edge for immediate sample'}.`,
    risks: (candidate.riskFlags || []).map(flag => flag.reason || flag.type).filter(Boolean).slice(0, 8),
    suggested_tp_percent: Number(strat.tp_percent ?? numSetting('default_tp_percent', 50)),
    suggested_sl_percent: Number(strat.sl_percent ?? numSetting('default_sl_percent', -25)),
    research_hunter_policy: policy,
    fast_hunter: {
      version: FAST_HUNTER_VERSION,
      llmAdvisoryPending: true,
      deepEnrichmentPending: true,
    },
    raw: null,
  };
}

function applyLateEvidence(baseCandidate, { gmgn, chart, savedWalletExposure, twitterNarrative }) {
  const snapshot = cloneJson(baseCandidate);
  const originalFilters = cloneJson(baseCandidate.filters || {});
  const originalRiskFlags = cloneJson(baseCandidate.riskFlags || []);

  snapshot.gmgn = gmgn || snapshot.gmgn || null;
  snapshot.chart = chart || null;
  snapshot.savedWalletExposure = savedWalletExposure || { holderCount: 0, holders: [] };
  snapshot.twitterNarrative = twitterNarrative || null;
  snapshot.metrics = { ...(snapshot.metrics || {}) };
  snapshot.metrics.priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), snapshot.metrics.priceUsd);
  snapshot.metrics.marketCapUsd = firstPositiveNumber(marketCapFromGmgn(gmgn), snapshot.metrics.marketCapUsd);
  snapshot.metrics.liquidityUsd = positiveNumber(gmgn?.liquidity, snapshot.metrics.liquidityUsd) || 0;
  snapshot.metrics.holderCount = positiveNumber(gmgn?.holder_count, snapshot.metrics.holderCount) || 0;
  snapshot.metrics.gmgnTotalFeesSol = Number(gmgn?.total_fee ?? snapshot.metrics.gmgnTotalFeesSol ?? 0);
  snapshot.metrics.gmgnTradeFeesSol = Number(gmgn?.trade_fee ?? snapshot.metrics.gmgnTradeFeesSol ?? 0);
  snapshot.metrics.volumeUsd = nullableNumber(gmgn?.volume_24h ?? snapshot.metrics.volumeUsd);
  snapshot.dataQuality = {
    ...(snapshot.dataQuality || {}),
    gmgn: { source: 'gmgn', available: Boolean(gmgn), deferred: false },
    chart: { source: 'jupiter_chart', available: Boolean(chart?.windows?.some(window => window.available)), deferred: false },
    twitter: { source: 'fxtwitter', available: Boolean(twitterNarrative), deferred: false },
    savedWallet: { source: 'saved_wallets', available: Boolean(savedWalletExposure), deferred: false },
  };

  const hypothetical = cloneJson(snapshot);
  hypothetical.filters = originalFilters;
  hypothetical.riskFlags = originalRiskFlags;
  const lateFilters = filterCandidate(hypothetical);

  snapshot.filters = originalFilters;
  snapshot.riskFlags = originalRiskFlags;
  snapshot.fastHunter = {
    ...(snapshot.fastHunter || {}),
    deepEnrichmentPending: false,
    lateEnrichmentCompletedAtMs: now(),
  };
  snapshot.lateAssessment = {
    version: 'fast-hunter-full-context-counterfactual-v1',
    advisoryOnly: true,
    doesNotRewriteEntryDecision: true,
    filters: lateFilters,
  };
  return snapshot;
}

async function completeBackgroundEvidence({ runId, candidateId, positionId }) {
  try {
    const initialRow = candidateById(candidateId);
    if (!initialRow?.candidate) return;
    const base = initialRow.candidate;
    const mint = base.token?.mint;
    if (!mint) return;

    const gmgnPromise = fetchGmgnTokenInfo(mint).catch(() => null);
    const chartPromise = fetchJupiterChartContext(mint).catch(() => null);
    const walletPromise = fetchSavedWalletExposure(mint, base.holders).catch(() => ({ holderCount: 0, holders: [] }));
    const twitterPromise = gmgnPromise.then(gmgn => (
      fetchTwitterNarrative(base.graduation || base.jupiterAsset, gmgn).catch(() => null)
    ));

    const [gmgn, chart, savedWalletExposure, twitterNarrative] = await Promise.all([
      gmgnPromise,
      chartPromise,
      walletPromise,
      twitterPromise,
    ]);
    const enriched = applyLateEvidence(base, { gmgn, chart, savedWalletExposure, twitterNarrative });
    updateCandidateSnapshot(candidateId, enriched);
    const lateDone = now();
    patchRun(runId, {
      late_enrichment_done_ms: lateDone,
      full_filter_passed: enriched.lateAssessment?.filters?.passed === false ? 0 : 1,
      full_filter_score: Number(enriched.lateAssessment?.filters?.softScore ?? null),
      status: 'late_enriched',
    });

    let advisory = {
      verdict: 'WATCH',
      confidence: 0,
      reason: 'Async LLM advisory disabled.',
      risks: ['async_llm_disabled'],
    };
    if (boolSetting('research_fast_hunter_async_llm_enabled', true) && activeStrategy().use_llm) {
      const latestRow = candidateById(candidateId);
      advisory = latestRow
        ? await decideCandidateBatch([latestRow], candidateId)
        : advisory;
    }
    const llmDone = now();
    patchRun(runId, {
      llm_done_ms: llmDone,
      llm_verdict: advisory.verdict || 'WATCH',
      llm_confidence: Number(advisory.confidence || 0),
      status: 'complete',
    });

    const run = db.prepare('SELECT * FROM fast_hunter_runs WHERE id = ?').get(runId);
    const comparison = {
      version: 'fast-vs-full-context-v1',
      fastDecision: run?.fast_decision || null,
      fastConfidence: run?.fast_confidence ?? null,
      fullFilterPassed: run?.full_filter_passed == null ? null : Boolean(run.full_filter_passed),
      fullFilterScore: run?.full_filter_score ?? null,
      llmVerdict: advisory.verdict || null,
      llmConfidence: Number(advisory.confidence || 0),
      signalToDecisionMs: run?.decision_done_ms ? run.decision_done_ms - run.signal_at_ms : null,
      signalToEntryMs: run?.entry_done_ms ? run.entry_done_ms - run.signal_at_ms : null,
      signalToLateContextMs: run?.late_enrichment_done_ms ? run.late_enrichment_done_ms - run.signal_at_ms : null,
      signalToLlmMs: llmDone - Number(run?.signal_at_ms || llmDone),
    };
    db.prepare(`
      INSERT INTO fast_hunter_advisories (
        run_id, candidate_id, position_id, created_at_ms,
        late_snapshot_json, llm_json, comparison_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        position_id = excluded.position_id,
        created_at_ms = excluded.created_at_ms,
        late_snapshot_json = excluded.late_snapshot_json,
        llm_json = excluded.llm_json,
        comparison_json = excluded.comparison_json
    `).run(
      runId,
      candidateId,
      positionId || null,
      llmDone,
      json(enriched),
      json(advisory),
      json(comparison),
    );
    mergeRunPayload(runId, { comparison });
  } catch (error) {
    patchRun(runId, { status: 'background_error' });
    mergeRunPayload(runId, { backgroundError: error.message });
    console.error(`[fast-hunter] background evidence failed: ${error.message}`);
  }
}

export async function processFastResearchCandidate(signals) {
  if (!isFastHunterSignal(signals)) {
    throw new Error('processFastResearchCandidate called for a non-fast Research signal');
  }
  const mint = String(signals?.mint || '');
  if (!mint) return null;
  if (processingMints.has(mint)) return null;
  processingMints.add(mint);
  recordSignalProcessed();
  const signalAtMs = now();

  try {
    const capacity = fastCapacity();
    if (!capacity.allowed) {
      console.log(`[fast-hunter] research capacity reached (${capacity.open}/${capacity.max}), skipping ${mint.slice(0, 8)}...`);
      return null;
    }
    if (activePositionExists(mint)) {
      console.log(`[fast-hunter] active position exists for ${mint.slice(0, 8)}...`);
      return null;
    }
    if (recentCandidateExists(mint)) {
      console.log(`[fast-hunter] recent candidate exists for ${mint.slice(0, 8)}...`);
      return null;
    }

    const candidate = await buildEssentialCandidate(signals, signalAtMs);
    const essentialDoneMs = now();
    await applyContractSafetyGate(candidate, {
      moneyMode: false,
      stage: 'screening',
      fetchRugcheck: false,
    });
    const safetyDoneMs = now();
    const candidateId = upsertCandidate(candidate, signals.signature || null);
    const runId = insertRun({
      candidateId,
      mint,
      route: signals.route,
      signalAtMs,
      essentialDoneMs,
      safetyDoneMs,
      status: candidate.contractSafety?.passed === false ? 'safety_rejected' : 'screened',
      payload: {
        researchOnly: true,
        realCapitalSol: 0,
        broadcast: false,
        gmgnAvailableOnCriticalPath: Boolean(candidate.gmgn),
        contractSafety: candidate.contractSafety,
      },
    });

    if (candidate.contractSafety?.passed === false) {
      updateCandidateStatus(candidateId, 'filtered');
      return { candidateId, runId, rejectedBy: 'contract_safety' };
    }

    const strat = activeStrategy();
    const preScore = preScoreCandidate(candidate, Number(strat.prescore_hard_floor ?? 35));
    candidate.filters.preScore = preScore.score;
    candidate.filters.preScorePreferred = preScore.passed;

    const momentumResult = await momentumFilter(candidate, Number(strat.momentum_veto_floor ?? 0.1));
    candidate.filters.momentumScore = momentumResult.score;
    candidate.filters.momentumPreferred = Number(momentumResult.score) < 0
      || Number(momentumResult.score) >= Number(strat.momentum_threshold ?? 0.5);
    const momentumDoneMs = now();
    patchRun(runId, { momentum_done_ms: momentumDoneMs });
    updateCandidateSnapshot(candidateId, candidate);

    const decision = buildFastDecision(candidate, candidateId);
    const selfRow = candidateById(candidateId);
    decision.selected_row = decision.verdict === 'BUY' ? selfRow : null;
    const decisionDoneMs = now();
    patchRun(runId, {
      decision_done_ms: decisionDoneMs,
      fast_decision: decision.verdict,
      fast_confidence: decision.confidence,
      status: decision.verdict === 'BUY' ? 'decision_buy' : 'decision_watch',
    });

    let positionResult = null;
    if (decision.verdict === 'BUY' && selfRow && boolSetting('agent_enabled', true)) {
      const decisionId = storeDecision(candidateId, candidate, decision);
      decision.id = decisionId;
      updateCandidateStatus(candidateId, 'buy');
      positionResult = await executeResearchEntry(selfRow, decision, FAST_HUNTER_VERSION);
      const entryDoneMs = now();
      patchRun(runId, {
        position_id: positionResult?.id || null,
        entry_done_ms: entryDoneMs,
        status: positionResult?.isNew ? 'entry_simulated' : `entry_blocked_${positionResult?.blockedBy || 'duplicate'}`,
      });
      logDecisionEvent({
        batchId: null,
        triggerCandidateId: candidateId,
        selectedRow: selfRow,
        rows: [selfRow],
        decision,
        mode: 'research',
        action: positionResult?.isNew ? 'research_fast_hunter_entry_simulated' : 'research_fast_hunter_entry_blocked',
        guardrails: {
          fastHunterVersion: FAST_HUNTER_VERSION,
          realCapitalSol: 0,
          broadcast: false,
          contractSafetyPassed: true,
        },
        execution: { positionId: positionResult?.id || null, isNew: Boolean(positionResult?.isNew) },
      });
      if (positionResult?.isNew && positionResult.id) {
        import('../telegram/send.js')
          .then(({ sendPositionOpen }) => sendPositionOpen(positionResult.id))
          .catch(error => console.log(`[fast-hunter] position telegram failed: ${error.message}`));
      }
    } else {
      updateCandidateStatus(candidateId, 'watch');
      logDecisionEvent({
        batchId: null,
        triggerCandidateId: candidateId,
        selectedRow: null,
        rows: selfRow ? [selfRow] : [],
        decision,
        mode: 'research',
        action: 'research_fast_hunter_watch',
        guardrails: {
          fastHunterVersion: FAST_HUNTER_VERSION,
          realCapitalSol: 0,
          broadcast: false,
          contractSafetyPassed: true,
        },
      });
    }

    void completeBackgroundEvidence({
      runId,
      candidateId,
      positionId: positionResult?.id || null,
    });

    return {
      candidateId,
      runId,
      decision,
      position: positionResult,
      latency: {
        signalToEssentialMs: essentialDoneMs - signalAtMs,
        signalToSafetyMs: safetyDoneMs - signalAtMs,
        signalToMomentumMs: momentumDoneMs - signalAtMs,
        signalToDecisionMs: decisionDoneMs - signalAtMs,
      },
    };
  } catch (error) {
    console.error(`[fast-hunter] ${mint.slice(0, 8)} failed: ${error.message}`);
    throw error;
  } finally {
    processingMints.delete(mint);
  }
}

export function fastHunterStats({ sinceMs = 0 } = {}) {
  ensureFastHunterSchema();
  const rows = db.prepare(`
    SELECT * FROM fast_hunter_runs
    WHERE signal_at_ms >= ?
    ORDER BY id ASC
  `).all(Math.max(0, Number(sinceMs) || 0));
  return rows.map(row => ({
    ...row,
    payload: safeJson(row.payload_json, {}),
    signalToEssentialMs: row.essential_done_ms == null ? null : row.essential_done_ms - row.signal_at_ms,
    signalToSafetyMs: row.safety_done_ms == null ? null : row.safety_done_ms - row.signal_at_ms,
    signalToMomentumMs: row.momentum_done_ms == null ? null : row.momentum_done_ms - row.signal_at_ms,
    signalToDecisionMs: row.decision_done_ms == null ? null : row.decision_done_ms - row.signal_at_ms,
    signalToEntryMs: row.entry_done_ms == null ? null : row.entry_done_ms - row.signal_at_ms,
    signalToLateContextMs: row.late_enrichment_done_ms == null ? null : row.late_enrichment_done_ms - row.signal_at_ms,
    signalToLlmMs: row.llm_done_ms == null ? null : row.llm_done_ms - row.signal_at_ms,
  }));
}
