import { now } from '../utils.js';
import { boolSetting, activeStrategy, numSetting, setting } from '../db/settings.js';
import { fetchGmgnTrendingRows, fetchJupiterTrendingRows, storeSignalEvent } from './trending.js';

const LOOKBACK_MS = 15 * 60 * 1000;
const seen = new Map();
let candidateHandler = null;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

function enabled() {
  return activeStrategy()?.id === 'second_wave_smart_money'
    && boolSetting('second_wave_enabled', true);
}

function prune() {
  const cutoff = now() - LOOKBACK_MS;
  for (const [mint, at] of seen) {
    if (at < cutoff) seen.delete(mint);
  }
}

export async function fetchSecondWaveUniverse() {
  if (!enabled()) return { loaded: 0, triggered: 0, skipped: 'inactive' };
  prune();
  const limit = Math.max(10, Math.min(100, Math.floor(numSetting('second_wave_scan_limit', 50))));
  let rows = [];
  let source = setting('second_wave_source', 'gmgn');
  try {
    if (source === 'jupiter') {
      rows = await fetchJupiterTrendingRows('24h', limit);
    } else {
      rows = await fetchGmgnTrendingRows('24h', limit);
    }
  } catch (error) {
    if (source !== 'jupiter') {
      try {
        rows = await fetchJupiterTrendingRows('24h', limit);
        source = 'jupiter_fallback';
      } catch (fallbackError) {
        console.log(`[second-wave] universe fetch failed: ${error.message}; fallback failed: ${fallbackError.message}`);
        return { loaded: 0, triggered: 0, error: error.message };
      }
    } else {
      console.log(`[second-wave] universe fetch failed: ${error.message}`);
      return { loaded: 0, triggered: 0, error: error.message };
    }
  }

  let triggered = 0;
  for (const row of rows) {
    const mint = row?.address || row?.mint || row?.token_address;
    if (!mint || seen.has(mint)) continue;
    seen.set(mint, now());
    const token = { ...row, address: mint, source: `second_wave_${source}`, seenAt: now() };
    storeSignalEvent(mint, 'second_wave', token.source, token);
    if (candidateHandler) {
      candidateHandler({
        mint,
        trendingToken: token,
        route: 'second_wave',
        secondWaveSignal: token,
      }).catch(error => console.log(`[second-wave] candidate ${mint.slice(0, 8)} failed: ${error.message}`));
      triggered += 1;
    }
  }
  console.log(`[second-wave] ${source} loaded ${rows.length}, triggered ${triggered}, tracking ${seen.size}`);
  return { loaded: rows.length, triggered, source };
}

