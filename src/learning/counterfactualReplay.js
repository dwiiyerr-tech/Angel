function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export const REPLAY_POLICIES = Object.freeze({
  v32: {
    version: 'v32_static_exit', stopR: -1, trailArmR: 1, trailGivebackR: 0.75,
    profitFloorR: 0, partialAtR: null, partialSellFraction: 0,
  },
  v33: {
    version: 'v33_asymmetric_runner', stopR: -1, trailArmR: 1, trailGivebackR: 1.25,
    profitFloorR: 0.35, partialAtR: 1.25, partialSellFraction: 0.25,
  },
});

export function replayPathPolicy(observations = [], policy = REPLAY_POLICIES.v33) {
  const path = observations
    .map(row => ({
      atMs: finite(row?.atMs ?? row?.at_ms ?? row?.observed_at_ms),
      r: finite(row?.r ?? row?.r_multiple),
      buyerRatio: finite(row?.buyerRatio ?? row?.buyer_ratio),
    }))
    .filter(row => row.atMs != null && row.r != null)
    .sort((a, b) => a.atMs - b.atMs);
  if (!path.length) return { version: policy.version, eligible: false, exitR: null, reason: 'no_path' };
  let peakR = path[0].r;
  let trailArmed = false;
  let remainingFraction = 1;
  let realizedR = 0;
  let partial = null;
  const flowObservationCount = path.filter(point => point.buyerRatio != null).length;
  const finish = (point, reason) => ({
    version: policy.version,
    eligible: true,
    exitR: Number((realizedR + remainingFraction * point.r).toFixed(6)),
    terminalR: point.r,
    reason,
    exitAtMs: point.atMs,
    peakR,
    partial,
    methodology: 'executable_discrete_quotes_gap_aware',
    flowObservationCount,
  });
  for (const point of path) {
    peakR = Math.max(peakR, point.r);
    if (!partial && finite(policy.partialAtR) != null && point.r >= Number(policy.partialAtR)) {
      const fraction = Math.max(0, Math.min(0.95, Number(policy.partialSellFraction) || 0));
      if (fraction > 0) {
        realizedR += point.r * fraction;
        remainingFraction -= fraction;
        partial = { atMs: point.atMs, r: point.r, fraction };
      }
    }
    if (point.r <= policy.stopR) {
      return finish(point, 'stop');
    }
    if (peakR >= policy.trailArmR) trailArmed = true;
    if (trailArmed && finite(policy.weakeningBuyerRatio) != null
        && point.buyerRatio != null && point.buyerRatio <= Number(policy.weakeningBuyerRatio)) {
      return finish(point, 'flow_weakening');
    }
    if (trailArmed) {
      const trailFloor = Math.max(policy.profitFloorR, peakR - policy.trailGivebackR);
      if (point.r <= trailFloor) {
        return finish(point, 'trail');
      }
    }
  }
  return finish(path[path.length - 1], 'path_end');
}

export function replayPolicyFromConfig(config = {}, label = 'config') {
  const settings = config?.settings || config || {};
  const stopPercent = Math.max(0.01, Math.abs(finite(settings.default_sl_percent) ?? 15));
  const trailingEnabled = String(settings.default_trailing_enabled ?? 'true') !== 'false';
  const partialEnabled = String(settings.default_partial_tp_enabled ?? '1') !== '0';
  return {
    version: `${label}_executable_exit`,
    stopR: -1,
    trailArmR: trailingEnabled ? Math.max(0, (finite(settings.trailing_arm_percent) ?? 15) / stopPercent) : Number.POSITIVE_INFINITY,
    trailGivebackR: trailingEnabled ? Math.max(0, (finite(settings.default_trailing_percent) ?? 20) / stopPercent) : 0,
    profitFloorR: trailingEnabled ? Math.max(0, (finite(settings.trailing_floor_percent) ?? 2) / stopPercent) : 0,
    partialAtR: partialEnabled ? Math.max(0, (finite(settings.default_partial_tp_at_percent) ?? 20) / stopPercent) : null,
    partialSellFraction: partialEnabled
      ? Math.max(0, Math.min(0.95, (finite(settings.default_partial_tp_sell_percent) ?? 25) / 100))
      : 0,
    weakeningBuyerRatio: finite(settings.runner_weakening_buyer_ratio),
  };
}

export function compareReplayPolicies(observations = []) {
  const v32 = replayPathPolicy(observations, REPLAY_POLICIES.v32);
  const v33 = replayPathPolicy(observations, REPLAY_POLICIES.v33);
  return {
    version: 'v32-v33-counterfactual-v1', v32, v33,
    deltaR: v32.exitR == null || v33.exitR == null ? null : Number((v33.exitR - v32.exitR).toFixed(4)),
  };
}
