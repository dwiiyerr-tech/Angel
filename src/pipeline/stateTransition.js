import { db } from '../db/connection.js';
import { setting } from '../db/settings.js';

// Initialize schema once at module load
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS token_states (
      mint TEXT PRIMARY KEY,
      state_json TEXT,
      updated_at INTEGER
    )
  `).run();
  // Create index to prevent full table scan on pruning
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_token_states_updated ON token_states(updated_at)`).run();
} catch (e) {
  console.error('[StateMemory] Init error:', e.message);
}

export function getPreviousState(mint) {
  try {
    const row = db.prepare('SELECT state_json, updated_at FROM token_states WHERE mint = ?').get(mint);
    if (row && row.state_json) {
      return { ...JSON.parse(row.state_json), _observedAt: row.updated_at };
    }
  } catch (e) {
    // Ignore db missing table error on first run
  }
  return null;
}

export function saveCurrentState(mint, state) {
  try {
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO token_states (mint, state_json, updated_at) 
      VALUES (?, ?, ?) 
      ON CONFLICT(mint) DO UPDATE SET 
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(mint, JSON.stringify(state), now);

    // Auto-prune memory older than 24 hours (86400000 ms)
    // Only run pruning randomly (~5% of the time) to save CPU
    if (Math.random() < 0.05) {
      db.prepare(`DELETE FROM token_states WHERE updated_at < ?`).run(now - 86400000);
    }
  } catch (e) {
    console.error(`[StateMemory] Error saving state for ${mint}:`, e.message);
  }
}

export function detectStateTransition(currentState, prevState) {
  if (!prevState) return { signal: "NO_STATE_CHANGE", lads_score: 0 };
  const elapsedMs = Date.now() - Number(prevState._observedAt || 0);
  const minElapsedMs = Number(setting('state_transition_min_elapsed_ms', '60000'));
  const maxElapsedMs = Number(setting('state_transition_max_elapsed_ms', '3600000'));
  if (!Number.isFinite(elapsedMs) || elapsedMs < minElapsedMs || elapsedMs > maxElapsedMs) {
    return { signal: "NO_STATE_CHANGE", lads_score: 0, ignored: true, elapsedMs };
  }

  const delta = {
    liquidity: currentState.liquidity - prevState.liquidity,
    volume: currentState.volume - prevState.volume,
    net_buy: currentState.net_buy - prevState.net_buy,
    price: currentState.price - prevState.price
  };

  // Helper normalization function (Sigmoid/Bound 0 - 100)
  const norm = (val, maxVal) => {
    if (!val || val <= 0) return 0;
    return Math.min(100, (val / maxVal) * 100);
  };

  // Normalized inputs (0 - 100)
  const normDemand = norm(delta.net_buy > 0 ? delta.net_buy : 0, 100); // 100 net buyers max
  const normLiquidity = norm(delta.liquidity > 0 ? delta.liquidity : 0, 10000); // $10,000 liq growth max
  const normRunnerHistory = Math.min(100, Number(currentState.ath_multiple ?? (currentState.liquidity > 15000 ? 2.5 : 1.0)) * 20); // ATH multiple normalized
  const normSmartWallet = norm(currentState.wallet_quality || 0, 5); // 5 smart degens max
  const normPriceResponse = (prevState.price > 0) ? Math.min(100, Math.abs(delta.price / prevState.price) * 100) : 0;

  // Absorption Score Formula (Exact 0-100 weighted sum)
  const lads_score = (
    (normDemand * 0.30) +
    (normLiquidity * 0.20) +
    (normRunnerHistory * 0.15) +
    (normSmartWallet * 0.20) -
    (normPriceResponse * 0.15)
  );

  const regime = String(setting('current_macro_state', 'UNKNOWN') || 'UNKNOWN').toUpperCase();

  // Baseline Thresholds
  let thresholdBuy = 50; 
  let thresholdVolume = 1000;
  let priceResponseLimit = Math.max(0.000000001, currentState.price * 0.15); 
  let thresholdSell = 50;

  // Regime Detection: Adjust thresholds based on macro weather
  if (regime.includes('BULL') || regime.includes('HOT') || regime.includes('RISK_ON')) {
    thresholdBuy = 100;
    thresholdVolume = 2500;
    priceResponseLimit = Math.max(0.000000001, currentState.price * 0.25);
  } else if (regime.includes('BEAR') || regime.includes('COLD') || regime.includes('RISK_OFF')) {
    thresholdBuy = 25;
    thresholdVolume = 500;
    priceResponseLimit = Math.max(0.000000001, currentState.price * 0.05);
  } else if (regime.includes('CHOP') || regime.includes('SIDEWAYS')) {
    priceResponseLimit = Math.max(0.000000001, currentState.price * 0.10);
  }

  let signal = "NO_STATE_CHANGE";
  
  if (
    delta.net_buy > thresholdBuy &&
    delta.volume > thresholdVolume &&
    delta.liquidity >= 0 &&
    Math.abs(delta.price) < priceResponseLimit
  ) {
    signal = "ABSORPTION"; 
  } else if (
    delta.net_buy < -thresholdSell &&
    delta.liquidity < 0
  ) {
    signal = "DISTRIBUTION"; 
  }

  return { signal, lads_score };
}
