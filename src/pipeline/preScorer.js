import { now } from '../utils.js';
import { getPreviousState, saveCurrentState, detectStateTransition } from './stateTransition.js';

/**
 * Rule-based pre-scorer — filters candidates BEFORE LLM call.
 * Returns { passed: boolean, score: number, reasons: string[] }
 *
 * Data comes from candidate.gmgn (already fetched during buildCandidate).
 * NO additional API calls — pure computation.
 */
export function preScoreCandidate(candidate, threshold = 35) {
  const reasons = [];
  let score = 0;

  const gmgn = candidate.gmgn || {};
  const metrics = candidate.metrics || {};
  const trending = candidate.trending || {};
  const signals = candidate.signals || {};

  // 1. Smart degen count (0-30 points)
  const smartDegens = Number(trending.smart_degen_count ?? gmgn.smart_degen_count ?? 0);
  if (smartDegens >= 10) { score += 30; reasons.push(`smart_degen: ${smartDegens} (high)`); }
  else if (smartDegens >= 5) { score += 20; reasons.push(`smart_degen: ${smartDegens} (medium)`); }
  else if (smartDegens >= 3) { score += 10; reasons.push(`smart_degen: ${smartDegens} (low)`); }
  else { reasons.push(`smart_degen: ${smartDegens} (very low)`); }

  // 2. Organic score (0-25 points)
  const organic = Number(trending.organic_score ?? gmgn.organic_score ?? 0);
  if (organic >= 70) { score += 25; reasons.push(`organic: ${organic} (high)`); }
  else if (organic >= 50) { score += 15; reasons.push(`organic: ${organic} (medium)`); }
  else if (organic >= 30) { score += 5; reasons.push(`organic: ${organic} (low)`); }
  else { reasons.push(`organic: ${organic} (very low)`); }

  // 3. Bundler rate (0-20 points, lower is better)
  const bundlerRate = Number(trending.bundler_rate ?? gmgn.bundler_rate ?? 1.0);
  if (bundlerRate < 0.1) { score += 20; reasons.push(`bundler: ${(bundlerRate * 100).toFixed(0)}% (clean)`); }
  else if (bundlerRate < 0.3) { score += 10; reasons.push(`bundler: ${(bundlerRate * 100).toFixed(0)}% (ok)`); }
  else { reasons.push(`bundler: ${(bundlerRate * 100).toFixed(0)}% (high)`); }

  // 4. Market cap sweet spot (0-15 points)
  const mcap = Number(metrics.marketCapUsd ?? gmgn.usd_market_cap ?? 0);
  if (mcap >= 10000 && mcap <= 200000) { score += 15; reasons.push(`mcap: $${(mcap/1000).toFixed(0)}K (sweet spot)`); }
  else if (mcap > 200000 && mcap <= 500000) { score += 10; reasons.push(`mcap: $${(mcap/1000).toFixed(0)}K (ok)`); }
  else if (mcap > 0 && mcap < 10000) { score += 5; reasons.push(`mcap: $${(mcap/1000).toFixed(0)}K (micro)`); }
  else { reasons.push(`mcap: $${(mcap/1000).toFixed(0)}K (out of range)`); }

  // 5. Holder count (0-10 points)
  const holders = Number(metrics.holderCount ?? gmgn.holder_count ?? 0);
  if (holders >= 50) { score += 10; reasons.push(`holders: ${holders} (good)`); }
  else if (holders >= 30) { score += 5; reasons.push(`holders: ${holders} (ok)`); }
  else { reasons.push(`holders: ${holders} (low)`); }

  // 6. FAKE GAS FEE / WASH TRADING DETECTOR
  const volumeUsd = Number(metrics.volumeUsd ?? metrics.trendingVolumeUsd ?? candidate.trending?.volume ?? gmgn.volume_24h ?? 0);
  const feesSol = Number(metrics.gmgnTotalFeesSol || 0);
  
  // If reported volume is > $20k but fees collected are suspiciously near zero (< 0.1 SOL)
  if (volumeUsd > 20000 && feesSol < 0.1) {
    score -= 100; // Massive penalty (Instant Reject)
    reasons.push(`fake_volume: Vol $${(volumeUsd/1000).toFixed(0)}K but only ${feesSol} SOL fees`);
  } 
  // If volume is 10x larger than Market Cap but fees are still relatively low
  else if (volumeUsd > 50000 && mcap > 0 && (volumeUsd / mcap) > 10 && feesSol < 0.5) {
    score -= 50;
    reasons.push(`wash_trading: Vol/Mcap ratio > 10x with low fees`);
  }

  // 7. STATE TRANSITION (CoS) DETECTION
  const mint = candidate.token?.mint;
  if (mint) {
    const currentState = {
      liquidity: Number(metrics.liquidityUsd || 0),
      volume: Number(metrics.volumeUsd ?? metrics.trendingVolumeUsd ?? candidate.trending?.volume ?? 0),
      net_buy: Number(trending.net_buyers || gmgn.net_buyers || 0),
      wallet_quality: smartDegens,
      price: Number(metrics.priceUsd || gmgn.price || 0)
    };

    const prevState = getPreviousState(mint);
    
    if (prevState) {
      const { signal: stateSignal, lads_score } = detectStateTransition(currentState, prevState);
      
      // Evidence Fusion: Add LADS score directly
      score += (lads_score || 0);
      reasons.push(`LADS: ${(lads_score || 0).toFixed(1)}`);
      
      if (stateSignal === "ABSORPTION") {
        score += 40; 
        reasons.push(`CoS: ABSORPTION (+40)`);
      } else if (stateSignal === "DISTRIBUTION") {
        score -= 50; 
        reasons.push(`CoS: DISTRIBUTION (-50)`);
      } else {
        reasons.push(`CoS: NO_STATE_CHANGE`);
      }
    } else {
      reasons.push(`CoS: INITIALIZING_MEMORY`);
    }

    // Save for next tick
    saveCurrentState(mint, currentState);
  }

  const passed = score >= threshold;

  return { passed, score, reasons, threshold };
}

export default preScoreCandidate;
