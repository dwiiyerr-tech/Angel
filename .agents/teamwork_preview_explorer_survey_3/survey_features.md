# Kaiser.Charon — Comprehensive Feature Inventory & Gap Survey Report

**Explorer 3:** Feature Inventory & Gap Explorer  
**Step:** 0 — Codebase Stabilization Survey  
**Date:** 2026-08-08  
**Target Repository:** `/root/Kaiser.charon`  
**Artifact Path:** `/root/Kaiser.charon/.agents/teamwork_preview_explorer_survey_3/survey_features.md`

---

## 1. Executive Summary & Survey Scope

`Kaiser.charon` is an automated Solana Pump.fun token screening, evaluation, and trading bot built in Node.js (ES Modules) with SQLite persistence, Jupiter DEX swap execution, GMGN/Jupiter/PumpPortal data enrichment, Python ML momentum scoring, LLM candidate judgment, and Telegram bot UI.

The bot supports three primary operating modes:
1. `dry_run` — Paper trading using Jupiter quotes and SQLite paper position simulation.
2. `confirm` — Signal filtering with Telegram interactive approve/reject buttons.
3. `live` — Automated real-money Solana swaps executed via Jupiter Swap v6 / Jupiter Ultra API using an Ed25519 keypair.

This survey provides a comprehensive enumeration of all modules, domain logic, implemented features, strategy profiles, API endpoints, and critical gaps identified across source code, documentation, inline comments, audit findings, and backtest records.

### Summary of System Status
- **Core Architecture:** Functional multi-source signal ingestion pipeline, SQLite persistence with decision caching, ML momentum scoring subprocess, Telegram UI, and paper trading simulator.
- **Critical Real-Money Execution Vulnerabilities:** 3 Critical findings (C1: Missing Jupiter slippage cap; C2: Post-swap dedup leading to orphaned funds; C3: Unchecked auto-tuning SQL mutator running without human approval).
- **High-Severity System Gaps:** TOCTOU race conditions on position limits (H1), unreconciled network swap execution timeouts (H2), unbounded memory cache leaks (H3), stale price exposures during backoff (H4), and ESM `require` logic bugs breaking dynamic threshold calculations (B-4).
- **Strategy & Decision Gaps:** Inverted trending volume filter gate (B-1), overly restrictive LLM prompts producing 0 autonomous LLM buy decisions in production, and unreachable confidence thresholds.
- **Testing Infrastructure Deficit:** Zero formal unit or integration test suites (no Jest/Mocha/Vitest); only standalone test scripts.

---

## 2. Comprehensive Module & Feature Inventory

The `charon` codebase consists of **10 primary subsystem modules**, **6 database models/connection wrappers**, **13 signal intake engines**, **5 enrichment connectors**, **7 evolution engine components**, **5 learning components**, **9 Telegram interface components**, **3 visual card renderers**, and **16 analytical/backtest scripts**.

### 2.1 Subsystem Architecture & Core Components

| Subsystem Module | Directory / Files | Key Responsibilities & Capabilities | Implementation Status |
|---|---|---|---|
| **System Core & Runtime** | `index.js`, `src/app.js`, `src/config.js`, `src/utils.js`, `src/format.js` | Process initialization, environment validation, timer orchestration, failure tracking wrapper, number formatting, process event handlers (`unhandledRejection`, `uncaughtException`). | **Fully Implemented** (with config validation gaps) |
| **Database & Persistence** | `src/db/connection.js`, `candidates.js`, `decisions.js`, `intents.js`, `positions.js`, `settings.js`, `migrations/` | SQLite (`charon.sqlite`) connection, schema migrations (`schema.sql`, `001_decision_cache.sql`), candidate storage, decision logs, decision caching (10m/60m TTL), position state tracking (`dry_run_positions`, `positions`), setting/strategy JSON updates. | **Implemented** (lacks WAL `busy_timeout`/`synchronous` pragmas) |
| **Signal Acquisition** | `src/signals/pumpportal.js`, `pumpfunPregrad.js`, `trenches.js`, `trending.js`, `graduated.js`, `feeClaim.js`, `priceMonitor.js`, `macroEngine.js`, `gmgnSignal.js`, `smartMoney.js`, `narrativeTracker.js`, `axiomSource.js`, `serverClient.js` | Multi-channel token signal ingestion: WebSocket feeds (`pumpportal.js` for new token & migration events), GMGN Trenches polling (60s), Jupiter/GMGN Trending API (60s), Pump.fun pre-grad bonding curve scanner, price alert dip-buyers, macro SOL weather tracker. | **Implemented** (has duplicate handling & backoff bugs) |
| **Enrichment Subsystem** | `src/enrichment/gmgn.js`, `jupiter.js`, `rugcheck.js`, `twitter.js`, `wallets.js` | Data enrichment for token metadata: holder counts, total fees paid, dev migration history, bot holder %, Ed25519 GMGN request signing, Jupiter price/asset queries, RugCheck verification, Twitter social verification, wallet profiling. | **Implemented** (has memory leak in unbounded Map caches) |
| **Pipeline & Strategy Decision** | `src/pipeline/orchestrator.js`, `candidateBuilder.js`, `preScorer.js`, `momentumFilter.js`, `predict_momentum.py`, `llm.js` | Pipeline coordination, pre-scoring, Option C Hybrid Filters (bot>=25% hard reject, holder deadzone [100, 400], dev migrations >=20), decision cache check, pre-LLM filter guard, Python ML momentum model inference (scikit-learn), LLM batch judgment. | **Implemented** (LLM prompt overly restrictive; ESM `require` bug) |
| **Execution Subsystem** | `src/execution/router.js`, `positions.js`, `src/liveExecutor.js` | Trade routing (`dry_run` vs `confirm` vs `live`), Jupiter Swap API v6 / Jupiter Ultra API integration, Solana wallet transaction signing, position sizing (risk-adjusted), position monitoring loop (TP/SL/trailing stop), live position exit. | **Implemented** (has Critical slippage C1, dedup C2, and TOCTOU H1 bugs) |
| **Evolution Engine** | `src/evolution/arena.js`, `loop.js`, `migrationEvo.js`, `optimizer.js`, `regimeDetector.js`, `strategyFactory.js`, `tradeDna.js` | Self-improving strategy optimization, genetic algorithm chromosome representation (TradeDNA), strategy factory, regime detection (bull/bear/sideways), arena tournament evaluation. | **Implemented** |
| **Learning Subsystem** | `src/learning/autoApply.js`, `lessons.js`, `summary.js`, `commands.js`, `report.js` | Windowed performance summarization, LLM lesson generation (`generateLessons`), storage of learning runs (`learning_runs`), auto-tuning rule extraction and strategy config update (`autoApplyLessons`). | **Implemented** (Critical C3: autoApply mutates SQL without approval) |
| **Telegram Interface** | `src/telegram/bot.js`, `commands.js`, `menus.js`, `callbacks.js`, `dailyReport.js`, `input.js`, `format.js`, `report.js`, `send.js` | Interactive Telegram bot commands (`/start`, `/menu`, `/status`, `/strategy`, `/stratset`, `/positions`, `/balance`, `/mode`, `/learn`, `/evolution`), inline keyboard menus, intent confirmation callbacks, report rendering. | **Implemented** (lacks confirmation UI for auto-learn proposals) |
| **Visual Renderers** | `src/visuals/dailyCard.js`, `entryCard.js`, `exitCard.js` | Canvas-based PNG image rendering for daily PnL summaries, entry notification cards, and exit notification cards sent to Telegram. | **Implemented** |
| **Scripts & Analytics** | `scripts/comprehensive_edge_backtest.py`, `general_filter_backtest.py`, `per_route_backtest.py`, `dashboard.py`, `fill_reconstruct.py`, `daily_autotuner.js`, `monitor.sh`, `verify_backtest.py` | Standalone split-half backtest analysis tools, metrics server, trade fill reconstructor, automated process monitor, database verification. | **Implemented** |

---

## 3. Detailed Gap Analysis: Identified Issues, Bugs & Deficits

### 3.1 Critical Vulnerabilities & Real-Money Execution Gaps

#### Gap C1: Configured Slippage Cap Never Sent to Jupiter API
- **Location:** `src/liveExecutor.js:6`, `65-81`, `106-126`; `src/config.js:24`
- **Description:** `JUPITER_SLIPPAGE_BPS` (default `300` = 3%) is defined in `config.js` and imported in `liveExecutor.js`, but is **never appended** to the Jupiter `/order` or swap request URL/payload.
- **Impact:** Live swaps execute with Jupiter's default dynamic/unbounded slippage. On illiquid memecoins, trades can suffer extreme slippage losses far exceeding the user's configured 3% cap.
- **Required Fix:** Append `slippageBps` or dynamic slippage parameter to Jupiter order request payload and abort trade if quoted price impact exceeds cap.

#### Gap C2: On-Chain Live Swap Executes BEFORE Deduplication Guard Check
- **Location:** `src/execution/router.js:32-98`; `src/db/positions.js:126-158`
- **Description:** In `executeLiveBuy`, `executeJupiterSwap()` is invoked on line 32 (spending real SOL on-chain). Only afterward is `createLivePosition()` called on line 86. Inside `createLivePosition()`, the transaction checks for existing open positions, recent closed positions within 24h, or past winning trades. If any check hits, `createLivePosition()` returns `{ isNew: false }` **without inserting a position record**.
- **Impact:** Real SOL is spent on Jupiter and tokens arrive in the wallet, but no position record is saved in SQLite. The tokens become orphaned—they are never tracked for TP/SL and never sold by `monitorPositions()`.
- **Required Fix:** Move the read-only deduplication guard check (`existing`, `recentClosed`, `pastWin`) **before** executing `executeJupiterSwap()`. If dedup fails post-swap due to a race, explicitly record the orphaned tokens and trigger an urgent alert.

#### Gap C3: `autoApplyLessons` Mutates Active Strategy Config Without Human Approval Gate
- **Location:** `src/learning/autoApply.js:155`, `165`; `src/app.js:111-130`
- **Description:** `autoApplyLessons()` extracts parameter changes from natural-language LLM lessons using regexes and executes direct `UPDATE strategies SET config_json = ?` or `INSERT INTO settings` queries. In `app.js:127-129`, `runPeriodicLearning()` automatically calls `autoApplyLessons(0.7)` every 6 hours.
- **Impact:** System automatically alters core strategy parameters (`sl_percent`, `min_mcap_usd`, `llm_min_confidence`, etc.) based on unverified regex extractions without human operator confirmation.
- **Required Fix:** Remove automated SQL execution from `autoApplyLessons`. Convert `autoApplyLessons` to create a "proposed settings change" record in DB and send a Telegram message with Approve/Reject inline buttons.

---

### 3.2 High-Severity Architectural & Data Integrity Gaps

#### Gap H1: TOCTOU Race Condition Exceeds `max_open_positions` Limit
- **Location:** `src/pipeline/orchestrator.js:29, 189, 384`; `src/execution/router.js:114`; `src/db/positions.js:20-25`
- **Description:** `canOpenMorePositions()` is a non-atomic read of `openPositionCount()`. Signals arriving concurrently from Pumpportal WS, GMGN Trenches, and Trending can all pass `canOpenMorePositions()` before any swap transaction inserts a new row into `positions`.
- **Impact:** Concurrent signals trigger multiple live swaps that all execute, causing total open positions to exceed `max_open_positions`.
- **Required Fix:** Wrap entry evaluation, swap execution, and position creation in an in-process mutex/queue and re-verify count inside position creation transaction.

#### Gap H2: Unreconciled Swap Execution Failures / Ambiguous Fills
- **Location:** `src/liveExecutor.js:106-126`; `src/execution/router.js:32-48, 140-147`
- **Description:** If Jupiter execute API times out (30s timeout) or returns an unparseable response, `executeJupiterSwap()` throws an error. The router catches this and records `FAILED_ENTRY` without checking on-chain wallet token balance.
- **Impact:** If the transaction landed on Solana despite the API timeout, tokens are in the wallet but logged as `FAILED_ENTRY`, creating untracked wallet balances.
- **Required Fix:** On any swap exception where a transaction may have been broadcast, query on-chain token balance / transaction status before marking position as failed.

#### Gap H3: Unbounded In-Memory Cache Growth (Memory Leak)
- **Location:** `src/enrichment/gmgn.js:6, 162, 173, 180`; `src/enrichment/jupiter.js:5, 60, 71`
- **Description:** `gmgnCache` and `jupiterAssetCache` are native JavaScript `Map` instances. Items are added via `.set()`, but no eviction routine or size limits (`.delete()` / `.clear()`) exist.
- **Impact:** In a 24/7 long-running process screening thousands of new Solana mints, these Maps grow indefinitely, causing memory bloat and eventual process OOM / GC thrash.
- **Required Fix:** Implement a periodic TTL sweep or replace `Map` with an LRU cache with max capacity (e.g. 1000 items) and 10-minute TTL.

#### Gap H4: Stale Price Exposure During API Rate-Limit Backoff
- **Location:** `src/enrichment/jupiter.js:58-77`; `src/signals/priceMonitor.js:65-102`
- **Description:** During 429 backoff, `fetchJupiterAsset()` returns `cached?.data` regardless of age. `monitorPriceAlerts()` consumes this price directly for dip-buy comparisons (`currentPrice <= alert.target_price_usd`).
- **Impact:** Dip-buy entries can trigger on minutes-old cached prices during API rate limits.
- **Required Fix:** Reject cache entries older than a strict max age (e.g. 30 seconds) when making trade entry decisions during backoff.

---

### 3.3 Strategy Logic & Runtime Bugs

#### Gap B-1: Inverted Trending Volume Filter Gate
- **Location:** `src/pipeline/candidateBuilder.js`; `src/signals/trending.js`; `BACKTEST_EDGE_2026-07-07.md:150-159`
- **Description:** `trending_min_volume_usd = 5000` requires tokens to have trending volume >= $5,000. Split-half backtest analysis revealed:
  - `trendingVol < $5,000` (rejected): n=403, win rate 28.3%, PnL -3.41 SOL.
  - `trendingVol >= $5,000` (admitted): n=397, win rate 27.5%, PnL -13.87 SOL.
- **Impact:** The gate actively admits the worse half of candidates, accumulating -13.87 SOL loss vs -3.41 SOL on rejected candidates.
- **Required Fix:** Remove minimum volume requirement or invert it to a cap based on backtest edge data.

#### Gap B-4: Broken Dynamic Soft-Score Threshold in ESM Mode
- **Location:** `src/pipeline/candidateBuilder.js: line calling globalOpenPositionCount()`; `BACKTEST_EDGE_2026-07-07.md:180-188`
- **Description:** `globalOpenPositionCount()` uses `require('./positions.js')` inside a try/catch block. Since the project uses `"type": "module"` (ESM), `require` is undefined. The catch block silently returns 0.
- **Impact:** `softScoreThreshold()` always sees `openCount === 0` and returns `baseThreshold - 10 = 20` (the loosest threshold), rendering the position-based score tightening logic completely dead.
- **Required Fix:** Replace `require('./positions.js')` with top-level ESM import `import { openPositionCount } from '../db/positions.js'`.

#### Gap LLM-1: Overly Restrictive LLM Prompt & Unreachable Confidence Threshold
- **Location:** `src/pipeline/llm.js:180-210`; `src/config.js`; `STRATEGY_ANALYSIS.md:55-98`
- **Description:** System prompt instructs LLM: *"Use verdict BUY only for the single best unusually strong asymmetric opportunity."* Additionally, default `llm_min_confidence` is set to 75. In production database history (36 batches), the LLM scored maximum confidence of ~30 and issued **0 autonomous BUY verdicts**. All 3 recorded BUYs were rule-based bypasses (`use_llm: false`).
- **Impact:** LLM decision layer is completely paralyzed.
- **Required Fix:** Update system prompt to rank candidates within batch ("pick the best candidate if safe") and lower `llm_min_confidence` to 20-25.

---

### 3.4 Medium & Low Severity Issues

| Gap ID | Subsystem | Description | Impact | Location |
|---|---|---|---|---|
| **M1** | Database | SQLite WAL mode enabled without `busy_timeout = 5000` or `synchronous = NORMAL` pragmas. | Potential `SQLITE_BUSY` errors during concurrent DB operations. | `src/db/connection.js:6-7` |
| **M2** | Signals | Pumpportal WS `migrate` event branch does not check `seenTokens` map before triggering candidate. | Duplicate migration messages cause duplicate candidate evaluations. | `src/signals/pumpportal.js:307-348` |
| **M3** | Execution | `executeLiveSell` lacks a retry loop (unlike buy path which has 3 retries) and lacks slippage cap. | Transient API failure during sell leaves position un-exited. | `src/execution/router.js:101-109` |
| **M4** | Signals | `monitorPriceAlerts` checks `alert.target_mcap_usd`, but `storePriceAlert` never inserts `target_mcap_usd`. | Dead code branch / missing mcap alert functionality. | `src/signals/priceMonitor.js:80-82` |
| **M5** | Learning | `tighten_sl` regex extraction clamps SL to inverted band `[-15, -12]`. | Inverted SL band logic in dormant parser. | `src/learning/autoApply.js:47` |
| **M6** | Signals | `trenches.js:105` catches DB error with `/* proceed anyway */`, bypassing position guards on DB fail. | Guard bypass during database stress. | `src/signals/trenches.js:105` |
| **L1** | Signals | Variable `cutoff` shadowed inside `handleNewToken`. | Minor code readability footgun. | `src/signals/pumpportal.js:134 vs 143` |
| **L2** | Execution | `outputAmount` can land in DB as empty string `""`. | Minor data quality flaw. | `src/liveExecutor.js:124` |
| **L3** | Signals | Pumpportal `error` event does not explicitly schedule reconnect (relies on `close`). | Reconnect ordering fragility. | `src/signals/pumpportal.js:382-396` |
| **L4** | Signals | Debug log `DEBUG txType=...` left active on hot WS message path. | Log spam and minor overhead. | `src/signals/pumpportal.js:296-299` |

---

## 4. Test Suite Inventory & Verification Deficit

### 4.1 Current Test Coverage Assessment
The project currently has **no standardized automated test runner or test suite** (no `jest`, `vitest`, `mocha`, or `tape` dependencies in `package.json`).

Existing scripts only perform syntax checks or ad-hoc manual verification:
1. `npm run check` (`package.json:8`): Runs `node --check` on `index.js`, `src/app.js`, `src/config.js`, `src/liveExecutor.js`.
2. Standalone manual test scripts:
   - `test_llm.js`: Simple ping test against LLM endpoint.
   - `test_custom.js`: Ad-hoc test for fallback LLM & Pumpportal WS connection.
   - `test_migration_ws.js`: 60-minute logging script for Pumpportal migration events.
   - `test_server.js`: Fetch call test for signal server.
   - `scripts/test-spot-quote.mjs`: Ad-hoc Jupiter quote test.
   - `scripts/test_exit_card.mjs`: Visual exit card render test.

### 4.2 Verification Matrix for Codebase Stabilization

| Component / Subsystem | Required Automated Tests | Verification Command |
|---|---|---|
| **Syntax Verification** | All `.js` and `.mjs` files must pass AST validation. | `npx glob "src/**/*.js" "scripts/**/*.js" "*.js" \| xargs -n 1 node --check` |
| **Database Transactions & Dedup** | Test `createLivePosition` and `createDryRunPosition` dedup guards, risk-sizing, and position counters. | `npm test` (Unit test framework to be added) |
| **Option C Hybrid Filters** | Test candidate filtering for bot>=25% reject, holder deadzone [100, 400] soft flag, dev migrations >=20 soft flag. | Unit tests in `test/filters.test.js` |
| **Jupiter Execution & Slippage** | Mock Jupiter API responses to verify `slippageBps` URL parameter inclusion, retry handling, and balance reconciliation. | Unit tests in `test/execution.test.js` |
| **ESM Imports & Require Bugs** | Verify zero `require()` calls exist in ESM modules (`src/**/*.js`). | `grep -rn "require(" src/` |

---

## 5. Prioritized Stabilization & Remediation Roadmap

Based on severity and real-money impact, the stabilization work should be structured in 4 phases:

```
Phase 1: Real-Money Execution Safety & Critical Fixes (C1, C2, C3, H1, H2, B-4)
Phase 2: Data Integrity, Memory Leak & API Resilience Fixes (H3, H4, M1, M2, M3, M6)
Phase 3: Strategy Tuning & Decision Engine Optimization (B-1, LLM-1, Prompt & Confidence Adjustment)
Phase 4: Test Infrastructure & Automated Verification Suite Setup
```

---

*Report compiled by Explorer 3 (Feature Inventory & Gap Explorer).*
