import axios from 'axios';
import { WSOL_MINT, JSON_HEADERS, JUPITER_SLIPPAGE_BPS } from '../config.js';
import { now } from '../utils.js';
import { rateLimiter, REQUEST_PRIORITY } from './rateLimiter.js';

class SimpleLRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
  }
}

const jupiterAssetCache = new SimpleLRUCache(500);
let jupiterAssetBackoffUntil = 0;
const MAX_STALE_ASSET_MS = 2 * 60 * 1000;

function withDataQuality(data, { fetchedAt, stale = false, error = null } = {}) {
  if (!data) return null;
  return {
    ...data,
    _dataQuality: {
      source: 'jupiter',
      fetchedAt: fetchedAt || now(),
      ageMs: Math.max(0, now() - (fetchedAt || now())),
      stale,
      error,
    },
  };
}

function jupiterAssetBackoffActive() {
  return now() < jupiterAssetBackoffUntil;
}

function setJupiterAssetBackoff(err) {
  if (err.response?.status !== 429) return;
  const resetHeader = Number(err.response?.headers?.['x-ratelimit-reset'] || 0);
  const resetMs = resetHeader > 1_000_000_000_000 ? resetHeader : resetHeader * 1000;
  jupiterAssetBackoffUntil = resetMs > now() ? resetMs : now() + 30_000;
  console.log(`[asset] backing off until ${new Date(jupiterAssetBackoffUntil).toISOString()} (429)`);
}

let quoteBackoffUntil = 0;

function quoteBackoffActive() {
  return now() < quoteBackoffUntil;
}

function setQuoteBackoff(err) {
  if (err.response?.status !== 429) return;
  const resetHeader = Number(err.response?.headers?.['x-ratelimit-reset'] || 0);
  const resetMs = resetHeader > 1_000_000_000_000 ? resetHeader : resetHeader * 1000;
  quoteBackoffUntil = resetMs > now() ? resetMs : now() + 30_000;
  console.log(`[quote] backing off until ${new Date(quoteBackoffUntil).toISOString()} (429)`);
}

let solUsdCache = { price: null, at: 0 };

function jupiterStatsForInterval(row, interval) {
  const key = `stats${interval}`;
  return row?.[key] || row?.stats5m || row?.stats1h || row?.stats24h || {};
}

function normalizeJupiterTrendingRow(row, interval, rank) {
  const stats = jupiterStatsForInterval(row, interval);
  const buyVolume = Number(stats.buyVolume ?? 0);
  const sellVolume = Number(stats.sellVolume ?? 0);
  const numBuys = Number(stats.numBuys ?? 0);
  const numSells = Number(stats.numSells ?? 0);
  const topHolders = Number(row?.audit?.topHoldersPercentage);
  const botHolders = Number(row?.audit?.botHoldersPercentage);
  return {
    ...row,
    address: row?.id,
    price: Number(row?.usdPrice ?? 0),
    volume: buyVolume + sellVolume,
    liquidity: Number(row?.liquidity ?? 0),
    market_cap: Number(row?.mcap ?? row?.fdv ?? 0),
    swaps: numBuys + numSells,
    buys: numBuys,
    sells: numSells,
    holder_count: Number(row?.holderCount ?? 0),
    top_10_holder_rate: Number.isFinite(topHolders) ? topHolders / 100 : null,
    launchpad_platform: row?.launchpad || null,
    launchpad_status: row?.graduatedAt ? '2' : null,
    smart_degen_count: Number(stats.numOrganicBuyers ?? 0),
    hot_level: Number(row?.organicScore ?? 0),
    rug_ratio: null,
    // Jupiter exposes bot-holder percentage, not bundler participation. Keep the
    // semantics separate so missing bundler data cannot look artificially clean.
    bundler_rate: null,
    bot_degen_rate: Number.isFinite(botHolders) ? botHolders / 100 : null,
    source: 'jupiter_toptrending',
    interval,
    rank,
    stats,
  };
}

async function fetchJupiterAsset(mint, { useCache = true, ttlMs = 20_000 } = {}) {
  const cached = jupiterAssetCache.get(mint);
  const cacheAge = cached ? now() - cached.at : Infinity;
  if (useCache && cached && cacheAge < ttlMs) return withDataQuality(cached.data, { fetchedAt: cached.at });
  if (jupiterAssetBackoffActive()) {
    return cacheAge <= MAX_STALE_ASSET_MS
      ? withDataQuality(cached.data, { fetchedAt: cached.at, stale: true, error: 'rate_limited' })
      : null;
  }
  try {
    const url = new URL('https://datapi.jup.ag/v1/assets/search');
    url.searchParams.set('query', mint);
    const res = await rateLimiter.schedule(() => axios.get(url.toString(), {
      timeout: 10_000,
      headers: JSON_HEADERS,
    }), 'jupiter', REQUEST_PRIORITY.ENRICHMENT);
    const rows = Array.isArray(res.data) ? res.data : [];
    const data = rows.find(row => row?.id === mint) || rows[0] || null;
    jupiterAssetCache.set(mint, { at: now(), data });
    return withDataQuality(data, { fetchedAt: now() });
  } catch (err) {
    setJupiterAssetBackoff(err);
    if (err.response?.status !== 429) console.log(`[asset] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return cacheAge <= MAX_STALE_ASSET_MS
      ? withDataQuality(cached.data, { fetchedAt: cached.at, stale: true, error: err.code || err.message })
      : null;
  }
}

async function fetchSolUsdPrice() {
  try {
    const res = await rateLimiter.schedule(() => axios.get(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`, {
      timeout: 5000,
      headers: JSON_HEADERS,
    }), 'jupiter', REQUEST_PRIORITY.ENRICHMENT);
    const price = Number(res.data?.[WSOL_MINT]?.usdPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (err) {
    console.log(`[sol-price] ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function estimateTokenAmountFromSol(sizeSol, entryPrice) {
  if (!Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) return null;
  const solUsd = await fetchSolUsdPrice();
  if (!Number.isFinite(Number(solUsd)) || Number(solUsd) <= 0) return null;
  return Number(sizeSol) * solUsd / Number(entryPrice);
}

async function fetchJupiterHolders(mint) {
  try {
    const res = await rateLimiter.schedule(() => axios.get(`https://datapi.jup.ag/v1/holders/${mint}`, {
      timeout: 10_000,
      headers: JSON_HEADERS,
    }), 'jupiter', REQUEST_PRIORITY.ENRICHMENT);
    const holders = Array.isArray(res.data?.holders) ? res.data.holders : [];
    const supply = Number(res.data?.totalSupply ?? res.data?.supply ?? 0);
    const mapped = holders.map((holder, index) => {
      const suppliedPct = Number(holder.percentage ?? holder.percent ?? holder.pct);
      const pct = Number.isFinite(suppliedPct)
        ? suppliedPct
        : supply > 0 ? Number(holder.amount || 0) / supply * 100 : null;
      return {
        address: holder.address,
        rank: index + 1,
        amount: Number(holder.amount || 0),
        percent: pct,
        tags: (holder.tags || []).map(tag => tag.name || tag.id).filter(Boolean),
      };
    });
    const top20 = mapped.slice(0, 20);
    return {
      count: holders.length,
      holders: mapped,
      top20,
      top20Percent: top20.every(holder => Number.isFinite(holder.percent))
        ? top20.reduce((sum, holder) => sum + holder.percent, 0)
        : null,
      maxHolderPercent: top20.some(holder => Number.isFinite(holder.percent))
        ? Math.max(...top20.filter(holder => Number.isFinite(holder.percent)).map(holder => holder.percent))
        : null,
      percentageBasis: supply > 0 ? 'total_supply' : (mapped.some(holder => holder.percent != null) ? 'api_percentage' : 'unknown'),
      dataQuality: { source: 'jupiter_holders', fetchedAt: now(), stale: false, complete: supply > 0 },
    };
  } catch (err) {
    console.log(`[holders] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return {
      count: null,
      holders: [],
      top20: [],
      top20Percent: null,
      maxHolderPercent: null,
      percentageBasis: 'unknown',
      dataQuality: { source: 'jupiter_holders', fetchedAt: now(), stale: false, error: err.code || err.message },
    };
  }
}

function summarizeCandles(label, candles) {
  if (!candles.length) return { label, available: false };
  const first = candles[0];
  const last = candles[candles.length - 1];
  const high = Math.max(...candles.map(candle => Number(candle.high || 0)));
  const low = Math.min(...candles.map(candle => Number(candle.low || Infinity)));
  const volumeNative = candles.reduce((sum, candle) => sum + Number(candle.volume || 0), 0);
  const current = Number(last.close);
  const start = Number(first.open);
  const recentWindow = candles.slice(-12);
  const priorWindow = candles.slice(-36, -12);
  const avgVolume = rows => rows.length ? rows.reduce((sum, candle) => sum + Number(candle.volume || 0), 0) / rows.length : null;
  const recentHigh = Math.max(...recentWindow.map(candle => Number(candle.high || 0)));
  const recentLow = Math.min(...recentWindow.map(candle => Number(candle.low || Infinity)));
  const priorHigh = priorWindow.length ? Math.max(...priorWindow.map(candle => Number(candle.high || 0))) : null;
  const priorLow = priorWindow.length ? Math.min(...priorWindow.map(candle => Number(candle.low || Infinity))) : null;
  const higherLow = Number.isFinite(priorLow) && Number.isFinite(recentLow) ? recentLow >= priorLow : null;
  const priorAvgVolume = avgVolume(priorWindow);
  const recentAvgVolume = avgVolume(recentWindow);
  const rangeCompression = priorHigh > priorLow && recentHigh > recentLow
    ? (recentHigh - recentLow) / (priorHigh - priorLow)
    : null;
  const lastVolume = Number(last.volume || 0);
  return {
    label,
    available: true,
    purpose: label === 'ath_context_24h_5m' ? 'ath_context' : 'range_context',
    candles: candles.length,
    fromTime: first.time,
    toTime: last.time,
    current,
    high,
    low,
    volumeNative,
    changePercent: start > 0 ? (current / start - 1) * 100 : null,
    belowHighPercent: high > 0 ? (current / high - 1) * 100 : null,
    aboveLowPercent: low > 0 && Number.isFinite(low) ? (current / low - 1) * 100 : null,
    recentHigh,
    recentLow,
    priorHigh,
    priorLow,
    recentRangePercent: recentHigh > 0 ? (recentHigh / Math.max(recentLow, Number.EPSILON) - 1) * 100 : null,
    priorAvgVolume,
    recentAvgVolume,
    recentVolumeVsPrior: priorAvgVolume > 0 ? recentAvgVolume / priorAvgVolume : null,
    lastVolume,
    lastVolumeVsRecent: recentAvgVolume > 0 ? lastVolume / recentAvgVolume : null,
    rangeCompression,
    higherLow,
    reclaimOfPriorHigh: priorHigh > 0 && current >= priorHigh,
    candleDataQuality: candles.length >= 24 ? 'verified' : 'insufficient',
  };
}

async function fetchJupiterChartWindow(mint, interval, candles, label) {
  const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
  url.searchParams.set('interval', interval);
  url.searchParams.set('to', String(now()));
  url.searchParams.set('candles', String(candles));
  url.searchParams.set('type', 'price');
  url.searchParams.set('quote', 'native');
  const res = await rateLimiter.schedule(() => axios.get(url.toString(), {
    timeout: 10_000,
    headers: JSON_HEADERS,
  }), 'jupiter', REQUEST_PRIORITY.ENRICHMENT);
  return summarizeCandles(label, Array.isArray(res.data?.candles) ? res.data.candles : []);
}

async function fetchJupiterChartContext(mint) {
  const windows = [
    ['5_MINUTE', 288, 'ath_context_24h_5m'],
    ['1_HOUR', 168, 'swing_7d_1h'],
    ['4_HOUR', 180, 'long_30d_4h'],
  ];
  const results = await Promise.all(windows.map(([interval, candles, label]) => (
    fetchJupiterChartWindow(mint, interval, candles, label).catch((err) => {
      console.log(`[chart] ${mint.slice(0, 8)}... ${interval} ${err.message}`);
      return { label, available: false, error: err.message };
    })
  )));
  const available = results.filter(row => row.available);
  const currentNative = available[0]?.current ?? null;
  const rangeHigh = available.length ? Math.max(...available.map(row => Number(row.high || 0))) : null;
  const topBlastRisk = Number.isFinite(Number(currentNative)) && Number.isFinite(Number(rangeHigh)) && rangeHigh > 0
    ? currentNative / rangeHigh >= 0.85
    : null;
  return {
    quote: 'native',
    purpose: 'ATH/range context, not momentum scoring',
    currentNative,
    rangeHighNative: rangeHigh,
    belowRangeHighPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
    distanceFromAthPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
    topBlastRisk,
    windows: results,
  };
}

const IGNORED_PNL_MINTS = new Set([
  'So11111111111111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

async function fetchSolUsdPriceCached() {
  if (solUsdCache.price != null && now() - solUsdCache.at < 60_000) return solUsdCache.price;
  const price = await fetchSolUsdPrice();
  solUsdCache = { price, at: now() };
  return price;
}

// Fixed 1000-token reference amount ignores price impact for large sizes —
// upgrade to position-sized quotes when size_sol > 1.
async function fetchTokenSpotViaQuote(mint) {
  if (quoteBackoffActive()) return null;
  try {
    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.set('inputMint', mint);
    url.searchParams.set('outputMint', WSOL_MINT);
    url.searchParams.set('amount', '1000000000');
    url.searchParams.set('slippageBps', '100');
    const [solUsd, quoteRes] = await Promise.all([
      fetchSolUsdPriceCached(),
      rateLimiter.schedule(() => axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS }), 'jupiter', REQUEST_PRIORITY.MONITOR),
    ]);
    const outAmount = quoteRes.data?.outAmount;
    if (!outAmount) return null;
    const outSol = Number(outAmount) / 1e9;
    if (!Number.isFinite(solUsd) || solUsd <= 0) return null;
    return (outSol / 1000) * solUsd;
  } catch (err) {
    setQuoteBackoff(err);
    if (err.response?.status !== 429) console.log(`[quote] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function fetchDryRunEntryQuote(mint, sizeSol, decimals, referencePriceUsd, referenceMcapUsd) {
  if (quoteBackoffActive() || !Number.isFinite(Number(sizeSol)) || Number(sizeSol) <= 0) return null;
  if (!Number.isInteger(Number(decimals)) || Number(decimals) < 0) return null;
  try {
    const inputLamports = Math.round(Number(sizeSol) * 1_000_000_000);
    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.set('inputMint', WSOL_MINT);
    url.searchParams.set('outputMint', mint);
    url.searchParams.set('amount', String(inputLamports));
    url.searchParams.set('slippageBps', String(JUPITER_SLIPPAGE_BPS));
    const [solUsd, quoteRes] = await Promise.all([
      fetchSolUsdPriceCached(),
      rateLimiter.schedule(() => axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS }), 'jupiter', REQUEST_PRIORITY.ENTRY_EXIT),
    ]);
    const outputAmountRaw = String(quoteRes.data?.outAmount || '');
    if (!/^\d+$/.test(outputAmountRaw) || BigInt(outputAmountRaw) <= 0n) return null;
    const tokenAmount = Number(outputAmountRaw) / (10 ** Number(decimals));
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || !Number.isFinite(solUsd) || solUsd <= 0) return null;
    const effectivePriceUsd = Number(sizeSol) * solUsd / tokenAmount;
    const referencePrice = Number(referencePriceUsd);
    const referenceMcap = Number(referenceMcapUsd);
    const effectiveMcapUsd = referencePrice > 0 && referenceMcap > 0
      ? referenceMcap * (effectivePriceUsd / referencePrice)
      : null;
    return { inputLamports, outputAmountRaw, tokenAmount, solUsd, effectivePriceUsd, effectiveMcapUsd };
  } catch (err) {
    setQuoteBackoff(err);
    if (err.response?.status !== 429) console.log(`[entry-quote] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function fetchTokenExitQuote(mint, rawAmount) {
  if (quoteBackoffActive() || !rawAmount || BigInt(rawAmount) <= 0n) return null;
  try {
    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.set('inputMint', mint);
    url.searchParams.set('outputMint', WSOL_MINT);
    url.searchParams.set('amount', String(rawAmount));
    url.searchParams.set('slippageBps', String(JUPITER_SLIPPAGE_BPS));
    const quoteRes = await rateLimiter.schedule(() => axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS }), 'jupiter', REQUEST_PRIORITY.ENTRY_EXIT);
    const outLamports = Number(quoteRes.data?.outAmount);
    return Number.isFinite(outLamports) && outLamports >= 0
      ? { outLamports, outSol: outLamports / 1_000_000_000 }
      : null;
  } catch (err) {
    setQuoteBackoff(err);
    if (err.response?.status !== 429) console.log(`[exit-quote] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function fetchJupiterWalletPnl(walletAddress) {
  try {
    const url = new URL('https://datapi.jup.ag/v1/pnl');
    url.searchParams.set('addresses', walletAddress);
    url.searchParams.set('includeClosed', 'false');
    const res = await axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS });
    const data = res.data?.[walletAddress] || {};
    for (const mint of IGNORED_PNL_MINTS) delete data[mint];
    return data;
  } catch (err) {
    console.log(`[pnl] ${err.response?.status || ''} ${err.message}`);
    return {};
  }
}

export {
  jupiterStatsForInterval,
  normalizeJupiterTrendingRow,
  fetchJupiterAsset,
  fetchSolUsdPrice,
  estimateTokenAmountFromSol,
  fetchJupiterHolders,
  summarizeCandles,
  fetchJupiterChartWindow,
  fetchJupiterChartContext,
  fetchJupiterWalletPnl,
  fetchTokenSpotViaQuote,
  fetchDryRunEntryQuote,
  fetchTokenExitQuote,
  jupiterAssetBackoffActive,
  setJupiterAssetBackoff,
};
