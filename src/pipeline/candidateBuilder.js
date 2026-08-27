import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol, sleep } from '../utils.js';
import { activeStrategy, numSetting } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';
import { openPositionCount } from '../db/positions.js';
import { observeVolumeAcceleration } from './volumeAcceleration.js';
import { buildDomainEvidence } from '../edge/domainEvidence.js';
import { candidateRoutes } from './routePolicy.js';
import { primaryRouteFor } from './signalEvidence.js';

// Track A: High-conviction routes that bypass LLM/ML/soft-scoring for sub-second execution
// User requested full pipeline (ML + LLM) for all routes, so this is empty.
const TRACK_A_ROUTES = new Set([]);

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

// Detect freshly graduated tokens: route is pumpportal_graduated (token just graduated, filters relaxed)
function isFreshlyGraduated(candidate) {
  const routes = new Set(candidateRoutes(candidate));
  return routes.has('pumpportal_graduated') || routes.has('pumpfun_pregrad');
}

export function filterCandidate(candidate) {
  // Filtering is called again immediately before execution. Remove only flags
  // owned by this function so refreshes are idempotent while preserving flags
  // produced by other risk engines.
  const derivedRiskTypes = new Set(['bot_holder_risk', 'serial_dev_risk', 'missing_audit_data']);
  candidate.riskFlags = (candidate.riskFlags || []).filter(flag => !derivedRiskTypes.has(flag?.type));
  const addDerivedRisk = flag => {
    if (!candidate.riskFlags.some(existing => existing?.type === flag.type)) candidate.riskFlags.push(flag);
  };
  const strat = activeStrategy();
  const failures = [];
  const opportunityWarnings = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const top20HolderPercent = candidate.holders.top20Percent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = nullableNumber(candidate.trending?.rug_ratio);
  const bundlerRate = nullableNumber(candidate.trending?.bundler_rate);
  const freshGrad = isFreshlyGraduated(candidate);

  if (candidate.jupiterAsset?._dataQuality?.stale) {
    failures.push(`Jupiter asset stale: age ${candidate.jupiterAsset._dataQuality.ageMs}ms`);
  }

  // TRENDING QUALITY GATE — Statistical edge from Aug 1-10 data (106 trades)
  // Reduces trending route loss by 96% (from -0.41 SOL to -0.01 SOL) and increases WR from 20.8% to 34.4%
  if (candidate.signals?.route === 'trending' || candidate.signals?.hasTrending) {
    const s1h = Number(candidate.jupiterAsset?.stats1h?.priceChange ?? 0);
    const trendingGateSwaps = Number(candidate.metrics?.trendingSwaps ?? 0);

    // Token sudah pump >100% dalam 1 jam = top-ticking trap
    if (s1h >= 100) {
      opportunityWarnings.push(`trending top-tick: s1h ${s1h.toFixed(0)}% >= 100%`);
    }
    // Terlalu banyak swap = sudah crowded retail
    if (trendingGateSwaps >= 200) {
      opportunityWarnings.push(`trending overcrowded: ${trendingGateSwaps} swaps >= 200`);
    }
  }

  // Fresh grad insufficient data check: v40 pre-filter relies on jupiterAsset.audit (botHolders%, top10, devMigrations).
  // When audit is null/empty, v40 pre-filter is bypassed and LLM makes blind decisions. Reject fresh grads with
  // no Jupiter data, zero liquidity/holders, or 0-second migration (impossible for organic activity).
  if (freshGrad) {
    const reasons = [];
    if (candidate.jupiterAsset === null || candidate.jupiterAsset === undefined) {
      reasons.push('no jupiterAsset');
    } else {
      const liquidityUsd = Number(candidate.jupiterAsset.liquidity ?? 0);
      const holderCount = Number(candidate.jupiterAsset.holderCount ?? 0);
      if (liquidityUsd === 0) reasons.push('liquidity=$0');
      if (holderCount === 0) reasons.push('holders=0');
    }
    if (Array.isArray(candidate.graduation?.patternFlags)
        && candidate.graduation.patternFlags.includes('fast_migration_0s')) {
      reasons.push('fast_migration_0s');
    }
    if (reasons.length > 0) {
      failures.push(`fresh grad insufficient data: ${reasons.join(', ')}`);
    }
  }

  // === "Block worst hours" filter — DISABLING hardcode block to allow round-the-clock trading ===
  // const currentUTCHour = new Date().getUTCHours();
  // if ((currentUTCHour >= 11 && currentUTCHour <= 14) || currentUTCHour === 20 || currentUTCHour === 22) {
  //   failures.push(`worst hours blocked: ${currentUTCHour} UTC`);
  // }

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap defines opportunity/style, not contract safety. Keep it visible
  // for ranking and sizing but do not discard an otherwise safe early runner.
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    opportunityWarnings.push(`market cap below strategy range: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    opportunityWarnings.push(`market cap above strategy range: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    opportunityWarnings.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    opportunityWarnings.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count — skip for freshly graduated (brand new tokens have few holders)
  if (!freshGrad && strat.min_holders > 0 && holderCount < strat.min_holders) {
    opportunityWarnings.push(`holders below strategy preference: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(top20HolderPercent)
      && top20HolderPercent > strat.max_top20_holder_percent) {
    failures.push(`top20 holders: ${top20HolderPercent.toFixed(2)}% > ${strat.max_top20_holder_percent}%`);
  }

  // === AUDIT MODE: All hard filters disabled for 3-day data collection (2026-07-05) ===

  // Pumpportal bot dominance check — DISABLED for audit
  // const botHolders = Number(candidate.jupiterAsset?.audit?.botHoldersCount ?? 0);
  // if (botHolders >= 50 && candidate.signals?.route === 'pumpportal_graduated') {
  //   failures.push(`pumpportal bot-dominated: ${botHolders} bots >= 50`);
  // }

  // Audit-based hard rejects — DISABLED for audit
  // const top10Pct = Number(candidate.jupiterAsset?.audit?.topHoldersPercentage ?? null);
  // const devMigrations = Number(candidate.jupiterAsset?.audit?.devMigrations ?? null);
  // if (Number.isFinite(top10Pct) && top10Pct >= 50) {
  //   failures.push(`top10 holders: ${top10Pct.toFixed(1)}% >= 50% (too concentrated)`);
  // }
  // const devMigThreshold = freshGrad ? 15 : 7;
  // if (Number.isFinite(devMigrations) && devMigrations >= devMigThreshold) {
  //   failures.push(`dev migrations: ${devMigrations} >= ${devMigThreshold} (serial rugger${freshGrad ? ', fresh grad' : ''})`);
  // }

  // === v40 per-route filters — DISABLED for audit ===
  // const signalRoute = candidate.signals?.route;
  // const top10 = Number(candidate.jupiterAsset?.audit?.topHoldersPercentage ?? null);
  // const devMig = Number(candidate.jupiterAsset?.audit?.devMigrations ?? null);
  const botPct = nullableNumber(candidate.jupiterAsset?.audit?.botHoldersPercentage);
  const devMigrations = nullableNumber(candidate.jupiterAsset?.audit?.devMigrations);

  // GAP FIX 1: Strict Liquidity & LP Burn check for low mcap / fresh grad tokens
  const liquidityUsd = Number(candidate.jupiterAsset?.liquidityUsd ?? candidate.liquidityUsd ?? 0);
  const isLpBurned = candidate.jupiterAsset?.audit?.lpBurned ?? candidate.lpBurned ?? null;
  if (mcap < 50000) {
    if (liquidityUsd > 0 && liquidityUsd < 3000) {
      failures.push(`liquidity too low: $${liquidityUsd.toFixed(0)} < $3,000 for mcap < $50k`);
    }
    if (isLpBurned === false) {
      failures.push(`liquidity unburned: risk of immediate liquidity drain rug`);
    }
  }

  // Bot/dev history are statistical risk, not contract-level safety. Moderate
  // zones reduce size; only extreme concentrations remain hard vetoes.
  const maxBotPct = numSetting('filter_max_bot_holders_pct', 25);
  const extremeBotPct = numSetting('filter_extreme_bot_holders_pct', 70);
  if (Number.isFinite(botPct) && botPct >= extremeBotPct) {
    failures.push(`bot holders extreme: ${botPct.toFixed(1)}% >= ${extremeBotPct}%`);
  } else if (Number.isFinite(botPct) && botPct >= maxBotPct) {
    addDerivedRisk({ type: 'bot_holder_risk', severity: 2, reason: `${botPct.toFixed(1)}% bot holders` });
  }
  
  const extremeDevMigrations = numSetting('filter_extreme_dev_migrations', 100);
  if (Number.isFinite(devMigrations) && devMigrations >= extremeDevMigrations) {
    failures.push(`serial rugger extreme: dev migrations ${devMigrations} >= ${extremeDevMigrations}`);
  } else if (Number.isFinite(devMigrations) && devMigrations >= 20) {
    addDerivedRisk({ type: 'serial_dev_risk', severity: 2, reason: `${devMigrations} prior migrations` });
  }

  // TIER 1B: Holder Deadzone [100, 400] — DISABLED based on Aug 1-10 data (126 trades)
  // Aug data shows ALL holder buckets lose money equally — the real problem is route 'trending'
  // (84% of trades, 20.8% WR, -0.41 SOL) poisoning every bucket. Winners in 100-400 range
  // (BABYCATE +62%, PORNHUB +54%, Diablo +50%, LEON +51%) all came from trenches_completed.
  // Blocking this range would kill those winners without fixing the trending route problem.
  // if (!freshGrad && holderCount >= 100 && holderCount <= 400) {
  //   failures.push(`holder deadzone: ${holderCount} in [100, 400] (post-pump dump phase, TIER 1B)`);
  // }

  // GAP FIX 2: Audit missing penalty/delay for fresh grad tokens
  if (freshGrad && (botPct === null || devMigrations === null)) {
    // If audit data is completely missing on a fresh grad, apply soft risk flag
    addDerivedRisk({
      type: 'missing_audit_data',
      severity: 2,
      reason: `fresh grad token missing audit data (botPct/devMig null)`,
    });
  }

  // Per-route filters — DISABLED for audit
  // if (signalRoute === 'pumpportal_graduated') {
  //   if (Number.isFinite(top10) && top10 >= 15 && top10 < 25) {
  //     failures.push(`pumpportal top10 rug zone: ${top10.toFixed(1)}% in [15,25)`);
  //   }
  //   if (!freshGrad && Number.isFinite(devMig) && devMig > 10) {
  //     failures.push(`pumpportal dev_migrations: ${devMig} > 10 (serial rugger)`);
  //   }
  //   if (Number.isFinite(botPct) && botPct > 30) {
  //     failures.push(`pumpportal bot-dominated: ${botPct.toFixed(1)}% > 30%`);
  //   }
  // }

  // if (signalRoute === 'fee_trending') {
  //   if (!freshGrad && Number.isFinite(devMig) && devMig > 10) {
  //     failures.push(`fee_trending dev_migrations: ${devMig} > 10 (serial rugger)`);
  //   }
  //   if (Number.isFinite(botPct) && botPct > 30) {
  //     failures.push(`fee_trending bot-dominated: ${botPct.toFixed(1)}% > 30%`);
  //   }
  // }

  // if (signalRoute === 'trenches_completed') {
  //   if (Number.isFinite(top10) && top10 >= 25 && top10 < 35) {
  //     failures.push(`trenches top10 rug zone: ${top10.toFixed(1)}% in [25,35)`);
  //   }
  // }

  // Trenches route: mcap is already checked by strategy max_mcap_usd — no extra cap needed

  // Twitter Sentiment Edge: Filter out bot spam
  if (candidate.twitterNarrative?.virality) {
    const { engagementPerView } = candidate.twitterNarrative.virality;
    if (engagementPerView != null && engagementPerView < 0.1) {
      opportunityWarnings.push(`twitter engagement weak: ${engagementPerView.toFixed(2)}%`);
    }
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance (dip buy strategy) — skip for freshly graduated (chart data from Jupiter is meaningless at graduation)
  if (!freshGrad && strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    // BACKTEST 2026-07-07 (B-1): trending_min_volume_usd was INVERTED — it admitted the
    // worse half (trendingVol>=5000 -> -13.87 SOL vs <5000 -> -3.41 SOL). Higher trending
    // volume monotonically correlates with LOSS here. Disabled as a floor. Do NOT re-enable
    // as a minimum; if used at all it should be a CAP. See BACKTEST_EDGE_2026-07-07.md.
    // if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
    //   failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    // }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      opportunityWarnings.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  // Token age check — reject tokens older than token_age_max_ms (default 12 hours)
  const tokenAgeMs = strat.token_age_max_ms ?? 43200000; // 12 hours default
  if (tokenAgeMs > 0) {
    const trenchesCreatedTs = candidate.trenchesEntry?.created_timestamp;
    const graduatedTs = candidate.graduation?.graduationDate || candidate.graduation?.seenAt;
    const tokenCreatedTs = trenchesCreatedTs || graduatedTs;
    if (tokenCreatedTs > 0) {
      const tokenAgeMsActual = now() - (tokenCreatedTs > 1e12 ? tokenCreatedTs : tokenCreatedTs * 1000);
      if (tokenAgeMsActual > tokenAgeMs) {
        const ageH = (tokenAgeMsActual / 3600000).toFixed(1);
        failures.push(`token age: ${ageH}h > max ${tokenAgeMs / 3600000}h`);
      }
    }
  }

  // Buy pressure check — need buy/sell ratio > 1.0 (skip for freshly graduated: no data)
  const buyVol = Number(candidate.gmgn?.buy_vol_24h || candidate.gmgn?.buy_volume || 0);
  const sellVol = Number(candidate.gmgn?.sell_vol_24h || candidate.gmgn?.sell_volume || 0);
  if (!freshGrad && buyVol > 0 && sellVol > 0 && (buyVol / sellVol) < 1.0) {
    opportunityWarnings.push(`buy pressure weak: buy/sell ratio ${(buyVol/sellVol).toFixed(2)}`);
  }

  // Liquidity check — BACKTEST 2026-07-07: raised floor from $2K to $6K.
  // liq>=6000 across ALL routes = +5.36 SOL / 932 trades vs baseline +1.08 / 1150,
  // and it holds in both time-halves (H1 +6.11, H2 -0.75 vs base H2 -4.00). It is
  // monotonic (every neighboring threshold behaves the same) — a real signal, not a
  // lucky bucket. Fresh-grads are NOT exempted: their liq<6000 subset lost -2.43 SOL
  // (WR 31%), so exempting them cut total to +2.94. Read from candidate.metrics.liquidityUsd
  // (same field the backtest measured). See BACKTEST_EDGE_2026-07-07.md.
  const minLiq = numSetting('min_liquidity_usd', 5000);
  const liquidity = Number(candidate.metrics?.liquidityUsd || candidate.gmgn?.pool?.liquidity || candidate.gmgn?.liquidity || 0);
  if (liquidity < minLiq) {
    failures.push(`DEX liquidity too low: $${liquidity.toFixed(0)} < $${minLiq}`);
  }

  // ATH Distance Filter — reject tokens too close to ATH (pump trap)
  const athDistance = Number(candidate.chart?.distanceFromAthPercent ?? -100);
  if (athDistance > -15 && athDistance !== 0) {
    opportunityWarnings.push(`close to ATH: ${athDistance.toFixed(1)}%`);
  }

  // === FLOW FILTER (2026-07-17): momentum + net buying pressure ===
  // Backtest: 1,415 trades, 11 days. Filter: s1h_priceChange >= 0 & net_buyer_ratio_5m >= 0.2
  // Result: 945 trades (67% keep), 47.9% WR, +14.09 SOL (+3.45 delta), 100% daily consistency.
  // Uses Jupiter stats (not GMGN — better coverage). Applies to ALL routes including fresh grads.
  const s1hPriceChange = nullableNumber(candidate.jupiterAsset?.stats1h?.priceChange);
  const s5mNumNetBuyers = nullableNumber(candidate.jupiterAsset?.stats5m?.numNetBuyers);
  const s5mNumTraders = nullableNumber(candidate.jupiterAsset?.stats5m?.numTraders);

  const flowHardPriceChange = numSetting('flow_hard_price_change_pct', -10);
  const flowHardNetBuyerRatio = numSetting('flow_hard_net_buyer_ratio', 0);
  const flowWarnings = [];

  // FLOW is an opportunity signal, not a safety property. Only severe dumping
  // is a hard reject; moderate weakness is passed to scoring/LLM as context.
  if (Number.isFinite(s1hPriceChange) && s1hPriceChange <= flowHardPriceChange) {
    failures.push(`flow severe dump: 1h price change ${s1hPriceChange.toFixed(1)}% <= ${flowHardPriceChange}%`);
  } else if (Number.isFinite(s1hPriceChange) && s1hPriceChange < 0) {
    flowWarnings.push(`1h price change ${s1hPriceChange.toFixed(1)}%`);
  }

  if (Number.isFinite(s5mNumNetBuyers) && Number.isFinite(s5mNumTraders) && s5mNumTraders > 0) {
    const netBuyerRatio = s5mNumNetBuyers / s5mNumTraders;
    if (netBuyerRatio < flowHardNetBuyerRatio) {
      failures.push(`flow severe selling: net buyer ratio ${netBuyerRatio.toFixed(2)} < ${flowHardNetBuyerRatio}`);
    } else if (netBuyerRatio < 0.2) {
      flowWarnings.push(`net buyer ratio ${netBuyerRatio.toFixed(2)}`);
    }
  }
  candidate.flowAssessment = {
    priceChange1h: Number.isFinite(s1hPriceChange) ? s1hPriceChange : null,
    netBuyerRatio: s5mNumTraders > 0 ? s5mNumNetBuyers / s5mNumTraders : null,
    warnings: flowWarnings,
  };
  opportunityWarnings.push(...flowWarnings.map(warning => `flow: ${warning}`));
  if (candidate.volumeAcceleration?.valid && candidate.volumeAcceleration.volumeAcceleration < 0.75) {
    opportunityWarnings.push(`volume contracting: ${candidate.volumeAcceleration.volumeAcceleration.toFixed(2)}x`);
  }

  // === v45 Soft Scoring System ===
  // Score each candidate on a 0-100 scale. Route-aware weights.
  // Score >= soft_threshold: PASS to LLM. Below: REJECT (unless hard_floor_override).
  candidate.domainEvidence = buildDomainEvidence(candidate);
  const softScore = computeSoftScore(candidate, strat, freshGrad);
  
  // Dynamic threshold: tighten when many positions open, loosen when idle
  const softThreshold = softScoreThreshold(strat);
  
  const admission = evaluateHybridAdmission(candidate, softScore, softThreshold, freshGrad);
  const kaiserComplements = evaluateKaiserComplements(candidate);
  if (['thin', 'adequate'].includes(kaiserComplements.liquidityBand)) {
    opportunityWarnings.push(`Kaiser liquidity band: ${kaiserComplements.liquidityBand}`);
  }
  if (!kaiserComplements.routeMcapPreferred) {
    opportunityWarnings.push(`Kaiser route mcap preference not met for ${candidate.signals?.route}`);
  }

  // Track A routes bypass soft scoring — only hard Kaiser filters apply
  const isTrackA = TRACK_A_ROUTES.has(candidate.signals?.route);

  // Hard safety always vetoes. Opportunity admission is OR-based so a runner
  // pattern can survive a low generic score without weakening money safety.
  if (failures.length > 0 || (!isTrackA && !admission.passed)) {
    const reasons = failures.join('; ');
    const scoreReason = (!isTrackA && !admission.passed) ? (reasons ? `; no hybrid admission pattern` : 'no hybrid admission pattern') : '';
    console.log(`[candidate] filtered ${candidate.token?.mint?.slice(0, 8)}... ${reasons}${scoreReason} (soft=${softScore.toFixed(0)}, threshold=${softThreshold})`);
    return {
      passed: false,
      hardPassed: failures.length === 0,
      softScore,
      softThreshold,
      failures,
      opportunityWarnings,
      admission,
      kaiserComplements,
    };
  }

  // === P7: Signal Source Weighting ===
  // Assign route-based position size multiplier for downstream sizing
  const SOURCE_WEIGHTS = {
    'pumpportal_graduated': 1.0,   // Best performing route — full size
    'trenches_completed': 0.8,     // Good but slightly riskier
    'fee_trending': 0.8,           // Fee-based signals — moderate
    'pumpfun_pregrad': 0.7,        // Pre-grad — higher risk, earlier entry
    'trending': 0.5,               // Trending route — historically worst performer
    'graduated_trending': 0.8,     // Independent confirmation, route-risk adjusted
    'dual_source': 0.8,            // Independent confirmation must not be penalized as noise
    'smart_money': 0.8,
    'gmgn_smart_money': 0.8,
  };
  const signalRouteWeight = candidate.signals?.route || '';
  const routeWeight = SOURCE_WEIGHTS[signalRouteWeight] ?? 0.8;
  const sourceWeight = routeWeight
    * admission.sizeMultiplier
    * kaiserComplements.liquidityMultiplier
    * kaiserComplements.routeMcapMultiplier;

  return {
    passed: failures.length === 0,
    hardPassed: failures.length === 0,
    failures,
    opportunityWarnings,
    strategy: strat.id,
    softScore,
    softThreshold,
    sourceWeight,
    routeWeight,
    admission,
    kaiserComplements,
  };
}

export function evaluateKaiserComplements(candidate) {
  const route = candidate.signals?.route || '';
  const liquidity = nullableNumber(candidate.metrics?.liquidityUsd);
  const mcap = nullableNumber(candidate.metrics?.marketCapUsd);
  const stats1h = candidate.jupiterAsset?.stats1h || {};
  const stats5m = candidate.jupiterAsset?.stats5m || {};
  const priceChange1h = nullableNumber(stats1h.priceChange);
  const netBuyers = nullableNumber(stats5m.numNetBuyers);
  const traders = nullableNumber(stats5m.numTraders);
  const netBuyerRatio = traders > 0 && netBuyers != null ? netBuyers / traders : null;
  const buyVolume = nullableNumber(candidate.gmgn?.buy_vol_24h ?? candidate.gmgn?.buy_volume ?? stats5m.buyVolume);
  const sellVolume = nullableNumber(candidate.gmgn?.sell_vol_24h ?? candidate.gmgn?.sell_volume ?? stats5m.sellVolume);
  const buySellRatio = buyVolume != null && sellVolume != null && sellVolume > 0
    ? buyVolume / sellVolume
    : null;

  let liquidityMultiplier = 1;
  let liquidityBand = 'unknown';
  if (liquidity != null) {
    if (liquidity < 5000) { liquidityMultiplier = 0; liquidityBand = 'unsafe'; }
    else if (liquidity < 7500) { liquidityMultiplier = 0.6; liquidityBand = 'thin'; }
    else if (liquidity < 10000) { liquidityMultiplier = 0.8; liquidityBand = 'adequate'; }
    else { liquidityBand = 'healthy'; }
  }

  let routeMcapMultiplier = 1;
  let routeMcapPreferred = true;
  if (route === 'trenches_completed' && mcap != null && mcap < 25000) {
    routeMcapMultiplier = 0.85;
    routeMcapPreferred = false;
  } else if (route === 'fee_trending' && mcap != null && mcap < 40000) {
    routeMcapMultiplier = 0.85;
    routeMcapPreferred = false;
  }

  let mcapScore = 0;
  if (mcap != null && mcap >= 10000 && mcap <= 100000) mcapScore = 15;
  else if (mcap != null && mcap >= 5000 && mcap <= 200000) mcapScore = 8;

  return {
    policy: 'kaiser_complements_v1',
    liquidityBand,
    liquidityMultiplier,
    routeMcapPreferred,
    routeMcapMultiplier,
    strictFlowPassed: priceChange1h != null && priceChange1h >= 0
      && netBuyerRatio != null && netBuyerRatio >= 0.2,
    buyPressurePassed: buySellRatio == null ? null : buySellRatio >= 1,
    buySellRatio,
    mcapScore,
    mcapSweetSpot: mcapScore === 15,
  };
}

export function evaluateHybridAdmission(candidate, softScore, softThreshold, freshGrad = isFreshlyGraduated(candidate)) {
  const stats1h = candidate.jupiterAsset?.stats1h || {};
  const stats5m = candidate.jupiterAsset?.stats5m || {};
  const priceChange1h = nullableNumber(stats1h.priceChange);
  const netBuyers = nullableNumber(stats5m.numNetBuyers);
  const traders = nullableNumber(stats5m.numTraders);
  const netBuyerRatio = traders > 0 && netBuyers != null ? netBuyers / traders : null;
  const buys = nullableNumber(stats5m.numBuys ?? candidate.trending?.buys);
  const sells = nullableNumber(stats5m.numSells ?? candidate.trending?.sells);
  const liquidity = nullableNumber(candidate.metrics?.liquidityUsd);
  const holders = nullableNumber(candidate.metrics?.holderCount);

  const patterns = {
    angelQuality: Number(softScore) >= Number(softThreshold),
    kaiserRunner: priceChange1h != null && priceChange1h >= 0
      && netBuyerRatio != null && netBuyerRatio >= 0.2
      && liquidity != null && liquidity >= numSetting('min_liquidity_usd', 5000),
    freshBreakout: Boolean(freshGrad)
      && liquidity != null && liquidity >= numSetting('min_liquidity_usd', 5000)
      && holders != null && holders > 0
      && buys != null && sells != null && buys > sells,
    acceleratingRunner: false,
  };
  patterns.acceleratingRunner = patterns.kaiserRunner
    && candidate.volumeAcceleration?.valid === true
    && candidate.volumeAcceleration.accelerating === true;
  const matched = Object.entries(patterns).filter(([, value]) => value).map(([name]) => name);
  let sizeMultiplier = 0.5;
  if (patterns.angelQuality && patterns.kaiserRunner && patterns.acceleratingRunner) sizeMultiplier = 1;
  else if (patterns.angelQuality && patterns.kaiserRunner) sizeMultiplier = 0.85;
  else if (patterns.kaiserRunner && patterns.acceleratingRunner) sizeMultiplier = 0.75;
  else if (patterns.angelQuality) sizeMultiplier = 0.75;
  else if (patterns.kaiserRunner || patterns.freshBreakout) sizeMultiplier = 0.5;
  return {
    policy: 'angel_hybrid_runner_v1',
    passed: matched.length > 0,
    patterns,
    matched,
    sizeMultiplier,
    evidence: {
      priceChange1h,
      netBuyerRatio,
      buys,
      sells,
      liquidity,
      holders,
      volumeAcceleration: candidate.volumeAcceleration?.volumeAcceleration ?? null,
      buyerAcceleration: candidate.volumeAcceleration?.buyerAcceleration ?? null,
    },
  };
}

// ============================================================
// v45 Soft Scoring Engine
// ============================================================

export function computeSoftScore(candidate, strat, isFreshGrad) {
  const ROUTE_WEIGHTS = {
    'trenches_completed': 1.1,
    'pumpportal_graduated': 1.05,
    'fee_trending': 1.0,
    'trending': 0.85,
    'dual_source': 1.0,
    'graduated_trending': 1.0,
  };
  // Four independent domains are the score authority. The old implementation
  // started at 100 while the pass threshold was 25-55, making weak candidates
  // pass before any evidence was evaluated.
  const evidence = candidate.domainEvidence || buildDomainEvidence(candidate);
  let score = Number(evidence.compositeScore ?? 0);
  const route = candidate.signals?.route || '';
  
  const athDistance = candidate.chart?.distanceFromAthPercent;

  // Small, bounded timing penalties may modify the evidence score. Structural
  // and flow inputs already live in their domains and are not counted twice.
  if (!isFreshGrad && athDistance != null) {
    if (athDistance > -15) score -= 10;
    else if (athDistance > -25) score -= 5;
  }
  const routeWeight = ROUTE_WEIGHTS[route] || 0.95;
  score = Math.round(score * routeWeight);

  return Math.max(0, Math.min(100, score));
}

function softScoreThreshold(strat) {
  // Dynamic threshold based on current load and time-of-day
  const baseThreshold = 35; // Loosened threshold for active dry run trading
  
  // Time-of-day adjustment
  const hourUTC = new Date().getUTCHours();
  const isLowVolume = hourUTC >= 6 && hourUTC < 14;
  const timeAdjustment = isLowVolume ? 5 : 0;

  // Tighten when many positions open
  const openCount = globalOpenPositionCount();
  const configuredMaxOpen = Number(strat.max_open_positions);
  const maxOpen = Number.isFinite(configuredMaxOpen) && configuredMaxOpen > 0
    ? configuredMaxOpen
    : Infinity;
  
  let loadAdjustment = 0;
  if (Number.isFinite(maxOpen) && openCount >= maxOpen - 1) loadAdjustment = 10;
  else if (openCount === 0) loadAdjustment = -10;

  return Math.max(25, Math.min(55, baseThreshold + timeAdjustment + loadAdjustment));
}

function globalOpenPositionCount() {
  // BACKTEST 2026-07-07 (B-4): the old body did require('./positions.js') inside a
  // try/catch. In this ESM project require is undefined AND the path was wrong
  // (positions.js lives in ../db/), so it ALWAYS threw and returned 0 — pinning the
  // soft-score threshold at the loosest branch (20) forever. Now uses a static ESM
  // import so the dynamic tighten-when-full logic actually works.
  try {
    return openPositionCount();
  } catch {
    return 0;
  }
}
export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, trenchesEntry = null, pregradToken = null, smartMoneySignal = null, signalRoutes = null, route }) {
  const strat = activeStrategy();
  const isFreshlyGraduated = route === 'pumpportal_graduated';

  // Rate-limit safety: small throttle delay between candidates to prevent API rate-limits (HTTP 429)
  // Track A routes skip delay for sub-second execution
  if (!TRACK_A_ROUTES.has(route)) await sleep(300);

  let gmgn, jupiterAsset, holders, chart, savedWalletExposure, twitterNarrative;

  if (isFreshlyGraduated) {
    console.log(`[candidate] bounded enrichment for freshly graduated ${mint.slice(0, 8)}...`);
    const [jupAsset, jupHolders, gmgnInfo] = await Promise.all([
      fetchJupiterAsset(mint),
      fetchJupiterHolders(mint),
      fetchGmgnTokenInfo(mint),
    ]);
    jupiterAsset = jupAsset;
    holders = jupHolders;
    gmgn = gmgnInfo;
    chart = null;
    [savedWalletExposure, twitterNarrative] = await Promise.all([
      fetchSavedWalletExposure(mint, holders),
      fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn),
    ]);
  } else {
    // Stage 1: parallel — gmgn, asset, holders, chart (4 calls)
    [gmgn, jupiterAsset, holders, chart] = await Promise.all([
      fetchGmgnTokenInfo(mint),
      fetchJupiterAsset(mint),
      fetchJupiterHolders(mint),
      fetchJupiterChartContext(mint),
    ]);
    // Stage 2: depends on stage 1 — wallet exposure (needs holders) + twitter (needs asset/gmgn)
    // Track A: skip Stage 2 entirely for speed (saves ~2-5s latency)
    if (TRACK_A_ROUTES.has(route)) {
      savedWalletExposure = { holderCount: 0, holders: [] };
      twitterNarrative = null;
    } else {
      [savedWalletExposure, twitterNarrative] = await Promise.all([
        fetchSavedWalletExposure(mint, holders),
        fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn),
      ]);
    }
  }
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price, trenchesEntry?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
    trenchesEntry?.market_cap,
    trenchesEntry?.marketCap,
    trenchesEntry?.fdv,
  );
  const rawRoutes = [...new Set([...(signalRoutes || []), route].filter(Boolean).filter(value => value !== 'dual_source'))];
  const signalRoute = rawRoutes.length > 1 ? 'dual_source' : route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    pregradToken ? 'pregrad' : null,
    trendingToken ? 'trending' : null,
    trenchesEntry ? 'trenches' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? trenchesEntry?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? trenchesEntry?.holder_count ?? trenchesEntry?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? trenchesEntry?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? trenchesEntry?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? trenchesEntry?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? trenchesEntry?.smart_degen_count ?? 0),
      dexBuys5m: nullableNumber(jupiterAsset?.stats5m?.numBuys ?? jupiterAsset?.stats5m?.buys),
      dexSells5m: nullableNumber(jupiterAsset?.stats5m?.numSells ?? jupiterAsset?.stats5m?.sells),
      pregradRssrSol: Number(pregradToken?.real_sol_reserves_sol ?? 0),
      pregradRssrPctToGrad: Number(pregradToken?.rssr_pct_to_grad ?? 0),
      pregradReplyCount: Number(pregradToken?.reply_count ?? 0),
      volumeUsd: nullableNumber(trendingToken?.volume ?? trenchesEntry?.volume ?? gmgn?.volume_24h),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken || trenchesEntry),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken || trenchesEntry),
      hasSmartMoney: Boolean(smartMoneySignal),
      routes: rawRoutes.length ? rawRoutes : [signalRoute],
      primaryRoute: primaryRouteFor(rawRoutes.length ? rawRoutes : [signalRoute]),
      sourceCount: rawRoutes.length || 1,
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    trenchesEntry,
    smartMoneySignal,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    dataQuality: {
      jupiterAsset: jupiterAsset?._dataQuality || { source: 'jupiter', available: false },
      holders: holders?.dataQuality || { source: 'jupiter_holders', available: false },
      gmgn: { source: 'gmgn', available: Boolean(gmgn) },
      chart: { source: 'jupiter_chart', available: Boolean(chart?.windows?.some(window => window.available)) },
      twitter: { source: 'fxtwitter', available: Boolean(twitterNarrative) },
    },
    createdAtMs: now(),
  };
  candidate.volumeAcceleration = trendingToken?.volumeAcceleration?.valid
    ? trendingToken.volumeAcceleration
    : observeVolumeAcceleration(candidate);
  candidate.filters = filterCandidate(candidate);
  return candidate;
}
