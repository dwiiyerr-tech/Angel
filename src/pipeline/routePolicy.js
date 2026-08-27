export function parseBlockedRoutes(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return new Set(parsed.map(route => String(route || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function candidateRoutes(candidate = {}) {
  const signals = candidate?.signals || candidate || {};
  const routes = Array.isArray(signals.routes) ? signals.routes : [];
  return [...new Set([...routes, signals.primaryRoute, signals.route]
    .map(route => String(route || '').trim())
    .filter(route => route && route !== 'dual_source'))];
}

export function isRouteBlocked(candidateOrRoute, blockedRoutes) {
  const blocked = blockedRoutes instanceof Set ? blockedRoutes : parseBlockedRoutes(blockedRoutes);
  if (typeof candidateOrRoute === 'string') return blocked.has(candidateOrRoute);
  const routes = candidateRoutes(candidateOrRoute);
  // A blocked source cannot admit a token by itself, but it also cannot poison
  // an independently confirmed route. A multi-source candidate is blocked only
  // when every concrete route is disabled.
  return routes.length > 0 && routes.every(route => blocked.has(route));
}
