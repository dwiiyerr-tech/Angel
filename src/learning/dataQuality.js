import { safeJson } from '../utils.js';
import { MAX_ENTRY_QUOTE_FALLBACK_RATE, MIN_VERSIONED_LEARNING_TRADES } from './simulatorVersion.js';

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

export function validateDryRunRows(positions, trades = [], { expectedSimulatorVersion = null } = {}) {
  const tradeSides = new Map();
  for (const trade of trades) {
    const sides = tradeSides.get(Number(trade.position_id)) || new Set();
    sides.add(String(trade.side || '').toLowerCase());
    tradeSides.set(Number(trade.position_id), sides);
  }

  const issues = {
    invalidSnapshotJson: 0,
    closeBeforeOpen: 0,
    closedWithoutTimestamp: 0,
    closedWithoutPnl: 0,
    invalidEntry: 0,
    missingBuyLedger: 0,
    missingSellLedger: 0,
    simulatorVersionMismatch: 0,
  };
  let positionSizedEntryQuotes = 0;
  let fallbackEntryQuotes = 0;

  for (const position of positions) {
    const closed = position.status === 'closed';
    const snapshot = safeJson(position.snapshot_json, null);
    if (!snapshot) issues.invalidSnapshotJson += 1;
    if (expectedSimulatorVersion && snapshot?.simulatorVersion !== expectedSimulatorVersion) issues.simulatorVersionMismatch += 1;
    if (snapshot?.entryQuoteMode === 'position_sized' && snapshot?.entryQuote?.outputAmountRaw) positionSizedEntryQuotes += 1;
    else if (expectedSimulatorVersion) fallbackEntryQuotes += 1;
    if (closed && !finite(position.closed_at_ms)) issues.closedWithoutTimestamp += 1;
    if (closed && finite(position.closed_at_ms) && Number(position.closed_at_ms) < Number(position.opened_at_ms)) issues.closeBeforeOpen += 1;
    if (closed && (!finite(position.pnl_percent) || !finite(position.pnl_sol))) issues.closedWithoutPnl += 1;
    if (!finite(position.entry_mcap) || Number(position.entry_mcap) <= 0 || !finite(position.size_sol) || Number(position.size_sol) <= 0) issues.invalidEntry += 1;
    const sides = tradeSides.get(Number(position.id));
    if (expectedSimulatorVersion && !sides?.has('buy')) issues.missingBuyLedger += 1;
    if (expectedSimulatorVersion && closed && !sides?.has('sell')) issues.missingSellLedger += 1;
  }

  const issueCount = Object.values(issues).reduce((sum, count) => sum + count, 0);
  const quoteAttempts = positionSizedEntryQuotes + fallbackEntryQuotes;
  const entryQuoteFallbackRate = quoteAttempts ? fallbackEntryQuotes / quoteAttempts : null;
  const learningEligible = issueCount === 0
    && positions.length >= MIN_VERSIONED_LEARNING_TRADES
    && entryQuoteFallbackRate !== null
    && entryQuoteFallbackRate <= MAX_ENTRY_QUOTE_FALLBACK_RATE;
  return {
    valid: issueCount === 0,
    learningEligible,
    issueCount,
    issues,
    checkedPositions: positions.length,
    positionSizedEntryQuotes,
    fallbackEntryQuotes,
    entryQuoteFallbackRate,
    minimumLearningTrades: MIN_VERSIONED_LEARNING_TRADES,
    maximumFallbackRate: MAX_ENTRY_QUOTE_FALLBACK_RATE,
  };
}
