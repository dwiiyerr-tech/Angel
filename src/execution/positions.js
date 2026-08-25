import { now, json, safeJson } from '../utils.js';
import { numSetting, boolSetting, setting, strategyById, slippageAdjustedMcap } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, computeAtrPercent, dynamicStopLossPercent } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl, fetchTokenExitQuote, fetchTokenSpotViaQuote } from '../enrichment/jupiter.js';
import { fetchLiveTokenBalance, liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';
import { simulationReplayEnabled, simulationTickFor } from './simulation.js';

export function relativeTrailPercent({ peakPnl, atrPercent = null, ageMinutes = 0, baseTrail = 12 }) {
  const peak = Math.max(0, Number(peakPnl) || 0);
  let trail = Math.abs(Number(baseTrail) || 12);
  if (peak >= 200) trail = 25;
  else if (peak >= 100) trail = 20;
  else if (peak >= 50) trail = 15;
  else if (peak >= 25) trail = 12;
  const atr = Number(atrPercent);
  if (Number.isFinite(atr) && atr > 0) trail += Math.min(5, atr * 0.2);
  if (Number(ageMinutes) > 20) trail -= 5;
  else if (Number(ageMinutes) > 10) trail -= 2;
  return Math.max(8, Math.min(30, trail));
}

export function shouldExitTrailing({ armed, enabled, pnlPercent, floorPercent, trailDropPercent, trailPercent }) {
  return Boolean(armed && enabled
    && (Number(pnlPercent) <= Number(floorPercent)
      || Number(trailDropPercent) <= -Math.abs(Number(trailPercent))));
}

export async function settleWithin(promise, timeoutMs, fallback = null) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => { timeoutId = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const route = candidate.signals?.route || '';
  const isFresh = route.includes('pumpportal_graduated');

  let gmgn, asset, holders, chart;

  if (isFresh) {
    // Keep chart off the latency-critical path, but retain GMGN as an
    // independent price/liquidity/risk source when it is available.
    [gmgn, asset, holders] = await Promise.all([
      settleWithin(fetchGmgnTokenInfo(mint, false), numSetting('fresh_gmgn_budget_ms', 1200), null),
      fetchJupiterAsset(mint, { useCache: false }),
      fetchJupiterHolders(mint),
    ]);
    chart = null;
  } else {
    [gmgn, asset, holders] = await Promise.all([
      fetchGmgnTokenInfo(mint, false),
      fetchJupiterAsset(mint, { useCache: false }),
      fetchJupiterHolders(mint),
    ]);
    chart = null;  // chart not used in buy path — saves 10s timeout
  }
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const freshPriceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price);
  const freshMarketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap
  );
  const freshLiquidityUsd = firstPositiveNumber(gmgn?.liquidity, asset?.liquidity, selectedTrending?.liquidity);
  const priceUsd = firstPositiveNumber(freshPriceUsd, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    freshMarketCapUsd,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = { ...candidate.filters, ...filterCandidate(refreshed) };
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (setting('trading_mode', 'dry_run') !== 'dry_run') {
    if (!freshPriceUsd) executionFailures.push('live execution price: no fresh source');
    if (!freshMarketCapUsd) executionFailures.push('live execution mcap: no fresh source');
    if (!freshLiquidityUsd) executionFailures.push('live execution liquidity: no fresh source');
    if (!holders?.holders?.length) executionFailures.push('live execution holders: refresh unavailable');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  // Bug2 fix (2026-06-19): bypass 20s cache for live monitoring — flash crash detection requires fresh data
  // Quote-first (2026-07-24): dry_run exit decisions use executable Jupiter quote (live pool
  // reserves) as primary price — datapi mark is stale by design. Mark = fallback on 429/backoff.
  const useQuote = position.execution_mode !== 'live' && numSetting('exit_quote_enabled', 1);
  const drySizedQuote = position.execution_mode !== 'live' && position.token_amount_raw;
  const replayTick = position.execution_mode === 'shadow_live' ? simulationTickFor(position.mint) : null;
  // A configured replay must never silently fall back to live market data.
  // Waiting for the next tick is safer than evaluating an exit on a different clock.
  if (position.execution_mode === 'shadow_live' && simulationReplayEnabled() && !replayTick) return null;
  const [asset, qp, executableExitQuote] = replayTick ? [null, null, null] : await Promise.all([
    fetchJupiterAsset(position.mint, { useCache: false, ttlMs: 3000 }),
    useQuote && !drySizedQuote ? fetchTokenSpotViaQuote(position.mint) : Promise.resolve(null),
    position.token_amount_raw && (position.execution_mode === 'live' || drySizedQuote)
      ? fetchTokenExitQuote(position.mint, position.token_amount_raw)
      : Promise.resolve(null),
  ]);
  const quotePrice = (Number.isFinite(qp) && qp > 0) ? qp : null;
  const quoteMcap = quotePrice && Number(position.entry_price) > 0
    ? Number(position.entry_mcap) * (quotePrice / Number(position.entry_price))
    : null;
  const jupiterPrice = Number(asset?.usdPrice);
  const jupiterMcap = firstPositiveNumber(asset?.mcap, asset?.fdv);
  // Guard 1 DISABLED (2026-07-17): can't distinguish crash vs stale data — single source (Jupiter) is unreliable
  let price = replayTick?.priceUsd || firstPositiveNumber(quotePrice, jupiterPrice || null, position.high_water_price, position.entry_price);
  let mcap = replayTick?.mcapUsd || (replayTick?.priceUsd && Number(position.entry_price) > 0
    ? Number(position.entry_mcap) * (Number(replayTick.priceUsd) / Number(position.entry_price))
    : firstPositiveNumber(quoteMcap, jupiterMcap, position.high_water_mcap, position.entry_mcap));
  if (executableExitQuote && Number(position.size_sol) > 0) {
    const liquidationRatio = executableExitQuote.outSol / Number(position.size_sol);
    if (Number(position.entry_mcap) > 0) mcap = Number(position.entry_mcap) * liquidationRatio;
    if (Number(position.entry_price) > 0) price = Number(position.entry_price) * liquidationRatio;
  }
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  // Guard 2 DISABLED (2026-07-17): drop >80% heuristic can't distinguish crash vs stale bonding curve data
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  const markPnlPercent = pnlPercent;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (executableExitQuote && Number(position.size_sol) > 0) {
    pnlSol = executableExitQuote.outSol - Number(position.size_sol);
    pnlPercent = (executableExitQuote.outSol / Number(position.size_sol) - 1) * 100;
  } else if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  } else if (position.execution_mode === 'live') {
    throw new Error(`No executable exit quote or wallet PnL for live position ${position.id}`);
  }
  // Dynamic ATR-based stop loss: fetch chart context and compute ATR% to widen/narrow the static sl_percent.
  const stratForSl = strategyById(position.strategy_id);
  const useDynamicSl = (stratForSl?.use_dynamic_sl ?? numSetting('use_dynamic_sl', 1)) ? true : false;
  let effectiveSlPercent = -Math.abs(Number(position.sl_percent || stratForSl?.sl_percent || -25));
  let atrPercent = null;
  if (useDynamicSl) {
    try {
      const chart = await fetchJupiterChartContext(position.mint);
      const windows = Array.isArray(chart?.windows) ? chart.windows : [];
      atrPercent = computeAtrPercent(windows, numSetting('atr_period', 14));
      effectiveSlPercent = dynamicStopLossPercent({
        baseSlPercent: Number(position.sl_percent),
        atrPercent,
        multiplier: Number(stratForSl?.atr_sl_multiplier ?? numSetting('atr_sl_multiplier', 1.5)),
        floorPercent: Number(stratForSl?.atr_sl_floor_percent ?? numSetting('atr_sl_floor_percent', -50)),
        ceilingPercent: Number(stratForSl?.atr_sl_ceiling_percent ?? numSetting('atr_sl_ceiling_percent', -8)),
        minAtrPercent: Number(stratForSl?.atr_sl_min_atr_percent ?? numSetting('atr_sl_min_atr_percent', 4)),
        maxAtrPercent: Number(stratForSl?.atr_sl_max_atr_percent ?? numSetting('atr_sl_max_atr_percent', 30)),
      });
    } catch (err) {
      console.log(`[atr] chart refresh failed for ${position.mint.slice(0, 8)}... ${err.message}`);
    }
  }
  const tpHit = pnlPercent >= Number(position.tp_percent);

  // === FIX: Entry Grace Period (90 seconds) ===
  // 54% of all exits are SL hits. Many occur in the first 1-2 minutes from market noise.
  // Give the coin 90 seconds to settle after entry before allowing SL to trigger.
  const ageMs = now() - position.opened_at_ms;
  const ENTRY_GRACE_MS = 90_000; // 90 seconds
  const inGracePeriod = ageMs < ENTRY_GRACE_MS;
  const slHit = !inGracePeriod && pnlPercent <= effectiveSlPercent && pnlPercent < 0;
  const armThreshold = position.tp_percent ? Number(position.tp_percent) : numSetting('trailing_arm_percent', 10);
  const armHit = pnlPercent >= armThreshold;
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && armHit);
  const trailDrop = highWaterMcap > 0 ? Math.max(-100, (Number(mcap) / highWaterMcap - 1) * 100) : 0;
  // EXIT-FIX 2026-07-25 (backtest 933 trades 07-22..25: base +1,685% -> +8,766% ideal / +6,314% gap).
  // (1) TIGHT TRAIL: once peak pnl >= trailing_tight_from_percent (40), trail tightens from
  //     trailing_percent (10) to trailing_tight_percent (5). Rescues armed winners that round-trip
  //     to SL (97 armed+SL trades = -6,497% pnl in window).
  // (2) FLOOR: once armed, trailing may not exit below trailing_floor_percent (+8). Kills the
  //     +1.7% "gap-dump between 3s ticks" exits (dump lands below arm before next check).
  // Partial@arm REJECTED by backtest (-867%): caps the runners that carry total profit.
  const peakPnl = Number(position.entry_mcap) > 0
    ? (highWaterMcap / Number(position.entry_mcap) - 1) * 100
    : pnlPercent;
  const effectiveTrailPct = relativeTrailPercent({
    peakPnl,
    atrPercent,
    ageMinutes: ageMs / 60000,
    baseTrail: Number(position.trailing_percent),
  });
  const trailingFloor = numSetting('trailing_floor_percent', 3);
  const trailingHit = shouldExitTrailing({
    armed: trailingArmed,
    enabled: position.trailing_enabled,
    pnlPercent,
    floorPercent: trailingFloor,
    trailDropPercent: trailDrop,
    trailPercent: effectiveTrailPct,
  });
  const expectedDryExitFeeSol = Math.max(0, numSetting('dry_run_network_fee_sol', 0.000005))
    + Math.max(0, numSetting('dry_run_priority_fee_sol', 0));

  async function settleDryPartial(rawAmount, soldCostSol, fallbackPnlPercent) {
    const quote = rawAmount ? await fetchTokenExitQuote(position.mint, String(rawAmount)) : null;
    const quotedOutSol = Number(quote?.outSol);
    const drySlippage = Math.max(0, numSetting('dry_run_slippage_percent', 0)) / 100;
    const slippageAdjustedOutSol = Number.isFinite(quotedOutSol) && quotedOutSol >= 0
      ? quotedOutSol * Math.max(0, 1 - drySlippage)
      : null;
    const grossPnl = Number.isFinite(slippageAdjustedOutSol)
      ? slippageAdjustedOutSol - soldCostSol
      : soldCostSol * fallbackPnlPercent / 100;
    return { pnlSol: grossPnl - expectedDryExitFeeSol, feeSol: expectedDryExitFeeSol };
  }

  // === P4: Break-Even Stop ===
  // Once trade reaches +15% profit, move stop to breakeven (+0.5%) to prevent gave-back-gains
  // FIX: Only trigger break-even if pnlPercent is actually near zero (>= -1%), not deep negative.
  // Old bug: break-even fired at -11% because price gapped through zero between ticks.
  const breakEvenThreshold = numSetting('break_even_threshold_percent', 15);
  const breakEvenArmed = peakPnl >= breakEvenThreshold;
  const breakEvenHit = breakEvenArmed && !trailingArmed && pnlPercent <= 0.5 && pnlPercent >= -1.0;

  // === FIX: Tiered Profit Lock (Gave-Back-Gains Protection) ===
  // Data-driven dari 127 trade historis:
  //   Peak 25-50%: 72% trade akhirnya RUGI (13/18), total -769% profit hilang
  //   Peak 15-25%: 86% trade akhirnya RUGI (6/7), total -207% profit hilang
  //   Peak 50%+:   Trailing TP sudah menangani dengan baik (93% selamat)
  //
  // Sistem berjenjang: semakin tinggi peak profit yang pernah dicapai,
  // semakin besar minimum profit yang dikunci (tidak boleh dikembalikan ke pasar).
  //
  //   Peak 15-25%  → Kunci profit minimal +2%  (jangan biarkan jadi rugi)
  //   Peak 25-50%  → Kunci profit minimal +8%  (lindungi profit menengah)
  //   Peak 50-75%  → Kunci profit minimal +15% (profit besar, jaga ketat)
  //   Peak 75-100% → Kunci profit minimal +25% (runner confirmed, amankan)
  //   Peak 100%+   → Kunci profit minimal +35% (moonshot, kunci sepertiga)
  //
  // Profit lock remains active after trailing arms; otherwise a large winner
  // could be handed back to the market while the runner is still open.

  let profitLockFloor = null;
  if (peakPnl >= 100) profitLockFloor = 35;
  else if (peakPnl >= 75) profitLockFloor = 25;
  else if (peakPnl >= 50) profitLockFloor = 15;
  else if (peakPnl >= 25) profitLockFloor = 8;
  else if (peakPnl >= 15) profitLockFloor = 2;

  const profitLockArmed = profitLockFloor !== null;
  const profitLockHit = profitLockArmed && pnlPercent <= profitLockFloor;

  let exitReason = null;
  let closed = false;

  // Standard exit checks (Highest Priority)
  if (profitLockHit) exitReason = 'PROFIT_LOCK';
  else if (trailingHit) exitReason = 'TRAILING_TP';
  else if (slHit) exitReason = 'SL';
  else if (breakEvenHit) exitReason = 'BREAK_EVEN';
  else if (tpHit && !position.trailing_enabled) exitReason = 'TP';

  // Max hold time check — tiered by entry mcap
  const strat = strategyById(position.strategy_id);
  const entryMcap = Number(position.entry_mcap) || 0;
  const isMicrocap = entryMcap > 0 && entryMcap < 15000;
  const isHighcap = entryMcap >= 60000;
  let effectiveMaxHold = strat?.max_hold_ms ?? 0;
  // === P5: Time-Based Exit Tightening ===
  // Pump.fun tokens peak within 3-8 min. Progressively tighten after 10 min.
  const ageMinutes = (now() - position.opened_at_ms) / 60000;
  const timeTightenEnabled = numSetting('time_tighten_enabled', 1);
  const tightenStartMinutes = 10;
  if (!exitReason && timeTightenEnabled && ageMinutes > tightenStartMinutes) {
    let timeTightenSl;
    if (ageMinutes > 20) {
      if (pnlPercent < 5) {
        exitReason = 'TIME_TIGHTEN_20M';
      }
    } else if (ageMinutes > 15) {
      // After 15 min: tighten SL to -3%
      timeTightenSl = -3;
      if (pnlPercent <= timeTightenSl) exitReason = 'TIME_TIGHTEN_15M';
    } else {
      // After 10 min: tighten SL to -6% or break-even if profitable
      timeTightenSl = peakPnl > 0 ? 0 : -6;
      if (pnlPercent <= timeTightenSl) exitReason = 'TIME_TIGHTEN_10M';
    }
  }
  const configuredMaxHold = effectiveMaxHold;
  if (!exitReason && configuredMaxHold > 0 && (now() - position.opened_at_ms) >= configuredMaxHold) {
    exitReason = 'MAX_HOLD';
  }

  // Sideways timeout: if open too long with negligible PnL, exit to free up capital.
  if (!exitReason) {
    const sidewaysMinutes = Number(strat?.sideways_timeout_minutes ?? numSetting('sideways_timeout_minutes', 0));
    if (sidewaysMinutes > 0) {
      const ageSeconds = (now() - position.opened_at_ms) / 1000;
      if (ageSeconds > sidewaysMinutes * 60 && Math.abs(pnlPercent) < 2) {
        exitReason = 'SIDEWAYS_TIMEOUT';
      }
    }
  }

  // === P1: Default Partial TP Cascade ===
  // If strategy doesn't define partial_tp, apply default cascade: sell 50% at +15%
  const defaultPartialTp = numSetting('default_partial_tp_enabled', 1);
  const riskUnitPercent = Math.abs(Number(position.sl_percent || 0));
  const tp1RMultiple = Math.max(0.5, numSetting('tp1_r_multiple', 1));
  const defaultPartialTpAt = Math.max(
    numSetting('default_partial_tp_at_percent', 20),
    riskUnitPercent * tp1RMultiple,
  );
  const defaultPartialTpSell = numSetting('default_partial_tp_sell_percent', 25);
  if (!exitReason && defaultPartialTp && !strat?.partial_tp && !position.partial_tp_done && Number(position.partial_tp_retry_after_ms || 0) <= now() && pnlPercent >= defaultPartialTpAt) {
    console.log(`[position] ${position.id} DEFAULT partial TP at ${pnlPercent.toFixed(1)}% (sell ${defaultPartialTpSell}%)`);
    // For dry_run, just mark it and reduce effective size for PnL calculation
    // For live, execute partial sell
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const rawAmount = BigInt(position.token_amount_raw);
        const sellAmount = (rawAmount * BigInt(defaultPartialTpSell)) / 100n;
        if (sellAmount > 0n) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: sellAmount.toString() }, 'PARTIAL_TP_DEFAULT');
          const remaining = rawAmount - sellAmount;
          const soldCostSol = position.size_sol * (defaultPartialTpSell / 100);
          const newSizeSol = position.size_sol - soldCostSol;
          const receivedSol = Number(sell.outputAmount || 0) / 1_000_000_000;
          const feeSol = Number(position.execution_mode === 'live' ? sell.feeSol : 0);
          const realizedDelta = receivedSol > 0 ? receivedSol - soldCostSol - feeSol : -feeSol;
          db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1, token_amount_raw = ?, size_sol = ?, realized_pnl_sol = coalesce(realized_pnl_sol, 0) + ?, realized_cost_sol = coalesce(realized_cost_sol, 0) + ?, realized_fee_sol = coalesce(realized_fee_sol, 0) + ? WHERE id = ?').run(remaining.toString(), newSizeSol, realizedDelta, soldCostSol, feeSol, position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP_DEFAULT', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (defaultPartialTpSell / 100), Number(sellAmount),
            json({ pnlPercent, partialSellPercent: defaultPartialTpSell, remaining: remaining.toString() }));
        } else {
          db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
        }
      } catch (err) {
        console.log(`[position] ${position.id} default partial sell failed: ${err.message}`);
        if (!err.swapOutcomeUnknown) {
          db.prepare('UPDATE dry_run_positions SET partial_tp_retry_after_ms = ? WHERE id = ?').run(now() + 5 * 60 * 1000, position.id);
        }
      }
    } else {
      const rawAmount = position.token_amount_raw ? BigInt(position.token_amount_raw) : null;
      const sellAmountRaw = rawAmount ? (rawAmount * BigInt(defaultPartialTpSell)) / 100n : null;
      const sellAmount = rawAmount ? Number(sellAmountRaw) : (position.token_amount_est * defaultPartialTpSell) / 100;
      const remainingAmount = position.token_amount_est == null ? null : position.token_amount_est - sellAmount;
      const remainingRaw = rawAmount ? rawAmount - sellAmountRaw : null;
      const soldCostSol = position.size_sol * (defaultPartialTpSell / 100);
      const newSizeSol = position.size_sol - soldCostSol;
      const partial = await settleDryPartial(sellAmountRaw, soldCostSol, pnlPercent);
      db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1, token_amount_est = ?, token_amount_raw = coalesce(?, token_amount_raw), size_sol = ?, realized_pnl_sol = coalesce(realized_pnl_sol, 0) + ?, realized_cost_sol = coalesce(realized_cost_sol, 0) + ?, realized_fee_sol = coalesce(realized_fee_sol, 0) + ? WHERE id = ?').run(remainingAmount, remainingRaw?.toString() || null, newSizeSol, partial.pnlSol, soldCostSol, partial.feeSol, position.id);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP_DEFAULT', ?)
      `).run(position.id, position.mint, now(), price, mcap,
        position.size_sol * (defaultPartialTpSell / 100), sellAmount,
        json({ pnlPercent, partialSellPercent: defaultPartialTpSell, remainingAmount, remainingRaw: remainingRaw?.toString() || null, partial }));
    }
  }

  // Partial TP check
  const strategyPartialAt = Math.max(
    Number(strat?.partial_tp_at_percent || 0),
    riskUnitPercent * tp1RMultiple,
  );
  if (!exitReason && strat?.partial_tp && !position.partial_tp_done && Number(position.partial_tp_retry_after_ms || 0) <= now() && pnlPercent >= strategyPartialAt) {
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const rawAmount = BigInt(position.token_amount_raw);
        const sellAmount = (rawAmount * BigInt(strat.partial_tp_sell_percent)) / 100n;
        if (sellAmount > 0n) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: sellAmount.toString() }, 'PARTIAL_TP');
          const remaining = rawAmount - sellAmount;
          const soldCostSol = position.size_sol * (strat.partial_tp_sell_percent / 100);
          const newSizeSol = position.size_sol - soldCostSol;
          const receivedSol = Number(sell.outputAmount || 0) / 1_000_000_000;
          const feeSol = Number(position.execution_mode === 'live' ? sell.feeSol : 0);
          const realizedDelta = receivedSol > 0 ? receivedSol - soldCostSol - feeSol : -feeSol;
          db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1, token_amount_raw = ?, size_sol = ?, realized_pnl_sol = coalesce(realized_pnl_sol, 0) + ?, realized_cost_sol = coalesce(realized_cost_sol, 0) + ?, realized_fee_sol = coalesce(realized_fee_sol, 0) + ? WHERE id = ?').run(remaining.toString(), newSizeSol, realizedDelta, soldCostSol, feeSol, position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (strat.partial_tp_sell_percent / 100), Number(sellAmount),
            json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining: remaining.toString() }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        } else {
          db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
        if (!err.swapOutcomeUnknown) {
          db.prepare('UPDATE dry_run_positions SET partial_tp_retry_after_ms = ? WHERE id = ?').run(now() + 5 * 60 * 1000, position.id);
        }
      }
    } else {
      const rawAmount = position.token_amount_raw ? BigInt(position.token_amount_raw) : null;
      const sellAmountRaw = rawAmount ? (rawAmount * BigInt(strat.partial_tp_sell_percent)) / 100n : null;
      const sellAmount = rawAmount ? Number(sellAmountRaw) : (position.token_amount_est * strat.partial_tp_sell_percent) / 100;
      const remainingAmount = position.token_amount_est == null ? null : position.token_amount_est - sellAmount;
      const remainingRaw = rawAmount ? rawAmount - sellAmountRaw : null;
      const soldCostSol = position.size_sol * (strat.partial_tp_sell_percent / 100);
      const newSizeSol = position.size_sol - soldCostSol;
      const partial = await settleDryPartial(sellAmountRaw, soldCostSol, pnlPercent);
      db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1, token_amount_est = ?, token_amount_raw = coalesce(?, token_amount_raw), size_sol = ?, realized_pnl_sol = coalesce(realized_pnl_sol, 0) + ?, realized_cost_sol = coalesce(realized_cost_sol, 0) + ?, realized_fee_sol = coalesce(realized_fee_sol, 0) + ? WHERE id = ?').run(remainingAmount, remainingRaw?.toString() || null, newSizeSol, partial.pnlSol, soldCostSol, partial.feeSol, position.id);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
      `).run(position.id, position.mint, now(), price, mcap,
        position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
        json({ pnlPercent, partialSellPercent: strat.partial_tp_sell_percent, remainingAmount, remainingRaw: remainingRaw?.toString() || null, partial }));
    }
  }


  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      const exitFeeSol = Number(sell.feeSol || 0);
      finalPnlSol = Number(position.realized_pnl_sol || 0) + receivedSol - Number(position.size_sol) - Number(position.entry_fee_sol || 0) - exitFeeSol;
      const originalCost = Number(position.realized_cost_sol || 0) + Number(position.size_sol)
        + Number(position.entry_fee_sol || 0) + Number(position.realized_fee_sol || 0)
        + exitFeeSol;
      finalPnlPercent = originalCost > 0 ? finalPnlSol / originalCost * 100 : pnlPercent;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare('UPDATE dry_run_positions SET exit_fee_sol = ? WHERE id = ?').run(Number(sell.feeSol || 0), position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell, effectiveSlPercent, atrPercent, baseSlPercent: Number(position.sl_percent) }));
    closed = true;
  } else if (exitReason && autoExit) {
    // Apply exit slippage for dry_run PnL
    const exitMcap = slippageAdjustedMcap(quotePrice ? Number(position.entry_mcap) * (quotePrice / Number(position.entry_price)) : mcap, 'exit');
    const dryExitPrice = quotePrice || price;
    const dryExitMcap = quotePrice ? Number(position.entry_mcap) * (quotePrice / Number(position.entry_price)) : mcap;
    const dryPnlPercent = (Number(exitMcap) / Number(position.entry_mcap) - 1) * 100;
    const dryPnlSol = Number(position.size_sol) * dryPnlPercent / 100;
    const dryExitFeeSol = Math.max(0, numSetting('dry_run_network_fee_sol', 0.000005))
      + Math.max(0, numSetting('dry_run_priority_fee_sol', 0));
    finalPnlSol = Number(position.realized_pnl_sol || 0) + dryPnlSol
      - Number(position.entry_fee_sol || 0) - dryExitFeeSol;
    const originalCost = Number(position.realized_cost_sol || 0) + Number(position.size_sol)
      + Number(position.entry_fee_sol || 0) + Number(position.realized_fee_sol || 0)
      + dryExitFeeSol;
    finalPnlPercent = originalCost > 0 ? finalPnlSol / originalCost * 100 : dryPnlPercent;
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?, exit_fee_sol = ?
      WHERE id = ?
    `).run(now(), dryExitPrice, dryExitMcap, exitReason, finalPnlPercent, finalPnlSol, dryExitFeeSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), dryExitPrice, dryExitMcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, effectiveSlPercent, atrPercent, baseSlPercent: Number(position.sl_percent), slippage_pct: numSetting('dry_run_slippage_percent', 0), simulationTick: replayTick }));
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
    simulationTick: replayTick,
  };
}

export async function monitorPositions() {
  const positions = openPositions();
  let liveFailures = 0;
  let checked = 0;
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    checked++;
    if (position.execution_mode === 'live' && !position.token_amount_raw) {
      const recoveredAmount = await fetchLiveTokenBalance(position.mint);
      if (recoveredAmount && BigInt(recoveredAmount) > 0n) {
        db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(recoveredAmount), position.id);
        position.token_amount_raw = String(recoveredAmount);
        db.prepare(`
          UPDATE execution_operations SET output_amount = ?, status = 'completed', error = NULL, updated_at_ms = ?
          WHERE position_id = ? AND side = 'buy' AND status = 'outcome_unknown'
        `).run(String(recoveredAmount), now(), position.id);
      }
    }
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      if (position.execution_mode === 'live') liveFailures++;
      return null;
    });
    if (result?.exitReason) {
      try {
        await sendPositionExit(result);
      } catch (err) {
        console.error(`[monitorPositions] sendPositionExit failed for ${position.id}: ${err.message}`);
      }
    }
  }
  if (liveFailures > 0) {
    throw new Error(`${liveFailures} live position(s) failed monitoring in this cycle`);
  }
  return { checked, liveFailures };
}
