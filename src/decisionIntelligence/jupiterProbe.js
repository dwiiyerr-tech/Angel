import axios from 'axios';
import { JSON_HEADERS, JUPITER_SLIPPAGE_BPS, WSOL_MINT } from '../config.js';
import { fetchSolUsdPrice } from '../enrichment/jupiter.js';
import { rateLimiter, REQUEST_PRIORITY } from '../enrichment/rateLimiter.js';

function validRawAmount(value) {
  const text = String(value ?? '');
  return /^\d+$/.test(text) && BigInt(text) > 0n;
}

export async function fetchDecisionEntryQuote(mint, sizeSol, decimals, referencePriceUsd, referenceMcapUsd) {
  if (!Number.isFinite(Number(sizeSol)) || Number(sizeSol) <= 0) return null;
  if (!Number.isInteger(Number(decimals)) || Number(decimals) < 0) return null;
  try {
    const inputLamports = Math.round(Number(sizeSol) * 1_000_000_000);
    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.set('inputMint', WSOL_MINT);
    url.searchParams.set('outputMint', mint);
    url.searchParams.set('amount', String(inputLamports));
    url.searchParams.set('slippageBps', String(JUPITER_SLIPPAGE_BPS));
    const [solUsd, quoteRes] = await Promise.all([
      fetchSolUsdPrice(),
      rateLimiter.schedule(
        () => axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS }),
        'jupiter',
        REQUEST_PRIORITY.ENRICHMENT,
      ),
    ]);
    const outputAmountRaw = String(quoteRes.data?.outAmount || '');
    if (!validRawAmount(outputAmountRaw)) return null;
    const tokenAmount = Number(outputAmountRaw) / (10 ** Number(decimals));
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || !Number.isFinite(Number(solUsd)) || Number(solUsd) <= 0) return null;
    const effectivePriceUsd = Number(sizeSol) * Number(solUsd) / tokenAmount;
    const referencePrice = Number(referencePriceUsd);
    const referenceMcap = Number(referenceMcapUsd);
    const effectiveMcapUsd = referencePrice > 0 && referenceMcap > 0
      ? referenceMcap * (effectivePriceUsd / referencePrice)
      : null;
    return {
      inputLamports,
      outputAmountRaw,
      tokenAmount,
      solUsd: Number(solUsd),
      effectivePriceUsd,
      effectiveMcapUsd,
      quotePriority: 'enrichment',
      purpose: 'decision_counterfactual',
    };
  } catch (error) {
    console.warn(`[decision-intel] entry probe quote ${String(mint).slice(0, 8)}... ${error.response?.status || error.code || error.message}`);
    return null;
  }
}

export async function fetchDecisionExitQuote(mint, rawAmount) {
  if (!validRawAmount(rawAmount)) return null;
  try {
    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.set('inputMint', mint);
    url.searchParams.set('outputMint', WSOL_MINT);
    url.searchParams.set('amount', String(rawAmount));
    url.searchParams.set('slippageBps', String(JUPITER_SLIPPAGE_BPS));
    const quoteRes = await rateLimiter.schedule(
      () => axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS }),
      'jupiter',
      REQUEST_PRIORITY.ENRICHMENT,
    );
    const outLamports = Number(quoteRes.data?.outAmount);
    if (!Number.isFinite(outLamports) || outLamports < 0) return null;
    return {
      outLamports,
      outSol: outLamports / 1_000_000_000,
      quotePriority: 'enrichment',
      purpose: 'decision_counterfactual',
    };
  } catch (error) {
    console.warn(`[decision-intel] exit probe quote ${String(mint).slice(0, 8)}... ${error.response?.status || error.code || error.message}`);
    return null;
  }
}
