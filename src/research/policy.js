import { setting } from '../db/settings.js';

// Angel exposes exactly two trading modes: PAPER and LIVE.
// Old names stay accepted only as migration aliases so existing databases and
// historical tooling cannot accidentally create a third/fourth runtime mode.
const PAPER_ALIASES = new Set([
  'paper',
  'paper_trading',
  'dry_run',
  'dry-run',
  'simulation',
  'research',
  'shadow',
  'shadow_live',
]);
const LIVE_ALIASES = new Set(['confirm', 'live']);

export function normalizeConfiguredMode(value = 'dry_run') {
  const normalized = String(value || 'dry_run').trim().toLowerCase();
  if (LIVE_ALIASES.has(normalized)) return 'live';
  if (PAPER_ALIASES.has(normalized)) return 'paper';
  return 'paper';
}

export function configuredTradingMode() {
  return normalizeConfiguredMode(setting('trading_mode', 'dry_run'));
}

export function isPaperTradingMode(value = null) {
  return normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value) === 'paper';
}

// Compatibility name used throughout the existing Research execution engine.
// Research is now the implementation of PAPER, not a separate user-facing mode.
export function isResearchSimulationMode(value = null) {
  return isPaperTradingMode(value);
}

// Shadow is retired as a selectable mode. Keep the export temporarily so old
// imports remain source-compatible while returning canonical two-mode semantics.
export function isPreLiveShadowMode() {
  return false;
}

export function requiresMoneyGradeEvidence(value = null) {
  return normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value) === 'live';
}

export function isRealMoneyMode(value = null) {
  return normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value) === 'live';
}

export function modeCapabilities(value = null) {
  const mode = normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value);
  const live = mode === 'live';
  return {
    mode,
    paper: !live,
    live,
    // Compatibility field for Research engine/report code.
    research: !live,
    walletRequired: live,
    broadcastAllowed: live,
    perTradeConfirmationRequired: false,
    autonomousBroadcastAllowed: live,
    moneyGradeEvidence: live,
    ownerApprovalRequired: live,
  };
}
