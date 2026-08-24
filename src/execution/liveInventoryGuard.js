function positiveRaw(value, label) {
  const text = value == null ? '' : String(value);
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
    throw new Error(`${label} must be a positive raw token amount.`);
  }
  return BigInt(text);
}

export function resolveTrackedSellAmount({ positionAmountRaw, walletAmountRaw }) {
  const tracked = positiveRaw(positionAmountRaw, 'Tracked position amount');
  if (walletAmountRaw == null) {
    throw new Error('Live sell requires an authoritative wallet token balance.');
  }
  const wallet = positiveRaw(walletAmountRaw, 'Wallet token balance');
  if (wallet < tracked) {
    throw new Error(`Tracked position amount ${tracked} exceeds wallet token balance ${wallet}; refusing ambiguous sell.`);
  }

  // Wallet inventory may contain manual transfers or holdings from another
  // system. Angel owns only the inventory recorded on this position, so a
  // larger wallet balance must never increase the sell amount.
  return tracked.toString();
}

export function hasPositiveRawAmount(value) {
  const text = value == null ? '' : String(value);
  return /^\d+$/.test(text) && BigInt(text) > 0n;
}
