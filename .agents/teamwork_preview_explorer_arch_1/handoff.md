# Handoff Report — Explorer 1 (M-ARCH: Charon Architecture Inventory)

## 1. Observation

A comprehensive source code investigation of the Charon repository (`/root/Kaiser.charon/src` and `/root/Kaiser.charon/scripts`) was conducted. Below is the detailed inventory of all 9 major active component areas, including exact source files, primary responsibilities, configuration parameters, exported interfaces, and module dependencies.

---

### Component Inventory Matrix

| # | Subsystem / Component Area | Primary Source Files | Primary Responsibility | Key Configuration / Environment Params | Key Dependencies |
|---|---------------------------|----------------------|------------------------|----------------------------------------|------------------|
| **1** | **Signal Ingestion** | `src/signals/pumpportal.js`<br>`src/signals/gmgnSignal.js`<br>`src/signals/macroEngine.js`<br>`src/signals/serverClient.js`<br>`src/signals/axiomSource.js`<br>`src/signals/feeClaim.js`<br>`src/signals/graduated.js`<br>`src/signals/narrativeTracker.js`<br>`src/signals/priceMonitor.js`<br>`src/signals/pumpfunPregrad.js`<br>`src/signals/smartMoney.js`<br>`src/signals/trenches.js`<br>`src/signals/trending.js` | Real-time WebSocket and HTTP signal ingestion for new Solana token launches, bonding curve migrations, smart money signals, fee distributions, and central signal server polling. | `PUMPPORTAL_API_KEY`<br>`PUMPPORTAL_ENABLED`<br>`SIGNAL_SERVER_URL`<br>`SIGNAL_SERVER_KEY`<br>`SIGNAL_POLL_MS`<br>`gmgn_signal_enabled` | `ws`<br>`axios`<br>`src/enrichment/gmgn.js`<br>`src/telegram/send.js`<br>`src/db/settings.js` |
| **2** | **Signal Filters & Candidate Builder** | `src/pipeline/orchestrator.js`<br>`src/pipeline/candidateBuilder.js`<br>`src/pipeline/preScorer.js`<br>`src/pipeline/momentumFilter.js`<br>`src/pipeline/stateTransition.js`<br>`src/pipeline/predict_momentum.py` | Signal deduplication (10-min candidate dedup, 2h/4h position dedup), candidate snapshot building, hard filtering, v45 soft scoring, pre-scoring, Python ML momentum inference via stdin/stdout subprocess, and candidate status transition. | `min_liquidity_usd`<br>`trending_min_swaps`<br>`trending_max_rug_ratio`<br>`trending_max_bundler_rate`<br>`token_age_max_ms`<br>`max_open_positions` | `predict_momentum.py`<br>`models/momentum_model.pkl`<br>`models/momentum_scaler.pkl`<br>`models/momentum_features.json`<br>`src/enrichment/`<br>`src/db/` |
| **3** | **Dynamic Enrichment** | `src/enrichment/gmgn.js`<br>`src/enrichment/jupiter.js`<br>`src/enrichment/rugcheck.js`<br>`src/enrichment/twitter.js`<br>`src/enrichment/wallets.js` | Parallel token metadata, market cap, liquidity, holder distribution, token security audits (bot holders %, top 10 %, dev migrations), chart candle context, wallet cluster exposure, and Twitter narrative enrichment with TTL caching and rate-limit backoffs. | `GMGN_API_KEY`<br>`GMGN_CACHE_TTL_MS`<br>`GMGN_ENABLED`<br>`gmgn_request_delay_ms`<br>`gmgn_max_retries` | `axios`<br>`node:crypto`<br>`src/utils.js`<br>`src/db/settings.js` |
| **4** | **Regime & Macro Engines** | `src/signals/macroEngine.js`<br>`src/evolution/regimeDetector.js`<br>`src/evolution/arena.js`<br>`src/evolution/loop.js`<br>`src/evolution/migrationEvo.js`<br>`src/evolution/optimizer.js`<br>`src/evolution/strategyFactory.js`<br>`src/evolution/tradeDna.js` | Sol price trend tracking (Binance API), global win-rate classification ('HOT' vs 'COLD' market weather), 24h market cap band analysis ('0-25k', '25k-50k', '50k-100k', '100k+'), dynamic strategy parameter tuning, and genetic trade DNA evolution. | 24h & 6h rolling windows, market cap band thresholds, SOL/USDT Binance price feed | `better-sqlite3`<br>`src/db/connection.js`<br>`src/db/settings.js` |
| **5** | **LLM Integration** | `src/pipeline/llm.js`<br>`src/pipeline/predict_momentum.py` | Formats candidate batches into compact JSON prompts, injects regime memory & macro weather, routes queries to route-specific models, executes multi-provider fallback hierarchy (Primary -> Zyloo -> OpenRouter) and dual LLM consensus, and normalizes decision output (`BUY`, `WATCH`, `PASS`, confidence, risk list, suggested TP/SL). | `ENABLE_LLM`<br>`LLM_API_KEY`<br>`LLM_BASE_URL`<br>`LLM_MODEL`<br>`LLM_MODEL_CHEAP`<br>`LLM_FALLBACK_BASE_URL`<br>`LLM_FALLBACK_API_KEY`<br>`LLM_FALLBACK_MODEL`<br>`LLM_OPENROUTER_API_KEY`<br>`LLM_OPENROUTER_MODEL`<br>`LLM_TIMEOUT_MS`<br>`llm_min_confidence` | `axios`<br>`src/db/decisions.js`<br>`src/signals/trending.js`<br>`src/db/settings.js` |
| **6** | **Auto-Learn & AutoApply Engine** | `src/learning/autoApply.js`<br>`src/learning/lessons.js`<br>`src/learning/summary.js`<br>`src/learning/report.js`<br>`src/learning/commands.js`<br>`scripts/auto_learn.mjs` | Automated trade history performance analysis, rule extraction from active lessons (<7 days recency), type validation & recency gating (30 closed position minimum), 24h idempotency enforcement per strategy/parameter, automatic mutation of `settings` and `strategies` SQL tables, and audit logging in `learning_applied`. | 30 closed position minimum, 7-day recency cutoff, 24h action cooldown, 0.7 minConfidence threshold | `better-sqlite3`<br>`src/db/connection.js`<br>`src/utils.js` |
| **7** | **Position Tracking & SQLite DB** | `src/db/positions.js`<br>`src/db/connection.js`<br>`src/db/candidates.js`<br>`src/db/decisions.js`<br>`src/db/intents.js`<br>`src/db/settings.js` | SQLite WAL database management (`charon.sqlite` across 19 tables/indexes), position state machine ('open', 'closed', 'pending'), pending position counter, risk-adjusted & source-weighted sizing, regime multipliers, 24h closed position re-entry dedup, 7-day past-win block guard, and atomic position limit checks (`openPositionCount()` + `canOpenMorePositions()`). | `DB_PATH`<br>`max_open_positions`<br>`dry_run_buy_sol`<br>Default strategies ('sniper', 'dip_buy', 'smart_money', 'degen') | `better-sqlite3`<br>`src/config.js`<br>`src/utils.js`<br>`src/pipeline/llm.js` |
| **8** | **Execution Router & Jupiter Executor** | `src/execution/router.js`<br>`src/liveExecutor.js`<br>`src/execution/positions.js` | Trade routing across `dry_run`, `confirm`, and `live` modes. SOL reserve checks (`LIVE_MIN_SOL_RESERVE_LAMPORTS`), retry loop (up to 3 attempts), Jupiter Ultra / Swap API ordering and VersionedTransaction signing via `@solana/web3.js`, slippage BPS application (`JUPITER_SLIPPAGE_BPS`), balance reconciliation on timeout, and `FAILED_ENTRY` position auditing. | `SOLANA_PRIVATE_KEY`<br>`SOLANA_RPC_URL`<br>`JUPITER_API_KEY`<br>`JUPITER_SWAP_BASE_URL`<br>`JUPITER_SLIPPAGE_BPS`<br>`LIVE_MIN_SOL_RESERVE_LAMPORTS` | `@solana/web3.js`<br>`bs58`<br>`axios`<br>`src/db/positions.js`<br>`src/db/intents.js`<br>`src/telegram/send.js` |
| **9** | **Telegram UI & Exit Card Renderer** | `src/telegram/bot.js`<br>`src/telegram/callbacks.js`<br>`src/telegram/commands.js`<br>`src/telegram/dailyReport.js`<br>`src/telegram/format.js`<br>`src/telegram/input.js`<br>`src/telegram/menus.js`<br>`src/telegram/report.js`<br>`src/telegram/send.js`<br>`src/visuals/exitCard.js`<br>`scripts/test_exit_card.mjs` | Operator notifications, command handling (`/start`, `/status`, `/positions`, `/settings`, `/report`, `/learning`), inline keyboard interactive menus (trade confirmation callbacks, parameter updates), HTML message formatting, and server-side PNG exit card rendering (800x420 canvas graphics for trade closure PNL visual cards). | `TELEGRAM_BOT_TOKEN`<br>`TELEGRAM_CHAT_ID` | `node-telegram-bot-api`<br>`canvas`<br>`src/db/settings.js`<br>`src/db/positions.js` |

---

### Component Deep-Dive Details

#### Area 1: Signal Ingestion
- **`src/signals/pumpportal.js`**: Connects via WebSocket (`wss://pumpportal.fun/api/data?api-key=...`). Subscribes to `subscribeNewToken` and `subscribeMigration`. Tracks up to 50 active bonding curve tokens. Checks bonding curve market cap via GMGN every 30s (`checkBondingCurve`). When market cap reaches $25,000 or a `migrate` WS event is received, triggers `graduateToken` which notifies the pipeline candidate handler (`candidateHandler`) with route `pumpportal_graduated`. Includes 5-min WebSocket silence & disconnect health monitors with automated Telegram alerts.
- **`src/signals/gmgnSignal.js`**: Polls `/v1/market/token_signal` (POST with `signal_type: [12]`). Maintains in-memory map `gmgnSignals` (5-min dedup window). Routes signals matching ending with `pump` to candidate handler with route `gmgn_smart_money`.
- **`src/signals/macroEngine.js`**: Fetches current SOL price from Binance API (`ticker/price?symbol=SOLUSDT`). Maintains 24h price history array. Queries `dry_run_positions` table for closed position win rate over last 6h. Computes market weather (`HOT` if win rate >= 50%, else `COLD`). Updates `current_macro_state` setting in SQLite DB every 5 minutes.
- **`src/signals/serverClient.js`**: Polls central Signal Server (`/api/signals?limit=100&minSources=2`) via HTTP GET. Updates global `graduated` and `trending` maps. Filters signals against active strategy constraints (`min_source_count`, `require_fee_claim`, `token_age_max_ms`). Routes signals (`fee_graduated_trending`, `fee_graduated`, `fee_trending`, `graduated_trending`, `multi_source`, `dual_source`, `single_source`) to `candidateHandler` or stores price alerts for `wait_for_dip` entry mode.

#### Area 2: Signal Filters & Candidate Builder
- **`src/pipeline/orchestrator.js`**: Entry point for candidate processing (`processCandidateFromSignals`). Enforces concurrent position caps (`canOpenMorePositions()`), candidate deduplication (10-min mint window across all routes, 2h open position check, 4h closed position cooldown, 24h same-symbol check, 2h LLM decision cache check). Calls `buildCandidate`, `filterCandidate`, `preScoreCandidate`, `momentumFilter`, and `decideCandidateBatch`. Passes approved buys to `handleApprovedBuy` which refreshes candidate state (`refreshCandidateForExecution`) and dispatches trade execution to `createDryRunPosition`, `createTradeIntent`, or `executeLiveBuy`.
- **`src/pipeline/candidateBuilder.js`**: Constructs candidate object from signal inputs. Calls dynamic enrichment modules in parallel (Stage 1: GMGN info, Jupiter asset, Jupiter holders, Jupiter chart context; Stage 2: Saved wallet exposure, Twitter narrative). Implements `filterCandidate` with hard filters (UTC worst-hours block 11-14, 20, 22; fee claim; mcap bounds; holder count; liquidity >= $5,000; flow filter 1h price change >= 0% & 5m net buyer ratio >= 0.2) and v45 soft scoring system (`computeSoftScore`, 0-150 scale with route-specific weights).
- **`src/pipeline/preScorer.js`**: Rule-based screening step prior to LLM invocation to save LLM tokens. Evaluates liquidity, holder distribution, and signal strength against dynamic thresholds.
- **`src/pipeline/momentumFilter.js`**: Spawns Python subprocess running `src/pipeline/predict_momentum.py`. Passes candidate JSON over stdin. Receives `momentum_score` (0.0-1.0) and top feature values on stdout. Rejects candidates where momentum score is less than strategy `momentum_threshold` (default 0.5).
- **`src/pipeline/predict_momentum.py`**: Python 3 script. Loads Scikit-Learn ML model (`models/momentum_model.pkl`), StandardScaler (`models/momentum_scaler.pkl`), and feature list (`models/momentum_features.json`). Extracts 35+ numerical features (price velocity 5m, price acceleration, buy/sell volume ratios, liquidity ratios, smart degen count, sniper count, top 10 holder rate, bot degen rate, bundler rate, rug ratio, ATH distance, Twitter engagement). Returns binary classification probability of candidate being a runner.

#### Area 3: Dynamic Enrichment
- **`src/enrichment/gmgn.js`**: API wrapper for `https://openapi.gmgn.ai`. Implements global request queue (`enqueueGmgn`), rate-limit pacing (`paceGmgnRequest` with `gmgn_request_delay_ms`, default 2500ms), automatic retry on 429 (`gmgn_max_retries`), and exponential backoff (`setGmgnBackoff`) handling 403, 429, and Cloudflare managed challenges. Maintains `gmgnCache` with TTL (`GMGN_CACHE_TTL_MS`).
- **`src/enrichment/jupiter.js`**: API wrapper for Jupiter Data API (`https://datapi.jup.ag`) and Price API (`https://lite-api.jup.ag`). `fetchJupiterAsset` searches token metadata, audit metrics (bot holders count & %, top 10 %, dev migrations, sniper/insider %), and stats (5m, 1h, 6h, 24h buys/sells/volume). `fetchJupiterHolders` computes top 20 holder concentration and max single holder %. `fetchJupiterChartContext` fetches 5m/1h/4h candle windows to compute ATH distance and range high risk. `fetchSolUsdPrice` fetches live SOL/USD spot price for token size estimation.
- **`src/enrichment/twitter.js`**: Fetches Twitter narrative metrics, viral tweet velocity, author followers, and engagement score for candidate tokens.
- **`src/enrichment/wallets.js`**: Cross-references candidate holder addresses against `saved_wallets` SQLite table to measure tracked smart wallet exposure.

#### Area 4: Regime & Macro Engines
- **`src/signals/macroEngine.js`**: Real-time market weather classifier. Periodically samples SOL price and 6h dry-run closed trade win rate. Stores formatted macro state string (e.g. `MACRO STATE: SOL is BULLISH at $154.20. Global meme win rate is 58.3%. Market weather is HOT.`) in `settings` table key `current_macro_state`. Injected directly into LLM system prompt.
- **`src/evolution/regimeDetector.js`**: Evaluates all closed trades from `dry_run_positions` over the preceding 24 hours. Groups trades into 4 market cap bands: `0-25k`, `25k-50k`, `50k-100k`, and `100k+`. Computes win rate and average PnL per band. Selects the optimal band with highest expected value. If best band WR >= 50% and avg PnL > 0, marks market as `HOT (Aggressive)` and sets position size to 0.1 SOL; otherwise `COLD (Safe)` with size 0.05 SOL. Dynamically updates `min_mcap_usd` and `max_mcap_usd` in the `sniper` strategy configuration in SQLite DB and writes summary to `current_regime_summary`.

#### Area 5: LLM Integration
- **`src/pipeline/llm.js`**: Batch decision engine. Compacts candidate objects using `compactCandidateForLlm` (stripping raw address arrays and keeping audit/metric summaries). Selects LLM endpoint and model based on route (`selectModelForRoute`: PumpPortal -> primary model; Signal Server -> cheap model). Assembles comprehensive system prompt containing CIO identity, regime memory, macro weather, soft score rules, route-specific guidelines (fresh grads, established, former runner-reclaim, buy the dip), universal R:R & M:M guidelines, and insider flow warning. Executes request with multi-provider fallback hierarchy: Primary (`LLM_BASE_URL`) -> Zyloo Fallback (`LLM_FALLBACK_BASE_URL`) -> OpenRouter Fallback (`https://openrouter.ai/api/v1`). Supports optional `dual_llm_consensus` requiring two independent model approvals. Normalizes verdict via `normalizeDecision`, enforcing `llm_min_confidence` threshold (downgrades low-confidence BUYs to WATCH) and blocking disabled routes (`blocked_routes`). Dynamically calculates position size multiplier based on confidence via `effectivePositionSizeSol`.

#### Area 6: Auto-Learn & AutoApply Engine
- **`src/learning/autoApply.js`**: Parameter tuning & lesson application engine. Checks total closed position count in DB (requires >= 30 closed trades to proceed). Queries `learning_lessons` for active lessons created in the last 7 days. Parses recommended parameter actions or natural language regex matches (`default_sl_percent`, `default_tp_percent`, `llm_min_confidence`, `min_liquidity_usd`, `max_mcap_usd`). Validates data types and checks 24h idempotency via `learning_applied` table to prevent duplicate parameter mutations. Mutates `settings` or `strategies` SQL tables and logs applied rule changes.

#### Area 7: Position Tracking & SQLite DB
- **`src/db/connection.js`**: Initializes SQLite database (`charon.sqlite`) using `better-sqlite3` with WAL journal mode (`journal_mode = WAL`). Creates 19 database tables and associated performance indexes (`settings`, `saved_wallets`, `candidates`, `alerts`, `llm_decisions`, `llm_batches`, `dry_run_positions`, `dry_run_trades`, `tp_sl_rules`, `trade_intents`, `decision_logs`, `signal_events`, `narrative_signals`, `learning_runs`, `learning_lessons`, `strategies`, `price_alerts`, `decision_cache`, `learning_applied`). Seeds default settings and 4 default strategy rows (`sniper`, `dip_buy`, `smart_money`, `degen`).
- **`src/db/positions.js`**: Core position state manager. Tracks open positions, pending position counter (`pendingPositionCount`, `incrementPendingPosition`, `decrementPendingPosition`), and total open count (`openPositionCount()`). Enforces max open position limits (`canOpenMorePositions()`). Implements `createDryRunPosition` and `createLivePosition` inside atomic DB transactions. Applies risk-adjusted sizing (50% reduction for risk severity >= 2), regime multiplier (0.25x to 1.5x based on 24h WR), and source-weight sizing (0.5x to 1.0x by route). Enforces re-entry deduplication (blocks tokens closed <24h ago; blocks tokens with a past win in last 7 days `WIN_BLOCK_DAYS`).

#### Area 8: Execution Router & Jupiter Executor
- **`src/liveExecutor.js`**: Solana wallet & Jupiter API executor. Parses private key (`SOLANA_PRIVATE_KEY` base58 or JSON array) and connects to Solana RPC via `@solana/web3.js`. Queries Jupiter Swap API (`/order` and `/execute`). Signs `VersionedTransaction` locally. Appends slippage settings (`JUPITER_SLIPPAGE_BPS`). Includes helper functions for fetching wallet SOL balance (`liveWalletBalanceLamports`) and SPL token balances (`fetchLiveTokenBalance`).
- **`src/execution/router.js`**: Handles trade execution based on system `trading_mode` (`dry_run`, `confirm`, `live`). `executeLiveBuy` checks SOL reserve (`LIVE_MIN_SOL_RESERVE_LAMPORTS`), executes up to 3 swap retries, falls back to RPC token balance check on missing output amounts, creates live position DB records, and logs `FAILED_ENTRY` positions if all retries fail. `executeConfirmedIntent` handles Telegram operator interactive buy approvals.

#### Area 9: Telegram UI & Card Renderer
- **`src/telegram/`**: Interactive operator interface built on `node-telegram-bot-api`. Sends automated notifications for new candidates, LLM batch reveals, position opens, trade intents, and error alerts (`send.js`). Responds to operator slash commands (`/start`, `/status`, `/positions`, `/settings`, `/report`, `/learning` in `commands.js`) and inline keyboard callback queries (`callbacks.js`).
- **`src/visuals/exitCard.js`**: Server-side image rendering engine using `canvas` (node-canvas). Generates 800x420 PNG exit cards showing position outcome (CLOSED badge, exit reason, token symbol, deposited SOL, PNL %, PNL SOL, hold duration, entry/exit mcap, strategy, trading mode, open/close timestamps, and Charon branding). Tested and verified by `scripts/test_exit_card.mjs`.

---

## 2. Logic Chain

1. **Signal Flow**:
   - External events enter Charon via 4 primary paths:
     - Real-time PumpPortal WebSocket (`src/signals/pumpportal.js`) -> `create` / `migrate` events.
     - GMGN token signal polling (`src/signals/gmgnSignal.js`) -> smart money signals.
     - Central Signal Server polling (`src/signals/serverClient.js`) -> multi-source aggregated signals.
     - Local cron/monitors (axiom, trenches, pumpfun pregrad, trending).
   - Signals trigger `candidateHandler` in `src/pipeline/orchestrator.js`.

2. **Deduplication & Screening Pipeline**:
   - `orchestrator.js` checks `canOpenMorePositions()`. If max open positions reached, candidate is dropped immediately before enrichment.
   - Deduplication guards check DB:
     - Open position check (mint has active open position -> drop).
     - Recent closed position check (closed <4h ago -> drop).
     - Recent candidate check (processed <10min ago -> drop).
     - Same symbol check (same ticker traded <24h ago -> drop).
     - Decision cache check (`checkDecisionCache` hit -> return cached verdict).
   - If clear, `buildCandidate()` in `candidateBuilder.js` triggers parallel API calls to GMGN and Jupiter for enrichment.

3. **Multi-Stage Filtering & Scoring**:
   - `filterCandidate()` runs hard filters (UTC worst hours, fee requirements, mcap limits, liquidity floor >= $5K, flow filter) and calculates v45 soft score (0-150 scale).
   - `preScoreCandidate()` in `preScorer.js` runs rule-based checks.
   - Re-check filters before ML/LLM.
   - `momentumFilter()` invokes `predict_momentum.py` Python subprocess via stdin/stdout, computing ML runner probability. Rejects if score < `momentum_threshold`.

4. **Decision & Sizing**:
   - If strategy has `use_llm: true`, `decideCandidateBatch()` in `llm.js` builds candidate batch, injects `current_regime_summary` and `current_macro_state`, calls LLM with fallback hierarchy, and returns verdict.
   - Confidence score scales position size via `effectivePositionSizeSol()`.
   - `createDryRunPosition()` / `createLivePosition()` applies risk severity adjustment (50% cut if risk severity >= 2), regime multiplier (0.25x - 1.5x), route source weighting (0.5x - 1.0x), and checks 24h closed / 7-day past-win re-entry guards before inserting into `dry_run_positions` and `dry_run_trades`.

5. **Execution & Feedback Loop**:
   - In `live` mode, `executeLiveBuy` calls `executeJupiterSwap` in `src/liveExecutor.js`.
   - `macroEngine.js` and `regimeDetector.js` continuously monitor closed trade win rates to adjust macro weather and strategy mcap/size parameters.
   - `autoApplyLessons` periodically analyzes closed trade performance and updates strategy configuration parameters in SQLite DB.
   - Position closes trigger Telegram alerts and PNG exit card generation via `generateExitCard()`.

---

## 3. Caveats

- **Read-Only Scope**: This report is an architectural inventory and data flow analysis. No source code modifications were performed in `src/` or `scripts/`.
- **Database File State**: The codebase relies on `better-sqlite3` creating/opening `charon.sqlite` at runtime. Schema initialization is handled dynamically by `initDb()` in `src/db/connection.js`.
- **Python ML Dependencies**: `predict_momentum.py` relies on `scikit-learn`, `numpy`, and pre-trained pickle files (`models/momentum_model.pkl`, `momentum_scaler.pkl`, `momentum_features.json`). If Python dependencies or pickle files are missing, `predict_momentum.py` outputs error JSON and returns a default -1 score.

---

## 4. Conclusion

The Charon architecture is a highly modular, multi-tier trading bot system. Its 9 core components interact through clean interface boundaries:
1. Signal Ingestion -> 2. Pipeline Orchestration & Candidate Builder -> 3. Dynamic Enrichment -> 4. Regime & Macro Engines -> 5. LLM Decision & ML Momentum Filter -> 6. Auto-Learn & AutoApply -> 7. Position & SQLite Database -> 8. Execution Router & Jupiter Executor -> 9. Telegram UI & Exit Card Renderer.

Every component has dedicated configuration properties in `src/config.js` and the `settings` / `strategies` database tables, enabling runtime strategy adaptation and automated strategy optimization.

---

## 5. Verification Method

To independently verify this inventory and system functionality:

1. **Verify File Structure**:
   Check existence of key modules:
   ```bash
   ls -la /root/Kaiser.charon/src/app.js \
          /root/Kaiser.charon/src/config.js \
          /root/Kaiser.charon/src/liveExecutor.js \
          /root/Kaiser.charon/src/db/connection.js \
          /root/Kaiser.charon/src/db/positions.js \
          /root/Kaiser.charon/src/pipeline/orchestrator.js \
          /root/Kaiser.charon/src/pipeline/candidateBuilder.js \
          /root/Kaiser.charon/src/pipeline/predict_momentum.py \
          /root/Kaiser.charon/src/learning/autoApply.js \
          /root/Kaiser.charon/src/visuals/exitCard.js
   ```

2. **Run Exit Card Renderer Verification Script**:
   ```bash
   node /root/Kaiser.charon/scripts/test_exit_card.mjs
   ```
   *Expected result*: Output shows `[profit] OK`, `[loss] OK`, `[rug] OK` and exits with status 0.

3. **Inspect DB Schema Initialization**:
   Check `src/db/connection.js` lines 6-225 to verify that `initDb()` creates all 19 SQLite tables and indices.
