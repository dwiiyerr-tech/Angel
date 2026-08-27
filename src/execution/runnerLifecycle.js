function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function marketFlowSnapshot(asset = {}, { entryLiquidityUsd = null } = {}) {
  const stats5m = asset?.stats5m || {};
  const netBuyers = finite(stats5m.numNetBuyers);
  const traders = finite(stats5m.numTraders);
  const buys = finite(stats5m.numBuys);
  const sells = finite(stats5m.numSells);
  const buyerRatio = netBuyers != null && traders != null && traders > 0 ? netBuyers / traders : null;
  const tradeImbalance = buys != null && sells != null && buys + sells > 0 ? (buys - sells) / (buys + sells) : null;
  const currentLiquidity = finite(asset?.liquidity);
  const entryLiquidity = finite(entryLiquidityUsd);
  const liquidityRetention = currentLiquidity != null && currentLiquidity > 0 && entryLiquidity != null && entryLiquidity > 0
    ? currentLiquidity / entryLiquidity
    : null;
  const known = [buyerRatio, tradeImbalance].filter(value => value != null);
  const strength = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  return {
    buyerRatio,
    tradeImbalance,
    liquidityRetention,
    strength: strength == null ? null : clamp(strength, -1, 1),
  };
}

/**
 * Deterministic state authority for one position. It never changes risk caps or
 * executes orders; callers decide whether PAPER or approved LIVE may act on it.
 */
export function evaluateRunnerLifecycle({
  persistedState = 'LEGACY',
  ageMs = 0,
  pnlPercent = 0,
  peakPnl = 0,
  flow = {},
} = {}, {
  validationMinMs = 30_000,
  validationMaxMs = 90_000,
  confirmationPnlPercent = 3,
  thesisLossPercent = -10,
  catastrophicLossPercent = -25,
  catastrophicLiquidityRetention = 0.35,
  minimumBuyerRatio = 0.10,
  weakeningBuyerRatio = -0.15,
  runnerPeakPercent = 25,
  moonPeakPercent = 100,
} = {}) {
  const state = String(persistedState || 'LEGACY').toUpperCase();
  const age = Math.max(0, Number(ageMs) || 0);
  const pnl = Number(pnlPercent) || 0;
  const peak = Math.max(pnl, Number(peakPnl) || 0);
  const buyerRatio = finite(flow?.buyerRatio);
  const liquidityRetention = finite(flow?.liquidityRetention);
  const lateFlowScore = finite(flow?.lateFlowScore);
  const sourceCount = Math.max(1, Number(flow?.sourceCount) || 1);
  const catastrophic = pnl <= -Math.abs(catastrophicLossPercent)
    || (liquidityRetention != null && liquidityRetention <= catastrophicLiquidityRetention);
  if (catastrophic) {
    return {
      state: 'FAILED', action: 'EXIT', reason: 'catastrophic_invalidation',
      trailAdjustmentPercent: -8, floorAdjustmentPercent: 0,
    };
  }

  if (state === 'FAILED') {
    return {
      state: 'FAILED', action: 'EXIT', reason: 'persisted_probe_failure',
      trailAdjustmentPercent: -8, floorAdjustmentPercent: 0,
    };
  }

  if (state === 'PROBE') {
    const flowFailed = buyerRatio != null && buyerRatio <= weakeningBuyerRatio;
    if (pnl <= thesisLossPercent || (age >= validationMinMs && flowFailed)) {
      return {
        state: 'FAILED', action: 'EXIT', reason: pnl <= thesisLossPercent ? 'probe_loss' : 'probe_flow_failed',
        trailAdjustmentPercent: -8, floorAdjustmentPercent: 0,
      };
    }
    // Late independent evidence may fill a missing flow snapshot, but never
    // override observed selling. This lets delayed smart-money confirmation
    // validate a probe without allowing narrative/source count to mask a dump.
    const lateIndependentConfirmation = buyerRatio == null
      && sourceCount >= 2
      && lateFlowScore != null
      && lateFlowScore >= 65;
    const flowConfirmed = (buyerRatio != null && buyerRatio >= minimumBuyerRatio)
      || lateIndependentConfirmation;
    if (age >= validationMinMs && age <= validationMaxMs && pnl >= confirmationPnlPercent && flowConfirmed) {
      return {
        state: 'CONFIRMED', action: 'SCALE', reason: 'price_and_flow_confirmed',
        trailAdjustmentPercent: 2, floorAdjustmentPercent: 0,
      };
    }
    if (age > validationMaxMs) {
      return {
        state: 'FAILED', action: 'EXIT', reason: 'probe_timeout_unconfirmed',
        trailAdjustmentPercent: -8, floorAdjustmentPercent: 0,
      };
    }
    return { state: 'PROBE', action: 'HOLD', reason: 'awaiting_confirmation', trailAdjustmentPercent: 0, floorAdjustmentPercent: 0 };
  }

  const weakening = buyerRatio != null && buyerRatio <= weakeningBuyerRatio;
  if (peak >= moonPeakPercent) {
    return {
      state: weakening ? 'DISTRIBUTION' : 'MOON', action: weakening ? 'TIGHTEN' : 'HOLD',
      reason: weakening ? 'moon_flow_weakening' : 'moon_flow_intact',
      trailAdjustmentPercent: weakening ? -8 : 8,
      floorAdjustmentPercent: weakening ? 5 : 0,
    };
  }
  if (peak >= runnerPeakPercent) {
    return {
      state: weakening ? 'DISTRIBUTION' : 'RUNNER', action: weakening ? 'TIGHTEN' : 'HOLD',
      reason: weakening ? 'runner_flow_weakening' : 'runner_flow_intact',
      trailAdjustmentPercent: weakening ? -6 : 5,
      floorAdjustmentPercent: weakening ? 3 : 0,
    };
  }
  if (state === 'LEGACY') {
    return { state: 'LEGACY', action: 'HOLD', reason: 'legacy_compatibility', trailAdjustmentPercent: 0, floorAdjustmentPercent: 0 };
  }
  return { state: 'CONFIRMED', action: 'HOLD', reason: 'confirmed_building', trailAdjustmentPercent: 2, floorAdjustmentPercent: 0 };
}
