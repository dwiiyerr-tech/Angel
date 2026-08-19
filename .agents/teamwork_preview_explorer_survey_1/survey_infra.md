# Codebase Infrastructure & Structure Survey Report

**Project**: `Kaiser.charon` (Solana memecoin Telegram trading bot)  
**Surveyed Directory**: `/root/Kaiser.charon`  
**Date**: 2026-08-08  
**Explorer**: Explorer 1 (Codebase Structure & Infra Explorer)

---

## 1. Repository Directory Structure & Module Layout

`Kaiser.charon` is an automated Telegram trading bot targeting Solana `pump.fun` tokens. It monitors live token signals, enriches candidate metrics, filters tokens using multi-tiered strategy rules and a Python-based ML momentum model, optionally invokes an LLM for final entry decisions, and executes buys/sells via the Jupiter swap API.

### Directory Layout

```
/root/Kaiser.charon/
├── index.js                  # CLI / daemon entry point (initializes DB connection, loads config, boots Telegram bot & app orchestrator)
├── package.json              # Node.js module manifest (dependencies, scripts)
├── package-lock.json         # Dependency lockfile
├── .env / .env.example       # Environment configuration template & active environment file
├── charon.sqlite*            # SQLite database files (charon.sqlite, charon.sqlite-wal, charon.sqlite-shm)
│
├── migrations/               # SQL schema migrations
│   └── 001_decision_cache.sql # Initial schema migration for LLM decision caching
│
├── models/                   # Bundled ML model artifacts for momentum prediction
│   ├── momentum_features.json # Feature column definitions
│   ├── momentum_model.pkl    # Pre-trained ML classifier model
│   └── momentum_scaler.pkl   # Feature standard scaler
│
├── src/                      # Core Node.js ES Module codebase
│   ├── app.js                # Main application lifecycle manager and signals loop startup
│   ├── config.js             # Environment variable and SQLite dynamic settings loader
│   ├── format.js             # Formatter helpers for numbers, currency, and percentages
│   ├── liveExecutor.js       # Live Solana trade execution engine via Jupiter API
│   ├── utils.js              # General project utility functions
│   │
│   ├── db/                   # Database interface layer (better-sqlite3)
│   │   ├── candidates.js     # Token candidate persistence
│   │   ├── connection.js     # SQLite connection manager and schema initialization
│   │   ├── decisions.js      # LLM decisions and cache table handlers
│   │   ├── intents.js        # Trade intents tracking
│   │   ├── positions.js      # Positions tracking (dry_run & live position lifecycle)
│   │   └── settings.js       # Dynamic strategy parameters hot-reloaded from SQLite
│   │
│   ├── enrichment/           # Token data enrichment clients
│   │   ├── gmgn.js           # GMGN API client (Ed25519-signed requests for holder/fee data)
│   │   ├── jupiter.js        # Jupiter API client (prices, asset info, spot quotes)
│   │   ├── rugcheck.js       # RugCheck security audit client
│   │   ├── twitter.js        # Twitter search & narrative virality tracker
│   │   └── wallets.js        # Wallet holder analysis
│   │
│   ├── evolution/            # Strategy auto-tuning and evolutionary optimization engine
│   │   ├── arena.js          # Strategy backtest comparison arena
│   │   ├── loop.js           # Evolutionary loop manager
│   │   ├── migrationEvo.js   # Migration event strategy evolution
│   │   ├── optimizer.js      # Parameter optimizer
│   │   ├── regimeDetector.js # Market regime detector (bull/bear/sideways)
│   │   ├── strategyFactory.js # Strategy generator/mutator
│   │   └── tradeDna.js       # Strategy parameter DNA encoders
│   │
│   ├── execution/            # Position tracking & trade routing engine
│   │   ├── positions.js      # Position monitoring, TP/SL checks, trailing TP guard
│   │   └── router.js         # Trade routing dispatcher
│   │
│   ├── learning/             # Self-learning feedback system
│   │   ├── autoApply.js      # Auto-apply parameter updates
│   │   ├── commands.js       # Learning CLI commands
│   │   ├── lessons.js        # Trade lesson extraction
│   │   ├── report.js         # Learning metrics report generator
│   │   └── summary.js        # Learning summary aggregator
│   │
│   ├── pipeline/             # Candidate screening & evaluation pipeline
│   │   ├── candidateBuilder.js  # Assembles enriched candidate data
│   │   ├── llm.js             # LLM entry decision engine with caching
│   │   ├── momentumFilter.js  # Node.js bridge to Python ML momentum scoring daemon
│   │   ├── orchestrator.js    # Pipeline coordinator (flow filter -> preScorer -> momentum -> LLM)
│   │   ├── preScorer.js       # Rule-based strategy filters (FLOW filter, bot thresholds, etc.)
│   │   └── predict_momentum.py# Python script for ML momentum model inference
│   │
│   ├── signals/              # Real-time market signal listeners and web sockets
│   │   ├── axiomSource.js     # Axiom signal source integration
│   │   ├── feeClaim.js        # Fee claim event tracker
│   │   ├── gmgnSignal.js      # GMGN trending/top signals
│   │   ├── graduated.js       # Graduated tokens scanner
│   │   ├── macroEngine.js     # Macro market engine
│   │   ├── narrativeTracker.js# Narrative trends tracker
│   │   ├── priceMonitor.js    # Real-time token price polling/monitoring
│   │   ├── pumpfunPregrad.js  # Pump.fun pre-graduation bonding curve scanner
│   │   ├── pumpportal.js      # PumpPortal WebSocket real-time token stream
│   │   ├── serverClient.js    # Signal server client
│   │   ├── smartMoney.js      # Smart money wallet transaction listener
│   │   ├── trenches.js        # Pump.fun trenches scanner
│   │   └── trending.js        # Trending tokens scanner
│   │
│   ├── telegram/             # Telegram Bot UI & Command Handlers
│   │   ├── bot.js             # Node-telegram-bot-api setup
│   │   ├── callbacks.js       # Interactive inline button callback handlers
│   │   ├── commands.js        # Telegram commands (/start, /status, /menu, /pnl, etc.)
│   │   ├── dailyReport.js     # Telegram daily report sender
│   │   ├── format.js          # Telegram message formatter
│   │   ├── input.js           # Telegram user input handlers
│   │   ├── menus.js           # Telegram inline keyboard UI menus
│   │   ├── report.js          # Trade summary reports
│   │   └── send.js            # Telegram message sender & canvas card dispatcher
│   │
│   └── visuals/              # Canvas PNG Rendering Engine for Telegram Cards
│       ├── dailyCard.js       # Daily summary card generator
│       ├── entryCard.js       # Trade entry card generator
│       └── exitCard.js        # Trade exit PNG card generator
│
├── scripts/                  # Standalone CLI tools and backtest scripts
│   ├── auto_learn.mjs
│   ├── capture_learning_data.py
│   ├── capture_learning_data.sh
│   ├── comprehensive_edge_backtest.py  # Backtest script (contains hardcoded path issue)
│   ├── daily_autotuner.js
│   ├── dashboard.py           # Dashboard server script (contains hardcoded path issue)
│   ├── fill_reconstruct.py    # Fill reconstruction tool (contains hardcoded path issue)
│   ├── full-enrichment-analysis.py  # Analysis tool (contains hardcoded path issue)
│   ├── general_filter_backtest.py   # Backtest tool (contains hardcoded path issue)
│   ├── health_check.sh        # Health check script (contains hardcoded path issue)
│   ├── metrics_server.py      # Prometheus metrics server (contains hardcoded path issue)
│   ├── monitor.mjs
│   ├── monitor.sh             # Monitoring wrapper (contains hardcoded path issue)
│   ├── per_route_backtest.py  # Backtest script (contains hardcoded path issue)
│   ├── test-spot-quote.mjs    # Test script for Jupiter spot quote vs asset API divergence
│   └── test_exit_card.mjs     # Test script for Canvas PNG card rendering
│
├── analyze_positions.py      # Position analytics script
├── underground_wallet_finder.py # Wallet scanner script
├── verify_backtest.py         # Backtest validation script (contains hardcoded path issue)
├── gemini_web2api.py          # Gemini Web2API reverse-proxy script
├── lint.cjs                   # Static AST linter check script
├── start.sh                   # Application boot script (contains hardcoded path issue)
├── test_custom.js             # Fallback LLM and PumpPortal integration test
├── test_llm.js                # Main LLM API integration test
├── test_migration_ws.js       # PumpPortal WebSocket migration stream test
└── test_server.js             # Signal server API connection test
```

---

## 2. Build System and Toolchain Details

### Tech Stack & Runtimes
- **Node.js**: Required `>= 20.0.0` (developed on v22). Source format is modern **ES Modules** (`"type": "module"` in `package.json`).
- **Python**: Python 3.11 with `numpy`, `scikit-learn`, `pandas`. Used for ML model inference (`src/pipeline/predict_momentum.py`) and backtesting scripts (`scripts/*.py`).
- **Database**: SQLite3 stored in `charon.sqlite` (managed via `better-sqlite3` native addon).

### Native Toolchain Dependencies
- **better-sqlite3** and **canvas** rely on native C/C++ compilation (`node-gyp`).
- Required system packages:
  - `build-essential`, `python3`, `pkg-config`
  - `libcairo2-dev`, `libpango1.0-dev`, `libjpeg-dev`, `libgif-dev`, `librsvg2-dev`

### Dependencies (`package.json`)
- `@solana/web3.js` (^1.98.4): Solana blockchain interactions & wallet keypair handling.
- `@babel/parser` & `@babel/traverse` (^8.0.4): JS AST parsing for custom linting (`lint.cjs`).
- `better-sqlite3` (^12.9.0): Synchronous high-performance SQLite database library.
- `canvas` (^3.2.3): Cairo-backed image rendering for Telegram trade cards.
- `axios` (^1.7.9): HTTP requests for Jupiter, GMGN, and LLM APIs.
- `bs58` (^6.0.0): Base58 decoding for Solana keys and signatures.
- `dotenv` (^16.4.7): Environment configuration loading.
- `node-telegram-bot-api` (^0.66.0): Telegram bot client API.
- `ws` (^8.18.0): WebSocket client for PumpPortal real-time token stream.

---

## 3. Build Status & Diagnostic Checks

### Syntax & Compilation Checks
1. **Node.js Syntax Check (`npm run check` + full repo check)**:
   - Command: `node --check index.js && node --check src/app.js && node --check src/config.js && node --check src/liveExecutor.js`
   - Result: **PASSED** (0 exit code).
   - Full repository check (all 72 `.js`, `.mjs`, `.cjs` files): **PASSED** (0 exit code).

2. **Python Syntax Check (`py_compile`)**:
   - Command: `python3 -c "import glob, py_compile; ..."`
   - Result: **PASSED** (all 13 `.py` files compiled without syntax errors).

3. **Standalone Test Scripts**:
   - `node scripts/test_exit_card.mjs`: **PASSED** (successfully rendered and verified 3 PNG cards: profit, loss, rug).
   - `node scripts/test-spot-quote.mjs`: **PASSED** (successfully fetched Jupiter spot quote and asset prices for token `GILF`, divergence 1.25% < 15% threshold).
   - `echo '{}' | python3 src/pipeline/predict_momentum.py`: **PASSED** (loaded `momentum_model.pkl` and `momentum_scaler.pkl` successfully and returned valid JSON score `{"momentum_score": 0.2309, ...}`).

4. **AST Linter Check (`node lint.cjs`)**:
   - Result: Flagged 1 minor undeclared global reference in `src/signals/macroEngine.js` (`fetch` at line 10).

---

## 4. Key Findings & Infra Issues

### Critical Infrastructure Finding: Hardcoded Environment Paths
A total of **11 script and shell files** contain hardcoded absolute directory paths pointing to `/home/ubuntu/projects/charon/...` or `/home/ubuntu/...` instead of dynamically detecting the project root or reading `DB_PATH` from `.env` / relative directory.

Affected Files:
1. `start.sh`: Line 2 contains `cd /home/ubuntu/projects/charon`
2. `verify_backtest.py`: Line 6 contains `DB_PATH = "/home/ubuntu/projects/charon/charon.sqlite"`
3. `scripts/comprehensive_edge_backtest.py`: Line 11 contains `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'`
4. `scripts/dashboard.py`: Hardcoded path to `/home/ubuntu/projects/charon/charon.sqlite`
5. `scripts/fill_reconstruct.py`: Hardcoded path to `/home/ubuntu/projects/charon/charon.sqlite`
6. `scripts/full-enrichment-analysis.py`: Hardcoded path to `/home/ubuntu/projects/charon/charon.sqlite`
7. `scripts/general_filter_backtest.py`: Hardcoded path to `/home/ubuntu/projects/charon/charon.sqlite`
8. `scripts/health_check.sh`: Hardcoded path to `/home/ubuntu/projects/charon`
9. `scripts/metrics_server.py`: Hardcoded path to `/home/ubuntu/projects/charon/charon.sqlite`
10. `scripts/monitor.sh`: Hardcoded path to `/home/ubuntu/projects/charon`
11. `scripts/per_route_backtest.py`: Hardcoded path to `/home/ubuntu/projects/charon/charon.sqlite`

Execution of these scripts in `/root/Kaiser.charon` currently fails with `sqlite3.OperationalError: unable to open database file` unless paths are updated or pointed to `.env`.

---

## 5. Application Initialization & Startup Flow

The application boot sequence follows this chain:

```
[index.js]
  │
  ├── 1. Load environment (.env via dotenv)
  ├── 2. Initialize DB Connection (src/db/connection.js)
  │      └── Run schema initializations & apply dynamic settings
  ├── 3. Load dynamic settings from SQLite (src/config.js)
  ├── 4. Initialize Telegram Bot UI (src/telegram/bot.js)
  │      └── Attach commands, inline callbacks, and menu handlers
  ├── 5. Boot App Engine Orchestrator (src/app.js)
  │      ├── Start active signal listeners (PumpPortal WS, Pumpfun pregrad, GMGN signals, Smart Money)
  │      ├── Launch candidate evaluation pipeline (src/pipeline/orchestrator.js)
  │      │     ├── preScorer (FLOW filter, bot thresholds, liquidity rules)
  │      │     ├── momentumFilter (Python ML daemon subprocess)
  │      │     └── llm (LLM entry decision with SQLite cache lookup)
  │      └── Launch position monitoring engine (src/execution/positions.js)
  │            ├── Monitor mark prices & Jupiter executable quotes
  │            ├── Apply Trailing TP guard, stop-loss (SL), max hold rules
  │            └── Dispatch Telegram notification cards (src/visuals/*) on exit
  └── 6. Launch Live Swap Executor if TRADING_MODE=live (src/liveExecutor.js)
```
