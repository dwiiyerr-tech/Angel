import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './connection.js';

export const LIVE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const LIVE_SETTING_KEYS = new Set([
  'agent_enabled', 'atr_period', 'atr_sl_ceiling_percent', 'atr_sl_floor_percent',
  'atr_sl_max_atr_percent', 'atr_sl_min_atr_percent', 'atr_sl_multiplier',
  'blocked_routes', 'break_even_threshold_percent',
  'default_partial_tp_at_percent', 'default_partial_tp_enabled', 'default_partial_tp_sell_percent',
  'default_sl_percent', 'default_tp_percent', 'default_trailing_enabled',
  'default_trailing_percent', 'dry_run_buy_sol', 'llm_min_confidence',
  'tp1_r_multiple',
  'risk_per_trade_sol',
  'dual_llm_consensus', 'enable_regime_awareness', 'exit_quote_enabled',
  'filter_max_bot_holders_pct', 'flow_hard_net_buyer_ratio', 'flow_hard_price_change_pct',
  'llm_candidate_max_age_ms', 'llm_candidate_pick_count', 'llm_low_confidence_cap',
  'loss_streak_pause_after', 'loss_streak_pause_ms', 'loss_streak_size_cut_after', 'loss_streak_size_multiplier',
  'live_circuit_breaker_open',
  'max_entry_sl_percent', 'min_entry_tp_percent',
  'max_mcap_usd', 'max_open_positions', 'min_fee_claim_sol', 'min_holders',
  'min_executable_position_sol', 'min_opportunity_size_multiplier', 'min_risk_reward_ratio',
  'min_liquidity_usd', 'min_mcap_usd', 'needle_weights_json', 'sideways_timeout_minutes',
  'smart_money_enabled', 'time_tighten_enabled', 'trailing_arm_percent',
  'trailing_floor_percent', 'trailing_tight_from_percent', 'trailing_tight_percent',
  'trending_allow_degen', 'trending_enabled', 'trending_max_bot_degen_rate',
  'trending_max_bundler_rate', 'trending_max_mcap_usd', 'trending_max_rug_ratio',
  'trending_max_top10_rate', 'trending_min_holders', 'trending_min_mcap_usd',
  'trending_min_swaps', 'trending_min_volume_usd', 'use_dynamic_sl', 'win_block_days',
]);

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}

function canonical(value) {
  return JSON.stringify(sortObject(value));
}

function hashFiles(paths) {
  const hash = createHash('sha256');
  for (const filename of paths.sort()) {
    hash.update(path.relative(process.cwd(), filename));
    hash.update(fs.readFileSync(filename));
  }
  return hash.digest('hex');
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(filename) : [filename];
  });
}

export function runtimeFingerprint() {
  const codeFiles = [
    ...filesUnder(path.resolve('src')).filter(file => file.endsWith('.js') || file.endsWith('.py')),
    ...['index.js', 'package-lock.json'].map(file => path.resolve(file)).filter(file => fs.existsSync(file)),
  ];
  const modelFiles = ['momentum_model.pkl', 'momentum_scaler.pkl', 'momentum_features.json']
    .map(file => path.resolve('models', file)).filter(file => fs.existsSync(file));
  const environment = {
    solana_rpc_url: process.env.SOLANA_RPC_URL || '',
    jupiter_swap_base_url: process.env.JUPITER_SWAP_BASE_URL || '',
    jupiter_slippage_bps: process.env.JUPITER_SLIPPAGE_BPS || '300',
    min_risk_reward_ratio: process.env.MIN_RISK_REWARD_RATIO || '1.5',
    jito_enabled: process.env.JITO_ENABLED || 'false',
    jito_block_engine_url: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf',
    llm_model: process.env.LLM_MODEL || 'MiniMax-M2.7',
    ml_service_port: process.env.ML_SERVICE_PORT || '8001',
    live_max_position_sol: process.env.LIVE_MAX_POSITION_SOL || '0.1',
    live_max_wallet_fraction: process.env.LIVE_MAX_WALLET_FRACTION || '0.1',
    live_max_open_positions: process.env.LIVE_MAX_OPEN_POSITIONS || '2',
    live_max_total_exposure_sol: process.env.LIVE_MAX_TOTAL_EXPOSURE_SOL || '0.2',
    live_max_daily_entries: process.env.LIVE_MAX_DAILY_ENTRIES || '5',
    live_max_daily_loss_sol: process.env.LIVE_MAX_DAILY_LOSS_SOL || '0.1',
    wallet_identity_sha256: createHash('sha256').update(process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || '').digest('hex'),
    jupiter_api_identity_sha256: createHash('sha256').update(process.env.JUPITER_API_KEY || '').digest('hex'),
    helius_api_identity_sha256: createHash('sha256').update(process.env.HELIUS_API_KEY || '').digest('hex'),
  };
  return {
    code_sha256: hashFiles(codeFiles),
    model_sha256: hashFiles(modelFiles),
    environment_sha256: createHash('sha256').update(canonical(environment)).digest('hex'),
  };
}

export function currentLiveConfig() {
  const settings = Object.fromEntries(db.prepare(`
    SELECT key, value FROM settings
    WHERE key IN (${[...LIVE_SETTING_KEYS].map(() => '?').join(',')})
    ORDER BY key
  `).all(...LIVE_SETTING_KEYS).map(row => [row.key, row.value]));
  const strategy = db.prepare('SELECT id, config_json FROM strategies WHERE enabled = 1 LIMIT 1').get();
  const approvedLessons = db.prepare(`
    SELECT id, approved_at_ms, lesson FROM learning_lessons
    WHERE status = 'active' AND approved_at_ms IS NOT NULL AND approved_at_ms >= ?
    ORDER BY id
  `).all(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return {
    settings,
    strategy: strategy ? { id: strategy.id, config: JSON.parse(strategy.config_json) } : null,
    approvedLessons,
    runtime: runtimeFingerprint(),
  };
}

export function liveConfigChecksum(config = currentLiveConfig()) {
  return createHash('sha256').update(canonical(config)).digest('hex');
}

export function createLiveConfigSnapshot() {
  const config = currentLiveConfig();
  const checksum = liveConfigChecksum(config);
  const result = db.prepare(`
    INSERT INTO live_config_snapshots (created_at_ms, checksum, config_json, status)
    VALUES (?, ?, ?, 'pending')
  `).run(Date.now(), checksum, canonical(config));
  return { id: Number(result.lastInsertRowid), checksum, config };
}

export function approveLiveConfigSnapshot(id, checksum) {
  const row = db.prepare('SELECT * FROM live_config_snapshots WHERE id = ? AND status = ?').get(id, 'pending');
  if (!row) throw new Error('Pending live snapshot not found');
  if (row.checksum !== String(checksum || '').trim().toLowerCase()) throw new Error('Snapshot checksum mismatch');
  if (row.checksum !== liveConfigChecksum()) throw new Error('Configuration changed after snapshot creation');
  db.prepare("UPDATE live_config_snapshots SET status = 'approved', approved_at_ms = ? WHERE id = ?").run(Date.now(), id);
  return { id: row.id, checksum: row.checksum };
}

export function approvedLiveConfig() {
  const checksum = liveConfigChecksum();
  return db.prepare(`
    SELECT id, checksum, approved_at_ms FROM live_config_snapshots
    WHERE status = 'approved' AND checksum = ? AND approved_at_ms >= ?
    ORDER BY approved_at_ms DESC LIMIT 1
  `).get(checksum, Date.now() - LIVE_APPROVAL_TTL_MS) || null;
}

export function assertLiveConfigApproved() {
  const breaker = db.prepare("SELECT value FROM settings WHERE key = 'live_circuit_breaker_open'").get()?.value;
  if (breaker === 'true' || breaker === '1') throw new Error('Live entry blocked: circuit breaker is latched.');
  const unresolved = db.prepare("SELECT COUNT(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get().count;
  if (Number(unresolved) > 0) {
    throw new Error(`Live entry blocked: ${unresolved} execution outcome(s) require reconciliation.`);
  }
  const approved = approvedLiveConfig();
  if (!approved) throw new Error('Live mode requires an approved configuration snapshot. Use /liveapprove create first.');
  return approved;
}

export function ensureSafeStartupMode() {
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
  if (mode !== 'live') return { mode, downgraded: false };
  const unresolved = db.prepare("SELECT COUNT(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get().count;
  if (Number(unresolved) > 0) {
    db.prepare("UPDATE settings SET value = 'confirm' WHERE key = 'trading_mode'").run();
    const error = `${unresolved} unresolved execution outcome(s) require reconciliation`;
    console.error(`[live-safety] live startup paused to confirm: ${error}`);
    return { mode: 'confirm', downgraded: true, error };
  }
  try {
    return { mode, downgraded: false, snapshot: assertLiveConfigApproved() };
  } catch (error) {
    db.prepare("UPDATE settings SET value = 'dry_run' WHERE key = 'trading_mode'").run();
    console.error(`[live-safety] unapproved live configuration downgraded to dry_run: ${error.message}`);
    return { mode: 'dry_run', downgraded: true, error: error.message };
  }
}
