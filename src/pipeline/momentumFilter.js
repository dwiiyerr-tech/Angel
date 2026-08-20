import axios from 'axios';
import { setting } from '../db/settings.js';

const ML_SERVICE_PORT = process.env.ML_SERVICE_PORT || 8001;
const ML_SERVICE_URL = `http://127.0.0.1:${ML_SERVICE_PORT}/predict`;
const TIMEOUT_MS = 2000;
const DEFAULT_THRESHOLD = 0.5;

/**
 * Score a candidate using the ML service.
 * Fail-open fallback: always passes if service fails/timeouts.
 */
export async function momentumFilter(candidate, threshold = DEFAULT_THRESHOLD) {
  const startTime = Date.now();
  const mint = candidate.token?.mint?.slice(0, 8) || 'unknown';
  const failClosed = setting('trading_mode', 'dry_run') !== 'dry_run';
  
  // Check if we have price data
  const price = candidate.gmgn?.price || {};
  if (!price.price && !price.price_1h) {
    console.log(`[momentum] ${mint}... no price data — pass`);
    return { passed: !failClosed, score: failClosed ? -1 : 1.0, reason: 'no_price_data' };
  }

  try {
    const res = await axios.post(ML_SERVICE_URL, { candidate }, { timeout: TIMEOUT_MS });
    const score = res.data.momentum_score;
    
    if (score < 0) {
      console.error(`[momentum] ${mint}... ML error: ${res.data.error || 'unknown'} — pass`);
      return { passed: !failClosed, score: -1, reason: res.data.error };
    }
    
    const passed = score >= threshold;
    const latency = Date.now() - startTime;
    
    if (!passed) {
      console.log(`[momentum] ${mint}... REJECTED score=${score.toFixed(3)} < ${threshold} (${latency}ms)`);
    } else {
      console.log(`[momentum] ${mint}... PASSED score=${score.toFixed(3)} (${latency}ms)`);
    }
    
    return { passed, score, latency };
  } catch (err) {
    console.error(`[momentum] ${mint}... ML service failed: ${err.message} — pass (fail-open)`);
    return { passed: !failClosed, score: -1, reason: err.message };
  }
}
