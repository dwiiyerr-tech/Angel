import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS parameter_mutation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      param_key TEXT NOT NULL,
      strategy TEXT,
      old_value TEXT,
      new_value TEXT,
      lesson_id INTEGER,
      applied_at_ms INTEGER NOT NULL,
      rolled_back INTEGER DEFAULT 0,
      rollback_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      status TEXT NOT NULL,
      position_id INTEGER,
      intent_id INTEGER,
      input_amount TEXT,
      output_amount TEXT,
      signature TEXT,
      error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_config_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      approved_at_ms INTEGER,
      checksum TEXT NOT NULL,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narrative_signals (
      mint TEXT PRIMARY KEY,
      ticker TEXT,
      tweet_velocity_5m INTEGER DEFAULT 0,
      narrative_theme TEXT,
      organic_score INTEGER DEFAULT 0,
      is_authentic INTEGER DEFAULT 0,
      stage TEXT DEFAULT 'BIRTH',
      updated_at_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS market_snapshots (
      mint TEXT PRIMARY KEY,
      observed_at_ms INTEGER NOT NULL,
      volume_5m REAL,
      buys_5m REAL,
      sells_5m REAL,
      net_buyers_5m REAL,
      price_usd REAL,
      liquidity_usd REAL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_candidates_created_at_ms ON candidates(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_mint_status ON dry_run_positions(mint, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_one_active_mint
      ON dry_run_positions(mint)
      WHERE status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown');
    CREATE INDEX IF NOT EXISTS idx_positions_candidate_id ON dry_run_positions(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_llm_decisions_candidate_id ON llm_decisions(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_intents_one_pending_buy
      ON trade_intents(mint)
      WHERE side = 'buy' AND status IN ('pending_confirmation', 'executing', 'outcome_unknown');
    CREATE INDEX IF NOT EXISTS idx_execution_operations_status ON execution_operations(status, updated_at_ms);
    CREATE INDEX IF NOT EXISTS idx_live_config_snapshots_status ON live_config_snapshots(status, approved_at_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_operations_active_mint_side
      ON execution_operations(mint, side)
      WHERE status IN ('pending', 'outcome_unknown');
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_observed ON market_snapshots(observed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
    CREATE TABLE IF NOT EXISTS decision_cache (
      mint TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      route TEXT,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      mcap_snapshot REAL,
      holders_snapshot INTEGER,
      liq_snapshot REAL
    );
  `);
  const activeStrategies = db.prepare('SELECT id FROM strategies WHERE enabled = 1 ORDER BY rowid').all();
  if (activeStrategies.length > 1) {
    const keepId = activeStrategies[0].id;
    db.prepare('UPDATE strategies SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END').run(keepId);
    console.warn(`[db] normalized multiple active strategies; preserved ${keepId}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_strategies_single_active ON strategies(enabled) WHERE enabled = 1');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_position_delete_trades
    AFTER DELETE ON dry_run_positions BEGIN
      DELETE FROM dry_run_trades WHERE position_id = OLD.id;
      DELETE FROM tp_sl_rules WHERE position_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_trade_requires_position
    BEFORE INSERT ON dry_run_trades
    WHEN NOT EXISTS (SELECT 1 FROM dry_run_positions WHERE id = NEW.position_id)
    BEGIN SELECT RAISE(ABORT, 'dry_run_trade requires position'); END;
    CREATE TRIGGER IF NOT EXISTS trg_rule_requires_position
    BEFORE INSERT ON tp_sl_rules
    WHEN NOT EXISTS (SELECT 1 FROM dry_run_positions WHERE id = NEW.position_id)
    BEGIN SELECT RAISE(ABORT, 'tp_sl_rule requires position'); END;
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'entry_fee_sol', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'exit_fee_sol', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'realized_fee_sol', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'partial_tp_retry_after_ms', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'realized_pnl_sol', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'realized_cost_sol', 'REAL DEFAULT 0');
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');
  ensureColumn('strategy_evolution', 'config_json', 'TEXT');
  ensureColumn('strategy_evolution', 'created_at', 'INTEGER');
  ensureColumn('strategy_evolution', 'reason', 'TEXT');
  ensureColumn('evolution_cycles', 'error_msg', 'TEXT');
  ensureColumn('trade_dna', 'token_address', 'TEXT');
  ensureColumn('parameter_mutation_history', 'rollback_checked_at_ms', 'INTEGER');
  ensureColumn('learning_lessons', 'approved_at_ms', 'INTEGER');
  ensureColumn('learning_lessons', 'scope', "TEXT DEFAULT 'global'");
  ensureColumn('learning_lessons', 'instruction', 'TEXT');
  ensureColumn('learning_lessons', 'confidence', "TEXT DEFAULT 'low'");
  ensureColumn('learning_lessons', 'expires_at_ms', 'INTEGER');
  ensureColumn('llm_decisions', 'learning_lesson_ids_json', "TEXT DEFAULT '[]'");
  ensureColumn('llm_batches', 'learning_lesson_ids_json', "TEXT DEFAULT '[]'");
  // Lessons created before the human-approval workflow must never silently
  // become trusted LLM behavior guidance.
  db.prepare("UPDATE learning_lessons SET status = 'archived' WHERE status = 'active' AND approved_at_ms IS NULL").run();

  const defaults = {
    agent_enabled: 'true',
    live_circuit_breaker_open: 'false',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(2 * 60 * 1000),
    llm_min_confidence: '20',
    sideways_timeout_minutes: '10',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    min_executable_position_sol: process.env.MIN_EXECUTABLE_POSITION_SOL || '0.001',
    min_opportunity_size_multiplier: process.env.MIN_OPPORTUNITY_SIZE_MULTIPLIER || '0.35',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    min_risk_reward_ratio: process.env.MIN_RISK_REWARD_RATIO || '1.5',
    loss_streak_size_cut_after: process.env.LOSS_STREAK_SIZE_CUT_AFTER || '2',
    loss_streak_size_multiplier: process.env.LOSS_STREAK_SIZE_MULTIPLIER || '0.5',
    loss_streak_pause_after: process.env.LOSS_STREAK_PAUSE_AFTER || '3',
    loss_streak_pause_ms: process.env.LOSS_STREAK_PAUSE_MS || String(30 * 60 * 1000),
    market_allocator_mode: 'green',
    market_allocator_size_multiplier: '1',
    market_allocator_pending_mode: '',
    market_allocator_pending_count: '0',
    market_allocator_changed_at_ms: '0',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    default_partial_tp_enabled: '1',
    default_partial_tp_at_percent: '20',
    default_partial_tp_sell_percent: '25',
    tp1_r_multiple: process.env.TP1_R_MULTIPLE || '1',
    risk_per_trade_sol: process.env.RISK_PER_TRADE_SOL || '0.02',
    second_wave_max_hold_ms: process.env.SECOND_WAVE_MAX_HOLD_MS || String(90 * 60 * 1000),
    second_wave_sideways_timeout_minutes: process.env.SECOND_WAVE_SIDEWAYS_TIMEOUT_MINUTES || '30',
    second_wave_time_tighten_enabled: process.env.SECOND_WAVE_TIME_TIGHTEN_ENABLED || 'true',
    min_second_wave_score: process.env.MIN_SECOND_WAVE_SCORE || '8',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: process.env.MIN_MCAP_USD || '0',
    min_holders: process.env.MIN_HOLDERS || '168',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    filter_max_bot_holders_pct: '25',
    filter_extreme_bot_holders_pct: '70',
    filter_extreme_dev_migrations: '100',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    fresh_gmgn_budget_ms: process.env.FRESH_GMGN_BUDGET_MS || '1200',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);
  db.prepare("DELETE FROM settings WHERE key = 'learning_auto_apply_enabled'").run();

  // Seed default strategies
  const stratInsert = db.prepare('INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();

  stratInsert.run('sniper', 'Sniper', 1, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 0,
    min_mcap_usd: 0,
    max_mcap_usd: 500000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 168,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 1,
    trending_max_bundler_rate: 1,
    position_size_sol: 0.08,
    max_open_positions: 2,
    tp_percent: 25,
    sl_percent: -15,
    use_dynamic_sl: true,
    atr_sl_multiplier: 2.5,
    trailing_enabled: true,
    trailing_percent: 10,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 1800000,
    use_llm: true,
    llm_min_confidence: 20,
    momentum_threshold: 0.5,
    prescore_hard_floor: 35,
    prescore_veto_floor: -50,
    momentum_veto_floor: 0.1,
  }), ts);

  stratInsert.run('dip_buy', 'Dip Buy', 0, JSON.stringify({
    entry_mode: 'wait_for_dip',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 0,
    max_mcap_usd: 500000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 168,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: -40,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.05,
    max_open_positions: 3,
    tp_percent: 30,
    sl_percent: -20,
    use_dynamic_sl: true,
    atr_sl_multiplier: 2.5,
    trailing_enabled: true,
    trailing_percent: 15,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 1800000,
    use_llm: true,
    llm_min_confidence: 60,
  }), ts);

  stratInsert.run('smart_money', 'Smart Money', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 0,
    max_mcap_usd: 1000000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 168,
    max_top20_holder_percent: 50,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 100,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 100,
    sl_percent: -25,
    use_dynamic_sl: true,
    atr_sl_multiplier: 2.5,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 100,
    partial_tp_sell_percent: 50,
    max_hold_ms: 1800000,
    use_llm: true,
    llm_min_confidence: 70,
  }), ts);

  stratInsert.run('degen', 'Degen', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_mcap_usd: 0,
    max_mcap_usd: 100000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 168,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.5,
    trending_max_bundler_rate: 0.7,
    position_size_sol: 0.05,
    max_open_positions: 5,
    tp_percent: 30,
    sl_percent: -15,
    use_dynamic_sl: true,
    atr_sl_multiplier: 2.5,
    trailing_enabled: true,
    trailing_percent: 10,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 1800000,
    use_llm: false,
    llm_min_confidence: 0,
  }), ts);
}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  // Some optional subsystems have been removed. Their legacy migration calls
  // must not make initialization of a fresh database fail.
  if (columns.length === 0) return;
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
