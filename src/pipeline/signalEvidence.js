const ROUTE_PRIORITY = Object.freeze({
  pumpportal_graduated: 100,
  smart_money: 95,
  gmgn_smart_money: 90,
  trenches_completed: 80,
  fee_trending: 70,
  graduated_trending: 65,
  pumpfun_pregrad: 60,
  trending: 50,
});

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(value => value && value !== 'dual_source'))];
}

export function primaryRouteFor(values = []) {
  return [...unique(values)].sort((a, b) => (ROUTE_PRIORITY[b] || 0) - (ROUTE_PRIORITY[a] || 0))[0] || 'unknown';
}

function mergeObject(base, incoming) {
  const output = { ...(base || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value !== null && value !== undefined && value !== '') output[key] = value;
  }
  return output;
}

export function mergeCandidateEvidence(existing = {}, incoming = {}) {
  const routes = unique([
    ...(existing?.signals?.routes || []), existing?.signals?.primaryRoute, existing?.signals?.route,
    ...(incoming?.signals?.routes || []), incoming?.signals?.primaryRoute, incoming?.signals?.route,
  ]);
  const primaryRoute = primaryRouteFor(routes);
  const riskFlags = [...(existing.riskFlags || []), ...(incoming.riskFlags || [])]
    .filter((flag, index, all) => all.findIndex(item => item?.type === flag?.type && item?.reason === flag?.reason) === index);
  const createdAtMs = Math.min(
    Number(existing.createdAtMs || incoming.createdAtMs || Date.now()),
    Number(incoming.createdAtMs || existing.createdAtMs || Date.now()),
  );
  return {
    ...existing,
    ...incoming,
    token: mergeObject(existing.token, incoming.token),
    metrics: mergeObject(existing.metrics, incoming.metrics),
    dataQuality: mergeObject(existing.dataQuality, incoming.dataQuality),
    signals: {
      ...(existing.signals || {}),
      ...(incoming.signals || {}),
      route: routes.length > 1 ? 'dual_source' : primaryRoute,
      primaryRoute,
      routes,
      sourceCount: routes.length,
      hasFeeClaim: Boolean(existing?.signals?.hasFeeClaim || incoming?.signals?.hasFeeClaim),
      hasGraduated: Boolean(existing?.signals?.hasGraduated || incoming?.signals?.hasGraduated),
      hasTrending: Boolean(existing?.signals?.hasTrending || incoming?.signals?.hasTrending),
      hasSmartMoney: Boolean(existing?.signals?.hasSmartMoney || incoming?.signals?.hasSmartMoney),
    },
    feeClaim: incoming.feeClaim || existing.feeClaim || null,
    graduation: incoming.graduation || existing.graduation || null,
    trending: incoming.trending || existing.trending || null,
    trenchesEntry: incoming.trenchesEntry || existing.trenchesEntry || null,
    smartMoneySignal: incoming.smartMoneySignal || existing.smartMoneySignal || null,
    gmgn: incoming.gmgn || existing.gmgn || null,
    jupiterAsset: incoming.jupiterAsset || existing.jupiterAsset || null,
    holders: incoming.holders || existing.holders || null,
    chart: incoming.chart || existing.chart || null,
    savedWalletExposure: incoming.savedWalletExposure || existing.savedWalletExposure || { holderCount: 0, holders: [] },
    twitterNarrative: incoming.twitterNarrative || existing.twitterNarrative || null,
    volumeAcceleration: incoming.volumeAcceleration?.valid ? incoming.volumeAcceleration : existing.volumeAcceleration,
    riskFlags,
    createdAtMs,
    evidenceMergedAtMs: Date.now(),
  };
}
