const LIVE_ALIASES = new Set(['live', 'confirm']);

export function publicExecutionMode(value = 'dry_run') {
  const normalized = String(value || 'dry_run').trim().toLowerCase();
  return LIVE_ALIASES.has(normalized) ? 'LIVE' : 'PAPER';
}

export function isPaperExecutionMode(value = 'dry_run') {
  return publicExecutionMode(value) === 'PAPER';
}
