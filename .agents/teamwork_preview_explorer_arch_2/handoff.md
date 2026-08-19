# Handoff Report: Charon Data Flow & System Architecture Deep Dive

**Agent**: Explorer 2  
**Milestone**: M-ARCH  
**Working Directory**: `/root/Kaiser.charon/.agents/teamwork_preview_explorer_arch_2`  
**Date**: 2026-08-09  

---

## 1. Observation

A complete read-only investigation of the Charon trading bot codebase was conducted across JavaScript daemon files (`src/app.js`, `src/config.js`, `src/liveExecutor.js`), pipeline modules (`src/pipeline/*.js`), signal sources (`src/signals/*.js`), enrichment adapters (`src/enrichment/*.js`), execution & position modules (`src/execution/*.js`), database modules (`src/db/*.js`), auto-learning components (`src/learning/*.js`, `scripts/*.mjs`), and Telegram visual renderers (`src/telegram/*.js`, `src/visuals/*.js`).

### 1.1 Key File & Function Mapping Across the 7 Pipeline Stages

| Stage | Primary Code Files | Key Functions & Interfaces | Data Handlers & Async Loops |
|---|---|---|---|
| **1. Signal Ingestion** | `src/signals/pumpportal.js`<br>`src/signals/pumpfunPregrad.js`<br>`src/signals/serverClient.js`<br>`src/signals/trenches.js`<br>`src/signals/graduated.js`<br>`src/signals/trending.js`<br>`src/signals/priceMonitor.js` | `startPumpportal()`, `onMessage()`, `handleNewToken()`, `graduateToken()`, `fetchPregradTokens()`, `fetchServerSignals()`, `fetchTrenches()`, `fetchGmgnTrending()` | WebSocket `wss://pumpportal.fun/api/data?api-key=...`<br>`setInterval` polling (Pregrad: 10s, Trenches: 60s, Server: 10s, Trending: 60s, Graduation: 60s). Candidate callback `processCandidateFromSignals`. |
| **2. Filtering & Enrichment** | `src/pipeline/orchestrator.js`<br>`src/pipeline/candidateBuilder.js`<br>`src/pipeline/preScorer.js`<br>`src/enrichment/gmgn.js`<br>`src/enrichment/jupiter.js`<br>`src/enrichment/rugcheck.js`<br>`src/enrichment/twitter.js` | `processCandidateFromSignals()`, `buildCandidate()`, `filterCandidate()`, `preScoreCandidate()`, `fetchGmgnTokenInfo()`, `fetchJupiterAsset()`, `fetchJupiterHolders()` | Async multi-tier parallel enrichment (`Promise.all` stage 1: GMGN, Jupiter asset, holders, chart; stage 2: wallet exposure, twitter). Dynamic dedup (<10m candidates, <4h closed positions, <2h LLM decisions). |
| **3. Scoring & Dynamic Soft-Thresholding** | `src/pipeline/candidateBuilder.js`<br>`src/pipeline/momentumFilter.js`<br>`src/pipeline/predict_momentum.py`<br>`src/pipeline/llm.js` | `computeSoftScore()`, `softScoreThreshold()`, `momentumFilter()`, `predict_momentum.py`, `decideCandidateBatch()`, `normalizeDecision()` | IPC via stdin/stdout to long-lived Python daemon `predict_momentum.py`. Async LLM Axios POST with primary/fallback models (Zyloo/OpenRouter) and dual-LLM consensus. |
| **4. Position Reservation & Execution** | `src/db/positions.js`<br>`src/execution/router.js`<br>`src/liveExecutor.js`<br>`src/db/connection.js` | `canOpenMorePositions()`, `incrementPendingPosition()`, `handleApprovedBuy()`, `createDryRunPosition()`, `createLivePosition()`, `executeJupiterSwap()`, `jupiterOrder()`, `jupiterExecute()` | In-memory atomic pending counter + SQLite transaction dedup guards (`WIN_BLOCK_DAYS=7`, 24h re-entry block). Jupiter Ultra HTTP API (`/order` and `/execute`) + web3.js `VersionedTransaction` signing. |
| **5. Position Monitoring & Exits** | `src/execution/positions.js`<br>`src/execution/router.js`<br>`src/utils.js` | `monitorPositions()`, `refreshPosition()`, `executeLiveSell()`, `dynamicStopLossPercent()`, `computeAtrPercent()` | Asynchronous interval loop (`POSITION_CHECK_MS`). Dual price refresh (Jupiter asset + executable quote `fetchTokenSpotViaQuote`). ATR dynamic SL, trailing TP (tightens to 5% at +40% PnL), break-even, time-based exits, partial TP (50% at +15%). |
| **6. Post-Trade Analysis & Auto-Learn** | `src/learning/summary.js`<br>`src/learning/lessons.js`<br>`src/learning/autoApply.js`<br>`scripts/auto_learn.mjs` | `runPeriodicLearning()`, `summarizeLearningWindow()`, `generateLessons()`, `storeLearningRun()`, `autoApplyLessons()` | 6-hour periodic loop (first run at 5 min). Aggregates window metrics, queries LLM or fallback rules, inserts into `learning_runs` & `learning_lessons`. Mutates SQLite `settings` & `strategies` tables (>30 closed trade gate, 7-day recency, 24h idempotency). |
| **7. Telegram UI & Exit Cards** | `src/telegram/send.js`<br>`src/telegram/bot.js`<br>`src/telegram/format.js`<br>`src/visuals/exitCard.js` | `sendPositionOpen()`, `sendPositionExit()`, `sendBatchReveal()`, `generateExitCard()`, `generateEntryCard()` | Node node-canvas 2D context rendering (800x420 PNG exit cards), temporary file buffer `/tmp/charon_exit_<id>.png`, Telegram Bot API `bot.sendPhoto` / `bot.sendMessage` with HTML formatting. |

---

## 2. Logic Chain

The overall system architecture operates as an asynchronous multi-stage pipeline. Data flows sequentially through the 7 stages with strict state validation, deduplication, risk controls, and automated parameter tuning.

```
+---------------------------------------------------------------------------------------------------+
| STAGE 1: SIGNAL INGESTION                                                                         |
| WebSocket (PumpPortal) / Polling (Server, Trenches, Pregrad, Trending, Graduation, Price Alerts)  |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v [Raw Signal Payload: mint, symbol, route]
+---------------------------------------------------------------------------------------------------+
| STAGE 2: FILTERING & ENRICHMENT                                                                   |
| Orchestrator Dedup -> Multi-tier Parallel Enrichment (GMGN/Jupiter/Twitter) -> Hard Filters        |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v [Enriched Candidate Object]
+---------------------------------------------------------------------------------------------------+
| STAGE 3: SCORING & DYNAMIC SOFT-THRESHOLDING                                                      |
| Pre-Scorer (CoS/LADS) -> Soft-Score (0-150) -> Python ML Daemon (Momentum) -> LLM CIO Decision     |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v [Decision: BUY | WATCH | PASS, Confidence, TP/SL]
+---------------------------------------------------------------------------------------------------+
| STAGE 4: POSITION RESERVATION & EXECUTION                                                         |
| Lock Slot -> Dedup Guard (24h / 7d Win Block) -> Refresh -> Jupiter Ultra Swap -> SQLite Insert   |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v [State: 'open' in dry_run_positions]
+---------------------------------------------------------------------------------------------------+
| STAGE 5: POSITION MONITORING & EXITS                                                              |
| Async Loop -> Spot/Quote Refresh -> SL/TP/Trailing/Time/Break-Even -> Execution Sell Router       |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v [State: 'closed' in dry_run_positions]
+---------------------------------------------------------------------------------------------------+
| STAGE 6: POST-TRADE ANALYSIS & AUTO-LEARN                                                         |
| 6h Learning Loop -> Window Summary -> LLM Lessons -> Safety Gates -> SQL Strategy Table Mutation  |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v [Live Parameter Updates in SQLite Settings/Strategies]
+---------------------------------------------------------------------------------------------------+
| STAGE 7: TELEGRAM NOTIFICATION & UI UPDATES                                                       |
| Canvas PNG Card Renderer -> Telegram Bot Photo Alert -> Inline Action Keyboards                  |
+---------------------------------------------------------------------------------------------------+
```

---

### Stage 1: Signal Ingestion

#### Signal Sources & Async Event Mechanisms
1. **PumpPortal WebSocket (`src/signals/pumpportal.js`)**:
   - Connection: Connects to `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`.
   - Subscriptions: Sends `{ method: 'subscribeNewToken' }` and `{ method: 'subscribeMigration' }`.
   - Message Parser: `onMessage(raw)` parses JSON payloads.
     - `payload.txType === 'create'`: Invokes `handleNewToken(payload)`. Adds mint to `seenTokens` Map (1h dedup) and tracks token in `trackedTokens` Map. Starts bonding curve polling loop (`checkBondingCurve()` every 30s) to monitor market cap growth. Once market cap reaches `$25,000` (`GRADUATION_MCAP_USD`), triggers `graduateToken(mint, entry)`.
     - `payload.txType === 'migrate'`: Token graduated instantly. Flagged for timing patterns (e.g. `fast_migration_0s`). Invokes `graduateToken(mint, entry)` immediately, which passes `{ mint, graduatedCoin, route: 'pumpportal_graduated' }` to `candidateHandler`.

2. **Pump.fun Pregrad Polling (`src/signals/pumpfunPregrad.js`)**:
   - Polling Interval: `PREGRAD_POLL_MS` (default 10s) via `axios.get('https://frontend-api-v3.pump.fun/coins', { params: { sort: 'last_trade_timestamp', order: 'DESC', limit: 200 } })`.
   - Filter criteria: Checks `real_sol_reserves` within `[PREGRAD_MIN_RSSR_SOL, PREGRAD_MAX_RSSR_SOL]` (e.g. 55 SOL to 85 SOL), token age `< PREGRAD_MAX_AGE_MS`, and ATH multiple `< PREGRAD_MAX_ATH_MULTIPLE`.
   - Callback: Passes payload built by `buildPregradPayload(coin)` to `candidateHandler`.

3. **Server Signals (`src/signals/serverClient.js`)**:
   - Polling Interval: `SIGNAL_POLL_MS` (default 10s) via GET `/api/signals?limit=100&minSources=2`.
   - Populates global `graduated` and `trending` Maps. Checks strategy requirements (`min_source_count`, `require_fee_claim`, `token_age_max_ms`). Routes candidates to `candidateHandler`.

4. **GMGN Trenches (`src/signals/trenches.js`)**:
   - Polling Interval: 60s via POST `/v1/trenches` with body specifying `TRENCHES_PLATFORMS` and `min_smart_degen_count: 4`. Route: `trenches_completed`.

5. **GMGN Trending (`src/signals/trending.js`)** & **Graduation Polling (`src/signals/graduated.js`)**:
   - Runs periodic polling (trending poll: 60s) to discover high-volume trending tokens on Solana.

---

### Stage 2: Filtering & Enrichment

#### Pipeline Entry & Bidirectional Deduplication (`src/pipeline/orchestrator.js`)
When `processCandidateFromSignals(signals)` is invoked:
1. **Concurrency Lock**: Checks `processingCandidates.has(signals.mint)` to prevent concurrent execution on the same mint.
2. **Global Position Limit Guard**: Evaluates `canOpenMorePositions()`. If `openPositionCount() >= max_open_positions`, aborts before making enrichment network calls.
3. **Multi-layer DB Dedup**:
   - *Open position check*: `SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open'`.
   - *Recent closed check*: `SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > Date.now() - 4h`.
   - *LLM decision check*: `SELECT id FROM llm_decisions WHERE mint = ? AND created_at_ms > Date.now() - 2h`.
   - *Cross-route mint dedup*: `SELECT id FROM candidates WHERE mint = ? AND created_at_ms > Date.now() - 10m`.
   - *Decision cache check*: `checkDecisionCache(mint)` returns cached verdict if valid.

#### Dynamic Data Enrichment (`src/pipeline/candidateBuilder.js`)
If dedup checks pass, `buildCandidate(signals)` fetches external market data:
- **Fast-path for freshly graduated (`pumpportal_graduated`)**:
  - Executes parallel `Promise.all([fetchJupiterAsset(mint), fetchJupiterHolders(mint)])`.
  - Skips GMGN API call (bypasses Cloudflare limits) and chart context.
  - Calls `fetchSavedWalletExposure(mint, holders)`.
- **Standard path (established tokens)**:
  - Stage 1 Parallel: `Promise.all([fetchGmgnTokenInfo(mint), fetchJupiterAsset(mint), fetchJupiterHolders(mint), fetchJupiterChartContext(mint)])`.
  - Stage 2 Parallel: `Promise.all([fetchSavedWalletExposure(mint, holders), fetchTwitterNarrative(asset, gmgn)])`.

#### Hard Rule Filtering (`filterCandidate` in `candidateBuilder.js`)
Candidate is evaluated against strategy criteria:
- **Time-of-day block**: Rejects worst historical hours (11-14, 20, 22 UTC).
- **Fee claim check**: `feeSol >= min_fee_claim_sol`.
- **Market Cap**: Min/Max Mcap range checks (skipped for fresh grads).
- **Holder distribution & audit**:
  - `botHoldersPercentage >= 40%`: Hard reject ("bot death zone").
  - `holderCount` in `[100, 400]`: Soft-flagged (`holder_deadzone`).
  - `devMigrations >= 20`: Soft-flagged (`serial_rugger`).
- **Liquidity floor**: Minimum DEX liquidity `$5,000` (`min_liquidity_usd`).
- **Flow Filter**: Requires 1h price change `>= 0%` and 5m net buyer ratio `>= 0.2`.

#### Pre-Scoring & Rule-Based Heuristics (`preScoreCandidate` in `src/pipeline/preScorer.js`)
Computes rule-based score (0-100+):
- Smart degen count (+10 to +30 points).
- Organic score (+5 to +25 points).
- Bundler rate (<10% = +20, <30% = +10).
- Fake volume / wash trading detector: If volume > $20k but fees < 0.1 SOL, subtracts 100 points (Instant Reject).
- State Transition Change-of-State (CoS) detection: Traces liquidity, volume, net buy pressure, price changes vs previous state (`getPreviousState`), computes LADS score (+40 for ABSORPTION, -50 for DISTRIBUTION).
- Threshold: Pre-scorer requires `score >= 45`.

---

### Stage 3: Score Calculation & Dynamic Soft-Thresholding

#### Dynamic Soft-Scoring Engine (`computeSoftScore` & `softScoreThreshold`)
1. **Soft-Score Calculation (`computeSoftScore`)**:
   - Base score 100 modified by route-specific multipliers:
     - `trenches_completed`: 1.5x
     - `pumpportal_graduated`: 1.2x
     - `fee_trending`: 1.0x
     - `trending` / `dual_source`: 0.5x / 0.3x
   - Deducts points for bot count, top 10 concentration, dev migrations, bundler rate.
   - Adds points for smart degens (>=5 degens = +30 pts) and organic score.
2. **Dynamic Soft Threshold (`softScoreThreshold`)**:
   - Base threshold: 50.
   - Time-of-day adjustment: +15 during quiet UTC hours (6-14 UTC).
   - Portfolio load adjustment: +10 when open positions >= max - 1; -10 when open positions == 0.

#### Python ML Momentum Prediction Daemon (`src/pipeline/momentumFilter.js` & `predict_momentum.py`)
- `momentumFilter(candidate, threshold=0.5)` sends candidate JSON over stdin to long-lived Python daemon `predict_momentum.py`.
- `predict_momentum.py`:
  - `extract_features(candidate)` extracts 35+ numerical features (price velocities 1m/5m/1h, volume ratios, buy/sell swap ratios, liquidity ratios, holder count, smart degen count, sniper count, bot rate, bundler rate, rug ratio, ATH drawdown, Twitter engagement).
  - Normalizes features using `momentum_scaler.pkl`.
  - Runs classification inference via `momentum_model.pkl` to compute `momentum_score` (probability of class 1 / runner).
  - Returns `{ id, momentum_score, features }` over stdout.
- Candidate rejected if `momentum_score < threshold`.

#### LLM CIO Decision Engine (`src/pipeline/llm.js`)
If strategy uses LLM (`use_llm: true`):
1. **Candidate Compaction**: `compactCandidateForLlm(row)` strips raw holder/chart arrays to reduce prompt tokens while retaining audit metrics, Jupiter stats, fee claims, and market cap context.
2. **Batch Assembly**: Gathers up to 10 recent eligible candidates (`recentEligibleCandidates`).
3. **Prompt Construction**: Inject system prompt containing Macro Weather, Real-Time Regime Memory, Micro Intelligence, Soft Score Context, Route Rules (Fresh Grad vs Established), Former Runner-Reclaim rules, Buy-The-Dip rules, and Insider Flow danger flags.
4. **API Call & Fallback Chain**:
   - Sends Axios POST to primary endpoint (`LLM_BASE_URL` / `LLM_MODEL`).
   - On 401/402/429/5xx/timeout errors, retries with fallback model (Zyloo `LLM_FALLBACK_MODEL` -> OpenRouter `LLM_OPENROUTER_MODEL`).
   - Optional Dual-LLM Consensus (`dual_llm_consensus` setting): If primary returns `BUY`, queries secondary model. If secondary disagrees, downgrades verdict to `WATCH`.
5. **Decision Normalization (`normalizeDecision`)**:
   - Validates verdict (`BUY`, `WATCH`, `PASS`).
   - Downgrades `BUY` to `WATCH` if confidence < `llm_min_confidence` (default 20/40) or if signal route is in `blocked_routes`.
   - Formats suggested TP (`suggested_tp_percent`) and SL (`suggested_sl_percent`).

---

### Stage 4: Position Reservation & Execution

#### Position Reservation & Deduplication (`src/db/positions.js`)
1. **Slot Reservation**: `canOpenMorePositions()` verifies current open count (`openPositionCount() = DB open positions + pendingPositionCount`) < `max_open_positions`.
2. **Atomic In-Memory Pending Counter**: `incrementPendingPosition()` increments before execution; `decrementPendingPosition()` decrements in `finally` block.
3. **Deduplication Guard**:
   - `SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open'`
   - 24-hour closed position re-entry block: `closed_at_ms > Date.now() - 86400000`.
   - Past win re-entry block: `WIN_BLOCK_DAYS = 7`. If a trade on this mint won within 7 days, blocks re-entry (`blockedBy: 'past_win'`).

#### Execution Router (`src/execution/router.js`)
- Invokes `refreshCandidateForExecution(selectedRow)` to fetch final market prices and verify filters before submitting swap order.
- **Position Sizing Calculation**:
  - `effectivePositionSizeSol(strat, decision)`: Scales base size by LLM confidence (`confidence / 100.0`).
  - Risk-based adjustment: If `totalRiskSeverity >= 2`, cuts size by 50%.
  - Regime multiplier (`getRegimeMultiplier()`): Adjusts size based on 24h win rate (Hot: 1.5x, Normal: 1.0x, Cold: 0.5x, Ice: 0.25x).
  - Source weight adjustment (`sourceWeight`): Multiplies size by route weight (pumpportal: 1.0x, trenches: 0.8x, pregrad: 0.7x, trending: 0.5x).

#### Execution Handler: Dry-Run vs Live
- **`dry_run` mode**: Executes `createDryRunPosition()`. Inserts record into SQLite table `dry_run_positions` (status `'open'`), `dry_run_trades` (side `'buy'`), and `tp_sl_rules`.
- **`live` mode**:
  - Checks wallet SOL balance (`liveWalletBalanceLamports() >= amount + LIVE_MIN_SOL_RESERVE_LAMPORTS`).
  - Calls `executeJupiterSwap({ inputMint: WSOL_MINT, outputMint: candidate.token.mint, amount: amountLamports })` in `src/liveExecutor.js`.
  - `liveExecutor.js`:
    1. Sends GET `/order` request to Jupiter Swap API (`JUPITER_SWAP_BASE_URL`) with `inputMint`, `outputMint`, `amount`, `taker`, `x-api-key`.
    2. Deserializes `VersionedTransaction` from base64 transaction string.
    3. Signs transaction with local Solana `Keypair` (`SOLANA_PRIVATE_KEY`).
    4. Sends POST `/execute` request to submit signed transaction.
    5. Retries up to 3 times on transient network errors.
  - On success, calls `createLivePosition()` to insert record into `dry_run_positions` (execution_mode `'live'`, status `'open'`, `entry_signature`, `token_amount_raw`), `dry_run_trades`, and `tp_sl_rules`.
  - On retry exhaustion, logs `FAILED_ENTRY` into DB and sends alert.

---

### Stage 5: Position Monitoring & Exits

#### Monitoring Async Loop (`src/app.js` & `src/execution/positions.js`)
- `setInterval` in `src/app.js` runs `monitorPositions()` every `POSITION_CHECK_MS` (e.g. 10s / 30s).
- Uses concurrency guard `positionMonitorRunning` to prevent overlapping monitor cycles.
- Queries all open positions (`SELECT * FROM dry_run_positions WHERE status = 'open'`).

#### Price Refresh & Exit Evaluation (`refreshPosition` in `src/execution/positions.js`)
1. **Price Data Fetching**:
   - Queries Jupiter asset (`fetchJupiterAsset`) and executable quote spot price (`fetchTokenSpotViaQuote`).
   - Computes current price, current market cap, high-water mark price (`high_water_price`), and high-water market cap (`high_water_mcap`).
2. **ATR Dynamic Stop-Loss**:
   - Calls `fetchJupiterChartContext(mint)` to retrieve 5m candles.
   - `computeAtrPercent(windows, 14)` computes Average True Range %.
   - `dynamicStopLossPercent()` widens or narrows `effectiveSlPercent` (floored at -50%, capped at -8%).
3. **Exit Condition Evaluation**:
   - **Stop-Loss (`SL`)**: `pnlPercent <= effectiveSlPercent && pnlPercent < 0`. (Ensures SL never triggers on positive PnL).
   - **Break-Even Stop (`BREAK_EVEN`)**: If peak PnL >= +8% (`break_even_threshold_percent`) and current PnL drops to `<= 0.5%`, exits to protect capital.
   - **Take-Profit (`TP`)**: `pnlPercent >= tp_percent` (when trailing disabled).
   - **Trailing Take-Profit (`TRAILING_TP`)**:
     - Armed when PnL >= `armThreshold` (default +10%).
     - Tightens trailing distance from 10% to 5% (`trailing_tight_percent`) when peak PnL >= +40% (`trailing_tight_from_percent`).
     - Exits when PnL drops `>= effectiveTrailPct` below high-water mark and current PnL >= +3% (`trailing_floor_percent`).
   - **Time-Based Exit Tightening (`TIME_TIGHTEN`)**:
     - After 10m: tightens SL to 0% (if positive peak) or -6%.
     - After 15m: tightens SL to -3%.
     - After 20m: exits if PnL < +5%.
   - **Max Hold Time (`MAX_HOLD`)**: Exits if position age >= `max_hold_ms` (e.g. 30m).
   - **Sideways Timeout (`SIDEWAYS_TIMEOUT`)**: Exits if position age > `sideways_timeout_minutes` and `|pnlPercent| < 2%`.
   - **Partial Take-Profit (`PARTIAL_TP` / `PARTIAL_TP_DEFAULT`)**:
     - At +15% PnL, executes partial sell of 50% position size.
     - In live mode, executes live sell via Jupiter Swap. Updates remaining `token_amount_raw` and `size_sol` in DB, sets `partial_tp_done = 1`.

#### Exit Execution Router (`executeLiveSell` / Dry-Run Exit Update)
- **Live mode**: Invokes `executeLiveSell(position, exitReason)`. Swaps token for WSOL on Jupiter. Calculates realized SOL return (`receivedSol`), updates `dry_run_positions` (`status = 'closed'`, `closed_at_ms`, `exit_price`, `exit_mcap`, `exit_reason`, `pnl_percent`, `pnl_sol`, `exit_signature`), and inserts sell trade into `dry_run_trades`.
- **Dry-run mode**: Applies dry-run slippage adjustment (`slippageAdjustedMcap(mcap, 'exit')`), updates DB record status to `'closed'`, and records exit trade in `dry_run_trades`.

---

### Stage 6: Post-Trade Analysis & Auto-Learn

#### Periodic Learning Cycle (`src/app.js` & `src/learning/summary.js`)
- `runPeriodicLearning()` runs every 6 hours (first run after 5 min).
- `summarizeLearningWindow(12h)`:
  - Queries closed dry-run positions in past 12h.
  - Aggregates overall win rate, total PnL %, avg PnL %, and performance broken down by signal route (`byRoute`).
  - Identifies top 10 best and worst trades (extracting bot %, smart money count, momentum score, entry/exit mcap).
  - Summarizes LLM batch verdicts and decision log actions.

#### Analytical Lesson Generation (`src/learning/lessons.js`)
- Passes window summary to LLM (`generateLessons(summary)`) or heuristic fallback (`fallbackLessons(summary)`).
- Prompt instructs LLM Quant AI to discover underlying failure patterns (e.g. entry mcap too high, bot concentration, low liquidity) and output structured parameter tuning actions.
- Inserts results into SQLite tables `learning_runs` (run metadata, summary JSON, raw JSON) and `learning_lessons` (individual lessons, status `'active'`, evidence JSON).

#### Parameter Tuning & Strategy Mutation (`src/learning/autoApply.js`)
- Calls `autoApplyLessons(minConfidence = 0.7)`.
- **Safety Gates**:
  1. *Closed Position Gate*: Requires `>= 30` closed dry-run trades in SQLite DB before auto-apply activates.
  2. *Recency Gate*: Only processes active lessons created within the past 7 days (`cutoffMs = now() - 7d`).
  3. *Idempotency Gate*: Checks `learning_applied` table to ensure the exact same action has not been applied to the target strategy within the last 24 hours.
  4. *Type Safety Gate*: Validates that parameter data types (number, boolean, string) match existing schemas.
- **DB Mutations**:
  - `target === 'settings'`: Executes `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`.
  - `target === 'strategy'`: Reads `config_json` from `strategies` table, parses JSON, updates parameter value, and writes back `UPDATE strategies SET config_json = ? WHERE id = ?`.
  - Inserts log record into `learning_applied` table (`lesson_id`, `applied_at_ms`, `action`, `old_value`, `new_value`, `strategy_id`).
  - Sends Telegram notification detailing auto-applied parameter tuning.

---

### Stage 7: Telegram Notification & UI Updates

#### Visual Card Rendering (`src/visuals/exitCard.js` & `src/visuals/entryCard.js`)
- `generateExitCard(position)` uses Node.js `node-canvas` (800x420 PNG canvas).
- Renders:
  - Header: `CLOSED` badge (green for profit, red for loss), exit reason pill (e.g., `TRAILING_TP`, `SL`), token symbol, short mint address.
  - Metrics Grid: Deposited SOL, PnL %, PnL SOL, hold duration.
  - Summary Panel: Entry Mcap, Exit Mcap, Strategy ID, Execution Mode.
  - Timestamps: Opened/Closed UTC timestamps and Charon branding.

#### Telegram Messaging Handlers (`src/telegram/send.js`)
1. **Candidate Alerts (`sendCandidateAlert`)**: Formats candidate summary and attaches inline candidate buttons (`cand:<id>`).
2. **Batch Reveals (`sendBatchReveal`)**: Sends formatted summary of LLM screening batch with candidate selection buttons.
3. **Position Open Notifications (`sendPositionOpen`)**: Generates entry card PNG via `generateEntryCard`, saves to `/tmp/charon_entry_<id>.png`, calls `bot.sendPhoto(TELEGRAM_CHAT_ID, tmpPath, { caption, parse_mode: 'HTML' })`.
4. **Position Exit Notifications (`sendPositionExit`)**: Called by `monitorPositions()` on position exit. Generates exit card PNG via `generateExitCard`, writes to `/tmp/charon_exit_<id>.png`, calls `bot.sendPhoto` with HTML caption and inline keyboard buttons. On rendering failure, falls back to text notification via `sendTelegram`.

---

## 3. Data Structures, Payloads & Database Schemas

### 3.1 Key Runtime Data Payload Schemas

#### 1. Incoming WebSocket Raw Token Payload (`pumpportal.js`)
```json
{
  "txType": "create | migrate",
  "mint": "7xKX...pump",
  "traderPublicKey": "4vJ...",
  "initialBuy": 10000000,
  "bondingCurveKey": "6nF...",
  "vTokensInBondingCurve": 1073000100000000,
  "vSolInBondingCurve": 30000000000,
  "marketCapSol": 28.5,
  "name": "Meme Coin",
  "symbol": "MEME",
  "uri": "https://ipfs.io/ipfs/..."
}
```

#### 2. Enriched Candidate Payload (`candidateBuilder.js`)
```json
{
  "token": {
    "mint": "7xKX...pump",
    "name": "Meme Coin",
    "symbol": "MEME",
    "gmgnUrl": "https://gmgn.ai/sol/token/7xKX...pump",
    "twitter": "https://x.com/memecoin",
    "website": "https://memecoin.com",
    "telegram": "https://t.me/memecoin"
  },
  "metrics": {
    "priceUsd": 0.000025,
    "marketCapUsd": 25000,
    "liquidityUsd": 8500,
    "holderCount": 185,
    "gmgnTotalFeesSol": 1.2,
    "gmgnTradeFeesSol": 0.05,
    "graduatedVolumeUsd": 12000,
    "graduatedMarketCapUsd": 25000,
    "trendingVolumeUsd": 15000,
    "trendingSwaps": 320,
    "trendingHotLevel": 3,
    "trendingSmartDegenCount": 5
  },
  "signals": {
    "route": "pumpportal_graduated",
    "label": "graduated",
    "hasFeeClaim": false,
    "hasGraduated": true,
    "hasTrending": false,
    "triggerSignature": "5wK...",
    "strategy": "sniper"
  },
  "jupiterAsset": {
    "usdPrice": 0.000025,
    "mcap": 25000,
    "liquidity": 8500,
    "holderCount": 185,
    "organicScore": 65,
    "audit": {
      "mintAuthorityDisabled": true,
      "freezeAuthorityDisabled": true,
      "topHoldersPercentage": 18.5,
      "devBalancePercentage": 0.0,
      "devMigrations": 2,
      "botHoldersCount": 12,
      "botHoldersPercentage": 6.5
    }
  },
  "filters": {
    "passed": true,
    "failures": [],
    "softScore": 85,
    "softThreshold": 50,
    "sourceWeight": 1.0
  }
}
```

#### 3. LLM Decision Batch Payload (`llm.js`)
```json
{
  "verdict": "BUY",
  "selected_candidate_id": 42,
  "selected_mint": "7xKX...pump",
  "confidence": 75,
  "thesis": ["Low bot percentage (6.5%)", "Strong DEX liquidity ($8.5k)", "Clean migration"],
  "missing_confirmation": ["Twitter engagement volume"],
  "reason": "Freshly graduated coin exhibiting clean holder distribution and high organic score.",
  "risks": ["Volatile launch window"],
  "suggested_tp_percent": 50,
  "suggested_sl_percent": -25
}
```

#### 4. Jupiter Ultra API Trade Order Payloads (`liveExecutor.js`)
```json
// Order Request GET params:
// /order?inputMint=So11111111111111111111111111111111111111112&outputMint=7xKX...pump&amount=80000000&taker=4vJ...

// Execute POST body:
{
  "signedTransaction": "base64EncodedVersionedTransactionString...",
  "requestId": "jup_req_987654321"
}

// Execute Response JSON:
{
  "status": "Success",
  "signature": "3mP8vX...",
  "outputAmountResult": "3200000000"
}
```

---

### 3.2 SQLite Database Tables (`src/db/connection.js`)

```
+-----------------------------------------------------------------------------------------+
| SQLite Database: charon.sqlite                                                         |
+-----------------------------------------------------------------------------------------+
| 1. candidates           (id, mint, status, created_at_ms, candidate_json, filter_json) |
| 2. llm_decisions        (id, candidate_id, mint, verdict, confidence, reason, raw_json) |
| 3. llm_batches          (id, created_at_ms, trigger_cand_id, selected_id, verdict, raw) |
| 4. dry_run_positions    (id, candidate_id, mint, symbol, status, opened_at_ms, size_sol,|
|                          entry_price, entry_mcap, high_water_mcap, tp_percent,          |
|                          sl_percent, trailing_enabled, trailing_percent, exit_price,    |
|                          exit_mcap, exit_reason, pnl_percent, pnl_sol, execution_mode) |
| 5. dry_run_trades       (id, position_id, mint, side, at_ms, price, mcap, size_sol,     |
|                          reason, payload_json)                                          |
| 6. tp_sl_rules          (position_id, tp_percent, sl_percent, trailing_enabled, etc.)   |
| 7. trade_intents        (id, candidate_id, mint, mode, status, side, size_sol, payload) |
| 8. decision_logs        (id, at_ms, batch_id, selected_mint, mode, action, guardrails)|
| 9. signal_events        (id, mint, kind, at_ms, source, payload_json)                  |
| 10. learning_runs       (id, created_at_ms, window_ms, summary_json, lessons_json, raw)|
| 11. learning_lessons    (id, run_id, created_at_ms, status, lesson, evidence_json)     |
| 12. learning_applied    (id, lesson_id, applied_at_ms, action, old_value, new_value)   |
| 13. settings            (key PRIMARY KEY, value)                                        |
| 14. strategies          (id PRIMARY KEY, name, enabled, config_json, created_at_ms)     |
+-----------------------------------------------------------------------------------------+
```

---

## 4. State Transitions

### Candidate & Position Lifecycle

```
[Raw Signal]
     │
     ▼ (buildCandidate)
Candidate status: 'new'
     │
     ├─────► Filter Failure ─────────────► Candidate status: 'filtered' (Dropped)
     │
     ├─────► Pre-Score / Momentum Fail ──► Candidate status: 'filtered' (Dropped)
     │
     ▼ (decideCandidateBatch)
Candidate status: 'buy' | 'watch' | 'pass'
     │
     ├─────► Verdict: WATCH / PASS ──────► Logged in decision_logs / signal_events
     │
     ▼ Verdict: BUY (Approved)
Pending Position Count incremented (+1)
     │
     ├─────► Fresh Filter Recheck Fail ──► Candidate status: 'stale_rejected'
     │
     ▼ (createDryRunPosition / createLivePosition)
Pending Position Count decremented (-1)
Position created in dry_run_positions (status: 'open', opened_at_ms = now)
Trade recorded in dry_run_trades (side: 'buy')
Position Open Telegram Card sent
     │
     ▼ Periodic Monitor Loop (refreshPosition)
Position updated: high_water_mcap, high_water_price, trailing_armed
     │
     ├─────► Partial TP Trigger (+15%) ──► Partial Sell Executed, partial_tp_done = 1, size_sol updated
     │
     ▼ Exit Trigger (SL | BREAK_EVEN | TP | TRAILING_TP | TIME_TIGHTEN | MAX_HOLD | SIDEWAYS_TIMEOUT)
Position updated in dry_run_positions (status: 'closed', closed_at_ms = now, exit_reason, pnl_percent, pnl_sol)
Trade recorded in dry_run_trades (side: 'sell')
Position Exit Telegram PNG Card sent
     │
     ▼ 6-Hour Auto-Learn Cycle (runPeriodicLearning)
Position included in summarizeLearningWindow
LLM generates lessons -> autoApplyLessons mutates settings/strategies tables
```

---

## 5. Caveats

1. **Read-Only Scope**: This report is produced as part of a read-only investigation. No source code modifications were performed during this audit.
2. **WebSocket Fallback Dependency**: PumpPortal WebSocket connection resilience relies on local reconnection backoff timers and automated console alerts. When PumpPortal is unreachable, the daemon seamlessly relies on HTTP polling of GMGN trenches and pump.fun pregrad endpoints.
3. **Execution Network Latency**: Live order execution timings depend on Jupiter Ultra API response times and Solana RPC confirmation times. The daemon implements a 3-attempt retry loop for both buy and sell orders.

---

## 6. Conclusion

The Charon data pipeline is a robust, modular, and resilient trading system. Its multi-layer design ensures that expensive enrichment and LLM decision calls are made only for candidates that pass strict early deduplication and rule-based pre-scoring.

Key operational strengths identified:
1. **Multi-layer Deduplication**: Prevents double-buying on identical tokens across multiple signal sources within 10 minutes, blocks re-entry for 24h post-closure, and enforces a 7-day win block guard (`WIN_BLOCK_DAYS=7`).
2. **Dynamic Risk Control**: Integrates ATR-based dynamic stop-losses, progressive trailing stop tightening (down to 5% at +40% PnL), break-even stops at +8% profit, time-based exit tightening, and partial take-profits.
3. **Self-Improving Feedback Loop**: The Auto-Learn module continuously evaluates closed position outcomes every 6 hours, leverages LLM analysis to identify market pattern shifts, and safely mutates strategy parameters under strict recency and idempotency gates.

---

## 7. Verification Method

To independently verify the data flows, interfaces, and execution paths documented in this report:

### 1. File Inspection
Inspect key source files to confirm signatures and data structures:
- `view_file` on `/root/Kaiser.charon/src/app.js` (daemon boot & loop schedules)
- `view_file` on `/root/Kaiser.charon/src/pipeline/orchestrator.js` (candidate flow & dedup logic)
- `view_file` on `/root/Kaiser.charon/src/pipeline/candidateBuilder.js` (enrichment & filters)
- `view_file` on `/root/Kaiser.charon/src/pipeline/momentumFilter.js` (Python IPC bridge)
- `view_file` on `/root/Kaiser.charon/src/execution/router.js` (swap order execution & position creation)
- `view_file` on `/root/Kaiser.charon/src/execution/positions.js` (monitoring & exit evaluation)
- `view_file` on `/root/Kaiser.charon/src/learning/autoApply.js` (strategy parameter mutation)

### 2. Lint & Syntax Verification
Run the workspace syntax and lint checks:
```bash
node /root/Kaiser.charon/lint.cjs
```

### 3. Test Suite Execution
Run existing unit and integration test scripts:
```bash
node /root/Kaiser.charon/scripts/test_exit_card.mjs
```
