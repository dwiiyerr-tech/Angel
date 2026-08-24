function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function confidenceSizeMultiplier(confidence) {
  const c = Math.max(0, Math.min(100, Number(confidence) || 0));
  if (c >= 90) return 1.0;
  if (c >= 70) return 0.85;
  if (c >= 50) return 0.60;
  if (c >= 30) return 0.30;
  return 0;
}

export function softRiskSizeMultiplier(totalSeverity = 0) {
  const severity = Math.max(0, Number(totalSeverity) || 0);
  if (severity >= 6) return 0.25;
  if (severity >= 4) return 0.40;
  if (severity >= 2) return 0.70;
  return 1.0;
}

export function opportunityTier({ confidence = 0, preScore = null, momentum = null } = {}) {
  const c = Math.max(0, Math.min(100, Number(confidence) || 0));
  const p = Number.isFinite(Number(preScore)) ? Math.max(0, Math.min(100, Number(preScore))) : 50;
  const m = Number.isFinite(Number(momentum)) && Number(momentum) >= 0
    ? clamp01(momentum) * 100
    : 50;
  const score = c * 0.50 + p * 0.25 + m * 0.25;
  if (score >= 82) return { tier: 'A+', score };
  if (score >= 70) return { tier: 'A', score };
  if (score >= 55) return { tier: 'B', score };
  return { tier: 'C', score };
}

export function hunterPolicy({
  confidence = 0,
  preScore = null,
  momentum = null,
  totalSoftRiskSeverity = 0,
  catastrophic = false,
} = {}) {
  const tier = opportunityTier({ confidence, preScore, momentum });
  if (catastrophic) {
    return {
      action: 'REJECT',
      reason: 'catastrophic_safety',
      sizeMultiplier: 0,
      ...tier,
    };
  }

  const confidenceMultiplier = confidenceSizeMultiplier(confidence);
  if (confidenceMultiplier <= 0) {
    return {
      action: 'SKIP',
      reason: 'insufficient_opportunity_confidence',
      sizeMultiplier: 0,
      ...tier,
    };
  }

  const softRiskMultiplier = softRiskSizeMultiplier(totalSoftRiskSeverity);
  return {
    action: 'TRADE',
    reason: softRiskMultiplier < 1 ? 'yes_but_smaller' : 'full_opportunity',
    sizeMultiplier: Math.max(0.05, confidenceMultiplier * softRiskMultiplier),
    confidenceMultiplier,
    softRiskMultiplier,
    ...tier,
  };
}
