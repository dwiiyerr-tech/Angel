import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS, LLM_MODEL_CHEAP, LLM_BASE_URL_CHEAP, LLM_API_KEY_CHEAP, LLM_OPENROUTER_MODEL, LLM_OPENROUTER_API_KEY, LLM_FALLBACK_BASE_URL, LLM_FALLBACK_API_KEY, LLM_FALLBACK_MODEL } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting, setting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { storeSignalEvent } from '../signals/trending.js';
import { validateLLMResponse } from './llmValidator.js';
import { buildTradeMemory } from './tradeMemory.js';
import { isRouteBlocked, parseBlockedRoutes } from './routePolicy.js';
import { decideDeterministicBatch, effectivePositionSizeSol } from './deterministicDecision.js';

// Read from DB setting (configurable per-strategy), fallback to 70 for backward compat
import { activeStrategy } from '../db/settings.js';

function llmBuyMinConfidence() { 
  // Always read fresh from settings table (source of truth)
  const fromSettings = numSetting('llm_min_confidence', 40);
  return fromSettings;
}
function llmLowConfidenceCap() { return numSetting('llm_low_confidence_cap', 70); }

function getBlockedRoutes() {
  const raw = setting('blocked_routes', '[]');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function parsePercent(val) {
  if (val == null) return NaN;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  return Number(cleaned);
}

export function isRetryableLlmError(error) {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.code || '');
  return [401, 402, 408, 409, 412, 425, 429].includes(status)
    || status >= 500
    || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN',
      'ABORTED', 'ERR_CANCELED', 'EPIPE'].includes(code)
    || ['AbortError', 'CanceledError', 'TimeoutError'].includes(error?.name)
    || /socket hang up|network error|timed? ?out/i.test(String(error?.message || ''));
}

export function normalizeDecision(parsed, fallbackReason = '', route = '') {
  let verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  let confidence = Math.max(0, Math.min(100, Number(parsed?.confidence) || 0));

  const blockedRoutes = getBlockedRoutes();

  // Block unprofitable routes entirely
  if (verdict === 'BUY' && isRouteBlocked(String(route), new Set(blockedRoutes))) {
    console.log(`[llm] BUY blocked — route "${route}" is dynamically disabled`);
    verdict = 'WATCH';
  }

  if (verdict === 'BUY' && confidence < llmBuyMinConfidence()) {
    console.log(`[llm] BUY downgraded to WATCH — confidence ${confidence} < threshold ${llmBuyMinConfidence()}`);
    verdict = 'WATCH';
  }
  // trenches_completed penalty removed — historically profitable route (Lesson #1)
  const requestedTp = parsePercent(parsed?.suggested_tp_percent);
  const minEntryTp = Math.max(1, numSetting('min_entry_tp_percent', 60));
  const rawTp = verdict === 'BUY' && Number.isFinite(requestedTp)
    ? Math.max(minEntryTp, requestedTp)
    : requestedTp;
  const requestedSl = parsePercent(parsed?.suggested_sl_percent);
  const maxEntrySl = Math.max(1, numSetting('max_entry_sl_percent', 15));
  const rawSl = Number.isFinite(requestedSl) ? Math.max(-maxEntrySl, requestedSl) : requestedSl;

  return {
    verdict,
    confidence,
    thesis: Array.isArray(parsed?.thesis) ? parsed.thesis.map(String).slice(0, 5) : [],
    missing_confirmation: Array.isArray(parsed?.missing_confirmation) ? parsed.missing_confirmation.map(String).slice(0, 3) : [],
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number.isFinite(rawTp) ? rawTp : numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number.isFinite(rawSl) ? rawSl : numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export { effectivePositionSizeSol };

export { llmBuyMinConfidence, llmLowConfidenceCap };

export function activeLessonsForPrompt(routes = [], limit = 6) {
  const routeList = Array.isArray(routes) ? routes : [routes];
  return db.prepare(`
    SELECT id, scope, confidence, lesson, instruction
    FROM learning_lessons
    WHERE status = 'active' AND approved_at_ms IS NOT NULL
      AND approved_at_ms >= ? AND (expires_at_ms IS NULL OR expires_at_ms > ?)
    ORDER BY id DESC
  `).all(Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now())
    .filter(row => !row.scope || row.scope === 'global' || routeList.includes(row.scope))
    .sort((a, b) => Number(b.scope !== 'global') - Number(a.scope !== 'global') || b.id - a.id)
    .slice(0, limit).map(row => ({
    id: row.id,
    scope: row.scope || 'global',
    confidence: row.confidence || 'low',
    observation: row.lesson,
    instruction: row.instruction || row.lesson,
  }));
}

/**
 * Select model based on signal route.
 * Signal Server routes (high volume) → cheap model
 * PumpPortal route (real-time, low volume) → fast model
 */
export function selectModelForRoute(route = '') {
  // PumpPortal = real-time, use fast model
  if (route.includes('pumpportal')) {
    return {
      baseUrl: LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      model: LLM_MODEL,
    };
  }
  // Signal Server / local routes = batch, use cheap model
  if (LLM_MODEL_CHEAP) {
    return {
      baseUrl: LLM_BASE_URL_CHEAP || LLM_BASE_URL,
      apiKey: LLM_API_KEY_CHEAP || LLM_API_KEY, // Same provider = same key
      model: LLM_MODEL_CHEAP,
    };
  }
  // Fallback to primary
  return {
    baseUrl: LLM_BASE_URL,
    apiKey: LLM_API_KEY,
    model: LLM_MODEL,
  };
}

export function compactCandidateForLlm(row) {
  const c = row.candidate || {};
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);

  // Strip raw holder arrays (addresses/amounts) — LLM only needs summary stats
  const h = c.holders || {};
  const compactHolders = {
    count: h.count,
    top20Percent: h.top20Percent,
    maxHolderPercent: h.maxHolderPercent,
  };

  // Strip raw windows array — athContext24h already captures high/low/current
  // Compact jupiterAsset for LLM (rich data source for fresh grads since gmgn is skipped in fast-path)
  const jup = c.jupiterAsset || {};
  const jupAudit = jup.audit || {};
  const compactJupiter = {
    holderCount: jup.holderCount,
    liquidityUsd: jup.liquidity,
    fdv: jup.fdv,
    mcap: c.metrics?.marketCapUsd ?? jup.mcap,
    organicScore: jup.organicScore,
    organicScoreLabel: jup.organicScoreLabel,
    audit: {
      mintAuthorityDisabled: jupAudit.mintAuthorityDisabled,
      freezeAuthorityDisabled: jupAudit.freezeAuthorityDisabled,
      topHoldersPercentage: jupAudit.topHoldersPercentage,
      devBalancePercentage: jupAudit.devBalancePercentage,
      devMigrations: jupAudit.devMigrations,
      sniperPct: jupAudit.sniperPct,
      insiderPct: jupAudit.insiderPct,
      botHoldersCount: jupAudit.botHoldersCount,
      botHoldersPercentage: jupAudit.botHoldersPercentage,
    },
    stats1h: jup.stats1h,
    stats6h: jup.stats6h,
    stats24h: jup.stats24h,
    tags: jup.tags,
    graduatedAt: jup.graduatedAt,
    firstPoolAt: jup.firstPool?.createdAt,
  };

  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    jupiterAsset: compactJupiter,
    holders: compactHolders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    volumeAcceleration: c.volumeAcceleration?.valid ? {
      elapsedMs: c.volumeAcceleration.elapsedMs,
      volumeAcceleration: c.volumeAcceleration.volumeAcceleration,
      buyerAcceleration: c.volumeAcceleration.buyerAcceleration,
      sellerAcceleration: c.volumeAcceleration.sellerAcceleration,
      accelerating: c.volumeAcceleration.accelerating,
    } : { valid: false, reason: c.volumeAcceleration?.reason || 'unavailable' },
    filters: c.filters,
  };
}

// Retained only as an offline/advisory implementation while historical prompt
// tests and audit tools are migrated. It is intentionally not exported and is
// never connected to execution authority.
async function legacyLlmCandidateAnalysis(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  // Determine route from trigger candidate for model selection
  const triggerRow = rows.find(item => item.id === triggerCandidateId);
  const route = triggerRow?.candidate?.signals?.route || '';
  const llmConfig = selectModelForRoute(route);
  const promptLessons = activeLessonsForPrompt(rows.map(item => item.candidate?.signals?.route || ''));
  console.log(`[llm] model=${llmConfig.model} route=${route || 'none'}`);

  const tradeMemory = buildTradeMemory();

  const system = [
    'You are Angel, a Solana meme coin entry screener operating in dry-run mode.',
    'Return strict JSON only — no markdown, no code fences, no explanation outside JSON.',
    'You will receive up to 10 candidates. Pick the best one to BUY, or PASS all.',
    tradeMemory ? `\n${tradeMemory}\n` : '',
    'RECENT LESSONS are human-approved prompt guidance, not hard filters or permission to change settings.',
    'Apply a route-scoped lesson only to matching routes. Treat low-confidence lessons as weak context.',
    'When a lesson conflicts with fresh candidate evidence or a hard safety rule, follow the fresh evidence and safety rule.',
    'Never infer causality beyond the sample counts and comparisons supplied in a lesson.',
    '',
    '== MICRO INTELLIGENCE ==',
    'Pay close attention to ML momentum score, velocity, and smart money presence.',
    '',
    '== SOFT SCORE CONTEXT ==',
    'Each candidate has a pre-computed soft score (0-150). Score >= 50 passed pre-filter.',
    'Use soft score as ONE input, not the primary filter. Score 70+ with weak narrative = WATCH.',
    '',
    '== FRESHLY GRADUATED (pumpportal_graduated) ==',
    'Brand new tokens. HIGH concentration, ZERO smart money, no narrative = NORMAL. Do NOT penalize.',
    'PRIMARY signal: botHoldersPercentage. Data-driven buckets:',
    '  bot% < 20% + liq > $3K = BUY 70-80. bot% 20-30% + liq > $5K = BUY 60-70.',
    '  bot% 30-50% = WATCH. bot% > 50% = PASS. organicScore is unreliable for fresh grads.',
    '',
    '== ESTABLISHED (trenches_completed, fee_trending) ==',
    'trenches: High dev_migrations = POSITIVE (experienced dev).',
    '  High bot% = smart money + bots coexisting (more tolerant). Top10 rug zone: 25-35%.',
    '  Smart money (smart_degen_count) is STRONG signal. Prefer >= 3.',
    'fee_trending: High RR but be selective. Confidence 55+ for BUY.',
    '  MAX_HOLD common (80%+). Prefer organic_score >= 50 + bundler_rate < 0.3.',
    '',
    '== STRATEGY: FORMER RUNNER-RECLAIM (Lowcap Hunter) ==',
    'If Market Cap < 50k, evaluate strictly against the Former Runner-Reclaim checklist:',
    '  1. Former Runner: ATH must be >= 5x current MC (Drawdown >= 70%).',
    '  2. Liquidity: Must be > $15k.',
    '  3. Chart: Reclaiming Key Support with Volume Expansion.',
    '  4. Organic Accumulation: >= 2 vetted smart wallets (smart_degen_count >= 2).',
    '  5. Security: PASS if Top 10 > 45% or high bundler rate/dev sell.',
    '  If all matched, BUY with high confidence. Specify Invalidation and TP Ladder.',
    '',
    '== STRATEGY: BUY THE DIP (Re-Accumulation) ==',
    'If the token has a proven runner history (high ATH multiplier) and suffers an extreme drawdown (e.g. 70-95%), watch for smart money Re-Accumulation:',
    '  - LP must be stable (Liquidity >= 15k).',
    '  - Smart Degen Count must show active accumulation.',
    '  - If price response is weak despite net inflow, this is silent re-accumulation.',
    '  - Verdict: WATCH if missing a breakout catalyst; BUY if breaking out.',
    '',
    '== UNIVERSAL RISK MANAGEMENT (R:R & M:M) ==',
    'Do not hesitate endlessly. If a token has strong ML Momentum or smart money, TAKE THE SHOT.',
    'Apply strict Money Management (M:M) by adjusting your Confidence Score (which dictates position size):',
    '  - High conviction: Confidence 80-100 (Full size)',
    '  - Medium conviction: Confidence 60-79 (Half size)',
    '  - Low conviction: Confidence 40-59 (Quarter size)',
    'Apply strict Risk:Reward (R:R) logic to your suggested exits:',
    `  - ALWAYS maintain at least a ${numSetting('min_risk_reward_ratio', 1.5).toFixed(2)}:1 R:R ratio (TP / abs(SL)).`,
    '  - If a token is highly volatile, widen the SL (e.g. -40%) but you MUST increase TP (e.g. 100%) to justify the risk.',
    '  - Do not give tight SLs (-10%) to freshly graduated coins, they will instantly hit. Give them room to breathe (-30%) but aim for 60%+ TP.',
    'Be aggressive when the Macro or Micro allows it. Grow the portfolio by taking calculated risks.',
    '',
    '== INSIDER FLOW (DANGER) ==',
    'Be extremely careful of the classic Insider Flow:',
    '1. Launch (Add liquidity + Bundle/Snipe in the very first block)',
    '2. Fake Hype (Wash trading volume + KOL posts + Community taking over narrative)',
    '3. Distribution (Insiders slowly sell through multiple generated wallets)',
    'If you detect this exact flow, REJECT immediately with verdict PASS.',
  ].join('\n');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: promptLessons,
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'calibrated 0-100 estimate that the selected BUY will close with positive PnL; use 0 for no BUY',
      thesis: ['short strings justifying the decision, e.g. Drawdown 92%, LP stable'],
      missing_confirmation: ['short strings of what is missing, e.g. Catalyst, Breakout'],
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
      risk_reward_ratio: 'suggested_tp_percent / abs(suggested_sl_percent), must meet the configured minimum',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: [],  // placeholder, filled below
  };

  const blockedRoutes = parseBlockedRoutes(setting('blocked_routes', '[]'));
  user.candidates = rows.filter(row => {
    const route = row.candidate?.signals?.route || '';
    if (isRouteBlocked(row.candidate, blockedRoutes)) {
      console.log(`[llm] filtered blocked route "${route}"`);
      return false;
    }
    return true;
  }).map(compactCandidateForLlm);

  // Skip LLM call entirely if all candidates were filtered — saves tokens
  if (user.candidates.length === 0) {
    console.log(`[llm] all ${rows.length} candidates filtered (blocked routes) — 0 tokens used`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `All ${rows.length} candidates from blocked routes.`,
      risks: ['all_blocked_routes'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }
  console.log(`[llm] ${user.candidates.length}/${rows.length} candidates passed filter`);

  try {
    const userPrompt = JSON.stringify(user);
    let res;
    
    // Try primary model first
    try {
      try {
        res = await axios.post(`${llmConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          model: llmConfig.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
          ],
        }, {
          timeout: LLM_TIMEOUT_MS,
          headers: { authorization: `Bearer ${llmConfig.apiKey}`, 'content-type': 'application/json' },
        });
      } catch (primaryCallErr) {
        if (primaryCallErr?.name === 'AbortError' || primaryCallErr?.name === 'CanceledError' || primaryCallErr?.code === 'ABORTED' || primaryCallErr?.code === 'ERR_CANCELED') {
          console.log(`[llm] call aborted after ${LLM_TIMEOUT_MS}ms`);
        }
        throw primaryCallErr;
      }
    } catch (primaryErr) {
      const status = primaryErr.response?.status;
      const errCode = primaryErr.code;
      // Retryable: credit/auth/rate-limit/server errors, network failures, timeouts
      const isRetryable = isRetryableLlmError(primaryErr);

      // First fallback: Zyloo (catches any retryable error, not just 402/401)
      if (isRetryable && LLM_FALLBACK_MODEL && LLM_FALLBACK_API_KEY && LLM_FALLBACK_BASE_URL) {
        console.log(`[llm] primary failed (${status || errCode || primaryErr.message}), fallback → Zyloo ${LLM_FALLBACK_MODEL}`);
        try {
          res = await axios.post(`${LLM_FALLBACK_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
            model: LLM_FALLBACK_MODEL,
            temperature: 0.2,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: userPrompt },
            ],
          }, {
            timeout: LLM_TIMEOUT_MS,
            headers: { authorization: `Bearer ${LLM_FALLBACK_API_KEY}`, 'content-type': 'application/json' },
          });
          console.log('[llm] Zyloo fallback succeeded');
        } catch (fallbackCallErr) {
          const fbStatus = fallbackCallErr.response?.status;
          // Use the independent final provider for transient network failures
          // as well as provider credit/auth/rate failures.
          if (isRetryableLlmError(fallbackCallErr) && LLM_OPENROUTER_MODEL && LLM_OPENROUTER_API_KEY) {
            console.log(`[llm] Zyloo fallback failed (${fbStatus || fallbackCallErr.code || fallbackCallErr.message}), final → OpenRouter ${LLM_OPENROUTER_MODEL}`);
            res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
              model: LLM_OPENROUTER_MODEL,
              temperature: 0.2,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: userPrompt },
              ],
            }, {
              timeout: LLM_TIMEOUT_MS,
              headers: {
                authorization: `Bearer ${LLM_OPENROUTER_API_KEY}`,
                'content-type': 'application/json',
                'HTTP-Referer': 'https://angel-bot.local',
                'X-Title': 'Angel Trading Bot',
              },
            });
            console.log('[llm] OpenRouter final fallback succeeded');
          } else {
            throw fallbackCallErr;
          }
        }
      } else if ((status === 402 || status === 401 || status === 412) && LLM_OPENROUTER_MODEL && LLM_OPENROUTER_API_KEY) {
        // Backward-compat: original OpenRouter fallback path (when Zyloo not configured)
        console.log(`[llm] primary failed (${status}), fallback → OpenRouter ${LLM_OPENROUTER_MODEL}`);
        try {
          res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: LLM_OPENROUTER_MODEL,
            temperature: 0.2,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: userPrompt },
            ],
          }, {
            timeout: LLM_TIMEOUT_MS,
            headers: {
              authorization: `Bearer ${LLM_OPENROUTER_API_KEY}`,
              'content-type': 'application/json',
              'HTTP-Referer': 'https://angel-bot.local',
              'X-Title': 'Angel Trading Bot',
            },
          });
        } catch (fallbackCallErr) {
          if (fallbackCallErr?.name === 'AbortError' || fallbackCallErr?.name === 'CanceledError' || fallbackCallErr?.code === 'ABORTED' || fallbackCallErr?.code === 'ERR_CANCELED') {
            console.log(`[llm] call aborted after ${LLM_TIMEOUT_MS}ms`);
          }
          throw fallbackCallErr;
        }
        console.log('[llm] OpenRouter fallback succeeded');
      } else {
        throw primaryErr; // Re-throw if not retryable or no fallback configured
      }
    }
    
    const content = res.data?.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      const rawJson = strictJsonFromText(content);
      if (!rawJson || typeof rawJson !== 'object') throw new Error('LLM returned non-object');
      const validation = validateLLMResponse(rawJson);
      if (!validation.valid) throw new Error('Validation failed');
      parsed = validation.data;
    } catch (e) {
      parsed = { verdict: 'PASS', reason: `LLM parsing error: ${e.message}` };
    }
    
    // --- OPTIONAL DUAL LLM CONSENSUS ---
    const enableDual = setting('dual_llm_consensus', 'false') === 'true';
    if (enableDual && parsed.verdict === 'BUY' && LLM_FALLBACK_MODEL && LLM_FALLBACK_API_KEY && LLM_FALLBACK_BASE_URL) {
      try {
        console.log(`[llm] Dual LLM Consensus enabled. Seeking second opinion for BUY from ${LLM_FALLBACK_MODEL}...`);
        const res2 = await axios.post(`${LLM_FALLBACK_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
          model: LLM_FALLBACK_MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
          ],
        }, {
          timeout: LLM_TIMEOUT_MS,
          headers: { authorization: `Bearer ${LLM_FALLBACK_API_KEY}`, 'content-type': 'application/json' },
        });
        let parsed2;
        try {
          parsed2 = strictJsonFromText(res2.data?.choices?.[0]?.message?.content || '');
          if (!parsed2 || typeof parsed2 !== 'object') {
            parsed2 = { verdict: 'PASS', reason: 'Invalid JSON from secondary model' };
          } else {
            // Normalize verdict to uppercase for consistent comparison
            if (parsed2.verdict) parsed2.verdict = String(parsed2.verdict).toUpperCase();
          }
        } catch (e) {
          parsed2 = { verdict: 'PASS', reason: 'SyntaxError from secondary model' };
        }
        
        if (parsed.verdict === 'BUY' && parsed2.verdict !== 'BUY') {
           console.log(`[llm] Consensus FAILED: Primary BUY, Secondary ${parsed2.verdict}`);
           parsed.verdict = 'WATCH';
           parsed.reason = `Consensus failure: Primary said BUY, but ${LLM_FALLBACK_MODEL} said ${parsed2.verdict}.`;
        } else if (parsed.verdict === 'BUY' && parsed2.verdict === 'BUY') {
           console.log(`[llm] Consensus APPROVED: Both models agree on BUY`);
           parsed.confidence = (Number(parsed.confidence || 0) + Number(parsed2.confidence || 0)) / 2;
           // If secondary model suggested safer SL/TP, we can adopt it, but averaging confidence is enough.
        }
      } catch (dualErr) {
        console.error(`[llm] Dual LLM Consensus second opinion failed:`, dualErr.message);
        // If second opinion fails (network issue), we can choose to proceed with primary or block.
        // We'll proceed with primary to avoid full blockage.
      }
    }
    // -----------------------------------

    const selectedId = parsed?.selected_candidate_id == null ? null : Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed?.selected_mint || '');
    // Try matching by candidate_id first, then by mint address
    let row = rows.find(item => item.id === selectedId);
    if (!row && selectedMint) {
      row = rows.find(item => item.candidate.token?.mint === selectedMint);
    }
    // Fallback: if LLM returned a symbol/name instead of mint, try partial match
    if (!row && selectedMint) {
      row = rows.find(item =>
        item.candidate.token?.symbol === selectedMint ||
        item.candidate.token?.name === selectedMint
      );
    }
    const selectedRoute = row?.candidate?.signals?.route || '';
    const decision = normalizeDecision(parsed, '', selectedRoute);
    decision.learning_lesson_ids = promptLessons.map(item => item.id);
    if (decision.verdict === 'BUY' && !row) {
      console.log(`[llm] BUY verdict but no matching row: selectedId=${selectedId}, selectedMint=${selectedMint}, rows=${rows.map(r=>r.id).join(',')}`);
    }

    if (decision.verdict === 'BUY' && row) {
      const mcap = row.candidate?.metrics?.marketCapUsd || row.candidate?.jupiterAsset?.mcap || 0;
      if (mcap > 0 && mcap < 50000 && decision.confidence > 95) {
        console.log(`[llm] WARNING: Confidence ${decision.confidence} too high for mcap $${mcap}. Capping to 85.`);
        decision.confidence = 85;
      }
    }

    // Lesson 9: log verdict/confidence/route for PASS and BUY (post-hoc PASS vs BUY analysis)
    if (decision.verdict === 'PASS' || decision.verdict === 'BUY') {
      console.log(`[llm-metric] verdict=${decision.verdict} confidence=${decision.confidence} route=${selectedRoute}`);
    }

    // Lesson 8: act on WATCH verdicts — record them in signal_events for audit
    if (decision.verdict === 'WATCH') {
      const triggerRow = rows.find(item => item.id === triggerCandidateId) || row || rows[0];
      const watchMint = triggerRow?.candidate?.token?.mint || selectedMint;
      if (watchMint) {
        try {
          storeSignalEvent(watchMint, 'watch', 'llm', {
            verdict: 'WATCH',
            confidence: decision.confidence,
            reason: decision.reason,
          });
        } catch (err) {
          console.log(`[llm] storeSignalEvent(watch) failed: ${err.message}`);
        }
      }
    }
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate?.token?.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  return decideDeterministicBatch(rows, triggerCandidateId, { researchMode: false });
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason, candidate?.signals?.route || '');
}
