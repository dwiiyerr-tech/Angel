import { setting } from '../db/settings.js';

const RESEARCH_ALIASES = new Set(['dry_run', 'dry-run', 'simulation', 'research']);
const MONEY_GRADE_MODES = new Set(['shadow_live', 'confirm', 'live']);

export function normalizeConfiguredMode(value = 'dry_run') {
  const normalized = String(value || 'dry_run').trim().toLowerCase();
  if (RESEARCH_ALIASES.has(normalized)) return 'research';
  if (MONEY_GRADE_MODES.has(normalized)) return normalized;
  return 'research';
}

export function configuredTradingMode() {
  return normalizeConfiguredMode(setting('trading_mode', 'dry_run'));
}

export function isResearchSimulationMode(value = null) {
  return normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value) === 'research';
}

export function isPreLiveShadowMode(value = null) {
  return normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value) === 'shadow_live';
}

export function requiresMoneyGradeEvidence(value = null) {
  const mode = normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value);
  return MONEY_GRADE_MODES.has(mode);
}

export function isRealMoneyMode(value = null) {
  const mode = normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value);
  return mode === 'confirm' || mode === 'live';
}

export function modeCapabilities(value = null) {
  const mode = normalizeConfiguredMode(value == null ? setting('trading_mode', 'dry_run') : value);
  return {
    mode,
    research: mode === 'research',
    walletRequired: mode === 'shadow_live' || mode === 'live',
    broadcastAllowed: mode === 'live',
    moneyGradeEvidence: MONEY_GRADE_MODES.has(mode),
  };
}
