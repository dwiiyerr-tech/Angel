export function plannedRiskReward(tpPercent, slPercent) {
  const reward = Number(tpPercent);
  const risk = Math.abs(Number(slPercent));
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || reward <= 0 || risk <= 0) return 0;
  return reward / risk;
}

export function initialRiskSol({ notionalSol, stopPercent, entryFeeSol = 0, expectedExitFeeSol = 0 }) {
  const notional = Number(notionalSol);
  const stop = Math.abs(Number(stopPercent)) / 100;
  const entryFee = Math.max(0, Number(entryFeeSol) || 0);
  const exitFee = Math.max(0, Number(expectedExitFeeSol) || 0);
  if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(stop) || stop <= 0) return 0;
  return notional * stop + entryFee + exitFee;
}

export function rMultiple(pnlSol, riskSol) {
  const pnl = Number(pnlSol);
  const risk = Number(riskSol);
  if (!Number.isFinite(pnl) || !Number.isFinite(risk) || risk <= 0) return null;
  return pnl / risk;
}

export function percentRMultiple(pnlPercent, stopPercent) {
  const pnl = Number(pnlPercent);
  const stop = Math.abs(Number(stopPercent));
  if (!Number.isFinite(pnl) || !Number.isFinite(stop) || stop <= 0) return null;
  return pnl / stop;
}

export function nextExcursionState({
  pnlPercent,
  pnlSol,
  riskSol,
  previousMfePercent = 0,
  previousMaePercent = 0,
  previousMfeR = 0,
  previousMaeR = 0,
  previousTimeToMfeMs = null,
  previousTimeToMaeMs = null,
  ageMs = 0,
}) {
  const pct = Number(pnlPercent);
  const currentR = rMultiple(pnlSol, riskSol);
  const safePct = Number.isFinite(pct) ? pct : 0;
  const safeR = Number.isFinite(currentR) ? currentR : 0;
  const prevMfePct = Number.isFinite(Number(previousMfePercent)) ? Number(previousMfePercent) : 0;
  const prevMaePct = Number.isFinite(Number(previousMaePercent)) ? Number(previousMaePercent) : 0;
  const prevMfeR = Number.isFinite(Number(previousMfeR)) ? Number(previousMfeR) : 0;
  const prevMaeR = Number.isFinite(Number(previousMaeR)) ? Number(previousMaeR) : 0;

  const newMfePct = safePct > prevMfePct;
  const newMaePct = safePct < prevMaePct;
  const newMfeR = safeR > prevMfeR;
  const newMaeR = safeR < prevMaeR;

  return {
    currentR,
    mfePercent: Math.max(prevMfePct, safePct),
    maePercent: Math.min(prevMaePct, safePct),
    mfeR: Math.max(prevMfeR, safeR),
    maeR: Math.min(prevMaeR, safeR),
    timeToMfeMs: (newMfePct || newMfeR) ? Math.max(0, Number(ageMs) || 0) : previousTimeToMfeMs,
    timeToMaeMs: (newMaePct || newMaeR) ? Math.max(0, Number(ageMs) || 0) : previousTimeToMaeMs,
  };
}

export function captureEfficiency(realizedR, mfeR) {
  const realized = Number(realizedR);
  const mfe = Number(mfeR);
  if (!Number.isFinite(realized) || !Number.isFinite(mfe) || mfe <= 0) return null;
  return realized / mfe;
}
