// v3 adds expected network/priority fees and quote-sized partial exits.
export const DRY_RUN_SIMULATOR_VERSION = 'quote_sized_v3';
export const MIN_VERSIONED_LEARNING_TRADES = 50;
// Learning-grade outcomes must use a real position-sized Jupiter entry quote.
// Fallback market marks are excluded from shadow-live learning.
export const MAX_ENTRY_QUOTE_FALLBACK_RATE = 0;
