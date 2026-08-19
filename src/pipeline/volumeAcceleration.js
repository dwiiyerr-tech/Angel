import { db } from '../db/connection.js';
import { now } from '../utils.js';

let lastPruneAtMs = 0;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function marketObservation(candidate, observedAtMs = now()) {
  const stats = candidate.jupiterAsset?.stats5m || {};
  const buyVolume = finiteOrNull(stats.buyVolume);
  const sellVolume = finiteOrNull(stats.sellVolume);
  const explicitVolume = finiteOrNull(candidate.metrics?.volume5mUsd ?? candidate.trending?.volume);
  const volume5m = buyVolume != null || sellVolume != null
    ? Number(buyVolume || 0) + Number(sellVolume || 0)
    : explicitVolume;
  return {
    mint: candidate.token?.mint,
    observedAtMs,
    volume5m,
    buys5m: finiteOrNull(stats.numBuys ?? candidate.trending?.buys),
    sells5m: finiteOrNull(stats.numSells ?? candidate.trending?.sells),
    netBuyers5m: finiteOrNull(stats.numNetBuyers),
    priceUsd: finiteOrNull(candidate.metrics?.priceUsd),
    liquidityUsd: finiteOrNull(candidate.metrics?.liquidityUsd),
  };
}

function growthRatio(current, previous) {
  const cur = finiteOrNull(current);
  const prev = finiteOrNull(previous);
  if (cur == null || prev == null || prev <= 0) return null;
  return cur / prev;
}

export function calculateVolumeAcceleration(current, previous, {
  minElapsedMs = 30_000,
  maxElapsedMs = 10 * 60_000,
} = {}) {
  if (!previous) return { valid: false, reason: 'no_previous_snapshot' };
  const elapsedMs = Number(current.observedAtMs) - Number(previous.observedAtMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs < minElapsedMs || elapsedMs > maxElapsedMs) {
    return { valid: false, reason: 'snapshot_interval_out_of_range', elapsedMs };
  }
  const volumeAcceleration = growthRatio(current.volume5m, previous.volume5m);
  const buyerAcceleration = growthRatio(current.buys5m, previous.buys5m);
  const sellerAcceleration = growthRatio(current.sells5m, previous.sells5m);
  if (volumeAcceleration == null || buyerAcceleration == null) {
    return { valid: false, reason: 'insufficient_volume_history', elapsedMs };
  }
  return {
    valid: true,
    elapsedMs,
    volumeAcceleration,
    buyerAcceleration,
    sellerAcceleration,
    volumeExpanding: volumeAcceleration >= 1.5,
    buyersExpanding: buyerAcceleration > 1,
    accelerating: volumeAcceleration >= 1.5 && buyerAcceleration > 1,
  };
}

export function observeVolumeAcceleration(candidate) {
  const current = marketObservation(candidate);
  if (!current.mint) return { valid: false, reason: 'missing_mint' };
  const row = db.prepare('SELECT * FROM market_snapshots WHERE mint = ?').get(current.mint);
  const previous = row ? {
    observedAtMs: row.observed_at_ms,
    volume5m: row.volume_5m,
    buys5m: row.buys_5m,
    sells5m: row.sells_5m,
    netBuyers5m: row.net_buyers_5m,
    priceUsd: row.price_usd,
    liquidityUsd: row.liquidity_usd,
  } : null;
  const result = calculateVolumeAcceleration(current, previous);
  db.prepare(`
    INSERT INTO market_snapshots
      (mint, observed_at_ms, volume_5m, buys_5m, sells_5m, net_buyers_5m, price_usd, liquidity_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      observed_at_ms=excluded.observed_at_ms, volume_5m=excluded.volume_5m,
      buys_5m=excluded.buys_5m, sells_5m=excluded.sells_5m,
      net_buyers_5m=excluded.net_buyers_5m, price_usd=excluded.price_usd,
      liquidity_usd=excluded.liquidity_usd
  `).run(current.mint, current.observedAtMs, current.volume5m, current.buys5m,
    current.sells5m, current.netBuyers5m, current.priceUsd, current.liquidityUsd);
  // One row per mint still grows forever as new mints arrive. Prune stale
  // observations cheaply and deterministically without a separate scheduler.
  if (current.observedAtMs - lastPruneAtMs >= 10 * 60 * 1000) {
    db.prepare('DELETE FROM market_snapshots WHERE observed_at_ms < ?')
      .run(current.observedAtMs - 24 * 60 * 60 * 1000);
    lastPruneAtMs = current.observedAtMs;
  }
  return { ...result, current, previous };
}
