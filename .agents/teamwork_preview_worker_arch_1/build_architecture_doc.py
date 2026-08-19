import os

doc_content = """# Charon System Architecture & Technical Specification Report

> **Version**: 1.0.0  
> **Target System**: Charon Automated Trading & Decision System (`/root/Kaiser.charon`)  
> **Database Engine**: SQLite 3 (`charon.sqlite`) with WAL mode via `better-sqlite3`  
> **Primary Runtime**: Node.js ES Modules (v18+) & Python 3 ML Subprocess  

---

## 1. Executive Summary

**Charon** is an autonomous, high-throughput Solana token trading engine, multi-source signal aggregator, LLM-driven decision system, and dynamic strategy optimizer. The system is designed to identify, enrich, score, evaluate, execute, and monitor token opportunities in real time while continuously tuning its internal risk and filtering parameters based on trade performance outcomes.

### Core Logic & Data Flow Cycle
1. **Signal Ingestion**: Ingests high-speed market events from PumpPortal WebSocket (`wss://pumpportal.fun`), GMGN token signal APIs, Fee Claim monitors, PumpFun pre-grad monitors, price alert monitors, and central Signal Server HTTP polling.
2. **Concurrency & Deduplication Locks**: Before performing expensive external enrichment or LLM queries, incoming signals are gated by atomic position limits (`canOpenMorePositions()`) and 5 deduplication guards (open position, 4-hour closed position cooldown, 2-hour decision cache, 10-minute candidate window, 24-hour ticker deduplication).
3. **Dynamic Multi-Source Enrichment**: Approved signals undergo two-stage parallel API enrichment across GMGN, Jupiter Ultra, RugCheck, Twitter narrative, and tracked smart wallet exposure.
4. **Scoring & Machine Learning Ingress**: Enriched candidates pass through UTC worst-hours filtering, hard safety constraints, v45 soft scoring (0-150 scale with dynamic thresholds adjusted by time-of-day and open slot count), rule-based pre-scoring, and Python Scikit-Learn ML momentum inference (`predict_momentum.py`).
5. **Macro & Regime Intelligence**: Real-time market weather (`MacroEngine` SOL/USDT trend & 6-hour win rate) and dynamic market cap band performance (`RegimeDetector`) are evaluated and injected into system memory.
6. **LLM Chief Investment Officer (CIO) Decisioning**: Candidates reaching the LLM layer are processed via model-routed prompt templates, combining micro-metrics, macro weather, and active strategy lessons. Resilience is maintained through a multi-tier fallback hierarchy (Primary -> Zyloo -> OpenRouter) and optional Dual-LLM consensus verification.
7. **Execution & State Management**: Approved trades pass fresh re-evaluation (`refreshCandidateForExecution`) and execute via `dry_run` position creation, `confirm` queue for Telegram operator review, or `live` execution (Jupiter Ultra Swap API & Solana VersionedTransaction RPC signing).
8. **Closed-Loop Self-Tuning**: Closed position PnL performance triggers learning summarization, rule extraction, and automated parameter mutations (`autoApplyLessons`) into SQLite `settings` and `strategies` tables, forming a complete self-healing feedback loop.

---

## 2. Complete Mermaid.js System Architecture Diagram

```mermaid
graph TD
    %% Global Styling & Classes %%
    classDef signalFill fill:#1f2937,stroke:#3b82f6,stroke-width:2px,color:#fff;
    classDef enrichFill fill:#1e1b4b,stroke:#6366f1,stroke-width:2px,color:#fff;
    classDef pipeFill fill:#1e293b,stroke:#0ea5e9,stroke-width:2px,color:#fff;
    classDef engineFill fill:#312e81,stroke:#8b5cf6,stroke-width:2px,color:#fff;
    classDef llmFill fill:#4c1d95,stroke:#a855f7,stroke-width:2px,color:#fff;
    classDef execFill fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#fff;
    classDef dbFill fill:#451a03,stroke:#f59e0b,stroke-width:2px,color:#fff;
    classDef learnFill fill:#701a75,stroke:#ec4899,stroke-width:2px,color:#fff;
    classDef tgFill fill:#0f5132,stroke:#20c997,stroke-width:2px,color:#fff;

    subgraph Subsystem_1 ["Subsystem 1: Signals & Ingestion Layer"]
        PP["PumpPortal WS Client<br/>(wss://pumpportal.fun)<br/>New Token & Migration Listener"] :::signalFill
        GMGN_SIG["GMGN Token Signal Poller<br/>(src/signals/gmgnSignal.js)"] :::signalFill
        PUMP_PRE["PumpFun Pre-Grad Poller<br/>(src/signals/pumpfunPregrad.js)"] :::signalFill
        FEE_CLAIM["Fee Claim Monitor<br/>(src/signals/feeClaim.js)"] :::signalFill
        PRICE_MON["Price Alert Monitor<br/>(src/signals/priceMonitor.js)"] :::signalFill
        SIG_SERVER["Signal Server Client<br/>(src/signals/serverClient.js)"] :::signalFill
    end

    subgraph Subsystem_2 ["Subsystem 2: Dynamic Enrichment Layer"]
        GMGN_API["GMGN Token API<br/>MarketCap, Liquidity, Holder Stats"] :::enrichFill
        JUP_API["Jupiter Ultra API<br/>Asset Info, Holders, Audit & Flow Stats"] :::enrichFill
        RUG_CHECK["RugCheck Security API<br/>Audit Scores & Mint Risk"] :::enrichFill
        TWITTER_EN["Twitter / Narrative Tracker<br/>Tweet Velocity & Engagement"] :::enrichFill
        WALLET_EN["Saved Wallet Exposure Tracker<br/>Smart Wallet Clustering"] :::enrichFill
    end

    subgraph Subsystem_3 ["Subsystem 3: Core Pipeline Orchestrator & Scoring Engine"]
        ORCH["Pipeline Orchestrator<br/>(processCandidateFromSignals)"] :::pipeFill
        POS_LOCK["Position Lock Guard<br/>(canOpenMorePositions)"] :::pipeFill
        DEDUP["5-Tier Dedup & Cooldown Checks<br/>(Open, Closed 4h, Cache 2h, Candidate 10m, Symbol 24h)"] :::pipeFill
        CB["Candidate Builder<br/>(buildCandidate & computeSoftScore)"] :::pipeFill
        PRE_SCORE["Pre-Scorer<br/>(Rule-Based Check)"] :::pipeFill
        MOM_FILTER["Python ML Momentum Subprocess<br/>(predict_momentum.py Scikit-Learn Model)"] :::pipeFill
    end

    subgraph Subsystem_4 ["Subsystem 4: Regime & Macro Intelligence Engines"]
        MACRO["MacroEngine<br/>Binance SOL/USDT & 6h Win-Rate Weather Tracker"] :::engineFill
        REGIME["RegimeDetector<br/>24h Mcap Band Classifier & Strategy Sizing"] :::engineFill
    end

    subgraph Subsystem_5 ["Subsystem 5: LLM Integration & Decision Consensus Engine"]
        LLM_ROUTER["LLM Router & Model Selector<br/>(selectModelForRoute & CIO Prompt)"] :::llmFill
        LLM_PRIMARY["Primary LLM Provider<br/>(CIO Prompt + Macro/Regime Memory)"] :::llmFill
        LLM_CHEAP["Cheap LLM Provider<br/>(Batch Signal Screening)"] :::llmFill
        LLM_FALLBACK["Fallback Hierarchy<br/>(Zyloo API -> OpenRouter API)"] :::llmFill
        DUAL_CONS["Dual LLM Consensus Evaluator<br/>(Secondary Verification)"] :::llmFill
    end

    subgraph Subsystem_6 ["Subsystem 6: Execution Router & Jupiter Executor"]
        EXEC_ROUTER["Execution Router<br/>(executeLiveBuy / executeLiveSell / Mode Switcher)"] :::execFill
        REFRESH_GUARD["Fresh Execution Refresh Guard<br/>(refreshCandidateForExecution)"] :::execFill
        JUP_EXECUTOR["Jupiter Executor<br/>(Order + Sign + Execute Swap Endpoint)"] :::execFill
        SOL_RPC["Solana RPC & Web3 Keypair<br/>(VersionedTransaction Signing & Broadcast)"] :::execFill
    end

    subgraph Subsystem_7 ["Subsystem 7: SQLite Database Schema & State Locks"]
        TBL_POS["dry_run_positions<br/>Open / Closed Positions & State Machine"] :::dbFill
        TBL_CAND["candidates<br/>Ingested Candidate Snapshots"] :::dbFill
        TBL_DEC["llm_decisions<br/>Decision History & Confidence Logs"] :::dbFill
        TBL_SETT["settings & strategies<br/>Dynamic Runtime Config & Multi-Strategy Config"] :::dbFill
        TBL_LEARN["learning_lessons & learning_applied<br/>Active Lessons & Mutation History"] :::dbFill
        TBL_INTENT["trade_intents<br/>Operator Trade Approval Queue"] :::dbFill
    end

    subgraph Subsystem_8 ["Subsystem 8: Auto-Learn & Self-Tuning Engine"]
        LEARN_SUM["Learning Summarizer<br/>(summarizeLearningWindow)"] :::learnFill
        LESSON_GEN["Lesson Generator<br/>(generateLessons)"] :::learnFill
        AUTO_APPLY["Auto-Learn Mutator<br/>(autoApplyLessons - Dynamic DB Mutator)"] :::learnFill
    end

    subgraph Subsystem_9 ["Subsystem 9: Telegram UI & Exit Card Renderer"]
        TG_BOT["Telegram Bot Interface<br/>(Commands: /confirm, /reject, /status, /settings, /learning)"] :::tgFill
        TG_SEND["Telegram Alert Service<br/>(Candidate Alerts, Batch Reveals, Intents)"] :::tgFill
        CARD_GEN["PNG Exit Card Renderer<br/>(node-canvas 800x420 Card Visuals)"] :::tgFill
    end

    %% Ingestion Signals -> Pipeline Orchestrator %%
    PP -->|wss New Token / Migration Event| ORCH
    GMGN_SIG -->|Smart Money Signal| ORCH
    PUMP_PRE -->|Pre-Graduation Candidate| ORCH
    FEE_CLAIM -->|Fee Claim Trigger| ORCH
    PRICE_MON -->|Dip Buy Trigger| ORCH
    SIG_SERVER -->|HTTP Poll Batch Signals| ORCH

    %% Orchestrator Gating & Dedup %%
    ORCH -->|1. Check Open Position Limit| POS_LOCK
    POS_LOCK <-->|Read Open Position Count| TBL_POS
    ORCH -->|2. Check Cooldowns & Cache| DEDUP
    DEDUP <-->|Query Cooldowns & Mints| TBL_POS
    DEDUP <-->|Query Decision Cache| TBL_DEC

    %% Dynamic Enrichment Flow %%
    ORCH -->|3. Build Candidate| CB
    CB -->|Fetch MarketCap, Liquidity, Holder Stats| GMGN_API
    CB -->|Fetch Asset Info, Holders, Audit & Flow| JUP_API
    CB -->|Fetch Mint Security Audit| RUG_CHECK
    CB -->|Fetch Tweet Velocity & Hype| TWITTER_EN
    CB -->|Cross-Reference Smart Wallets| WALLET_EN
    CB -->|Persist Candidate Snapshot| TBL_CAND

    %% Scoring & ML Filtering Flow %%
    CB -->|4. Hard Filters & v45 Soft Score| PRE_SCORE
    PRE_SCORE -->|5. Pre-Scoring Check| MOM_FILTER
    MOM_FILTER -->|6. Execute Python Subprocess predict_momentum.py| LLM_ROUTER

    %% Macro & Regime Context Ingestion %%
    MACRO -->|Fetch Live SOL/USDT Price| BINANCE_API["Binance Spot API"]
    MACRO <-->|Query 6h Closed Trade Win-Rate| TBL_POS
    MACRO -->|Update current_macro_state| TBL_SETT
    REGIME -->|Update current_regime_summary & Mcap Sizing| TBL_SETT
    TBL_SETT -.->|Inject Macro & Regime Memory| LLM_PRIMARY

    %% LLM Processing & Fallback Hierarchy %%
    LLM_ROUTER -->|Route PumpPortal Signals| LLM_PRIMARY
    LLM_ROUTER -->|Route Batch Signals| LLM_CHEAP
    LLM_PRIMARY -.->|On Timeout / HTTP 401/402/5xx| LLM_FALLBACK
    LLM_PRIMARY -->|If dual_llm_consensus enabled| DUAL_CONS
    LLM_PRIMARY -->|Store Verdict & Confidence| TBL_DEC
    LLM_ROUTER <-->|Inject Active Strategy Lessons| TBL_LEARN

    %% Execution Routing %%
    TBL_DEC -->|Approved BUY Verdict| EXEC_ROUTER
    EXEC_ROUTER -->|Re-verify Fresh Data| REFRESH_GUARD
    EXEC_ROUTER <-->|Read trading_mode: dry_run / confirm / live| TBL_SETT
    
    EXEC_ROUTER -->|dry_run Mode| TBL_POS
    EXEC_ROUTER -->|confirm Mode| TBL_INTENT
    EXEC_ROUTER -->|live Mode: Execute Swap| JUP_EXECUTOR
    
    JUP_EXECUTOR -->|Request Quote & Swap Transaction| JUP_API
    JUP_EXECUTOR -->|Sign VersionedTransaction| SOL_RPC
    JUP_EXECUTOR -->|Record Live Position| TBL_POS

    %% Auto-Learn Closed-Loop Feedback %%
    TBL_POS -.->|Sample 12h Closed Positions| LEARN_SUM
    LEARN_SUM --> LESSON_GEN
    LESSON_GEN --> TBL_LEARN
    TBL_LEARN -->|Trigger AutoApply every 6h| AUTO_APPLY
    AUTO_APPLY -->|Mutate Dynamic Settings & Strategies SQL| TBL_SETT
    TBL_SETT -.->|Dynamic Parameter Override| CB
    TBL_SETT -.->|Dynamic Parameter Override| ORCH

    %% Telegram UI & Visuals Feedback %%
    EXEC_ROUTER -->|Send Open Alert| TG_SEND
    TBL_INTENT -->|Send Interactive Intent Alert| TG_SEND
    AUTO_APPLY -->|Send Auto-Learn Update Alert| TG_SEND
    TG_BOT <-->|Operator Commands: /confirm, /reject| TBL_INTENT
    TG_BOT <-->|Modify Runtime Settings| TBL_SETT
    TG_SEND --> CARD_GEN
```

---

## 3. Subsystem Inventory Matrix

| # | Subsystem / Component Area | Primary Source Files | Primary Responsibilities | Key Configuration / Environment Parameters | Module Dependencies |
|---|---------------------------|----------------------|--------------------------|--------------------------------------------|---------------------|
| **1** | **Signals & Ingestion Layer** | `src/signals/pumpportal.js`<br>`src/signals/gmgnSignal.js`<br>`src/signals/macroEngine.js`<br>`src/signals/serverClient.js`<br>`src/signals/feeClaim.js`<br>`src/signals/graduated.js`<br>`src/signals/narrativeTracker.js`<br>`src/signals/priceMonitor.js`<br>`src/signals/pumpfunPregrad.js`<br>`src/signals/smartMoney.js`<br>`src/signals/trenches.js`<br>`src/signals/trending.js` | Real-time WebSocket and HTTP signal ingestion for new Solana token launches, bonding curve migrations, smart money signals, fee distributions, and central signal server polling. | `PUMPPORTAL_API_KEY`<br>`PUMPPORTAL_ENABLED`<br>`SIGNAL_SERVER_URL`<br>`SIGNAL_SERVER_KEY`<br>`SIGNAL_POLL_MS`<br>`gmgn_signal_enabled` | `ws`<br>`axios`<br>`src/enrichment/gmgn.js`<br>`src/telegram/send.js`<br>`src/db/settings.js` |
| **2** | **Dynamic Enrichment Layer** | `src/enrichment/gmgn.js`<br>`src/enrichment/jupiter.js`<br>`src/enrichment/rugcheck.js`<br>`src/enrichment/twitter.js`<br>`src/enrichment/wallets.js` | Parallel token metadata, market cap, liquidity, holder distribution, token security audits (bot holders %, top 10 %, dev migrations), chart candle context, wallet cluster exposure, and Twitter narrative enrichment with TTL caching and rate-limit backoffs. | `GMGN_API_KEY`<br>`GMGN_CACHE_TTL_MS`<br>`GMGN_ENABLED`<br>`gmgn_request_delay_ms`<br>`gmgn_max_retries` | `axios`<br>`node:crypto`<br>`src/utils.js`<br>`src/db/settings.js` |
| **3** | **Core Pipeline Orchestrator & Scoring Engine** | `src/pipeline/orchestrator.js`<br>`src/pipeline/candidateBuilder.js`<br>`src/pipeline/preScorer.js`<br>`src/pipeline/momentumFilter.js`<br>`src/pipeline/stateTransition.js`<br>`src/pipeline/predict_momentum.py` | Position lock checking (`canOpenMorePositions`), 5-tier candidate deduplication, candidate snapshot building, hard filtering, v45 soft scoring, pre-scoring, Python ML momentum inference via subprocess, and candidate status transition. | `min_liquidity_usd`<br>`trending_min_swaps`<br>`trending_max_rug_ratio`<br>`trending_max_bundler_rate`<br>`token_age_max_ms`<br>`max_open_positions` | `predict_momentum.py`<br>`models/momentum_model.pkl`<br>`models/momentum_scaler.pkl`<br>`models/momentum_features.json`<br>`src/enrichment/`<br>`src/db/` |
| **4** | **Regime & Macro Intelligence Engines** | `src/signals/macroEngine.js`<br>`src/evolution/regimeDetector.js`<br>`src/evolution/arena.js`<br>`src/evolution/loop.js`<br>`src/evolution/migrationEvo.js`<br>`src/evolution/optimizer.js`<br>`src/evolution/strategyFactory.js`<br>`src/evolution/tradeDna.js` | SOL price trend tracking via Binance API, 6h/24h closed trade win-rate classification ('HOT' vs 'COLD' market weather), 24h market cap band analysis ('0-25k', '25k-50k', '50k-100k', '100k+'), dynamic strategy parameter tuning, and genetic trade DNA evolution. | 24h & 6h rolling windows, market cap band thresholds, SOL/USDT Binance price feed | `better-sqlite3`<br>`src/db/connection.js`<br>`src/db/settings.js` |
| **5** | **LLM Integration & Decision Consensus Engine** | `src/pipeline/llm.js`<br>`src/pipeline/predict_momentum.py` | Formats candidate batches into compact JSON prompts, injects regime memory & macro weather, routes queries to route-specific models, executes multi-provider fallback hierarchy (Primary -> Zyloo -> OpenRouter) and dual LLM consensus, and normalizes decision output (`BUY`, `WATCH`, `PASS`, confidence, risk list, suggested TP/SL). | `ENABLE_LLM`<br>`LLM_API_KEY`<br>`LLM_BASE_URL`<br>`LLM_MODEL`<br>`LLM_MODEL_CHEAP`<br>`LLM_FALLBACK_BASE_URL`<br>`LLM_FALLBACK_API_KEY`<br>`LLM_FALLBACK_MODEL`<br>`LLM_OPENROUTER_API_KEY`<br>`LLM_OPENROUTER_MODEL`<br>`LLM_TIMEOUT_MS`<br>`llm_min_confidence` | `axios`<br>`src/db/decisions.js`<br>`src/signals/trending.js`<br>`src/db/settings.js` |
| **6** | **Execution Router & Jupiter Executor** | `src/execution/router.js`<br>`src/liveExecutor.js`<br>`src/execution/positions.js` | Trade routing across `dry_run`, `confirm`, and `live` modes. SOL reserve checks (`LIVE_MIN_SOL_RESERVE_LAMPORTS`), retry loop (up to 3 attempts), Jupiter Ultra / Swap API ordering and VersionedTransaction signing via `@solana/web3.js`, balance reconciliation on timeout, and `FAILED_ENTRY` position auditing. | `SOLANA_PRIVATE_KEY`<br>`SOLANA_RPC_URL`<br>`JUPITER_API_KEY`<br>`JUPITER_SWAP_BASE_URL`<br>`JUPITER_SLIPPAGE_BPS`<br>`LIVE_MIN_SOL_RESERVE_LAMPORTS` | `@solana/web3.js`<br>`bs58`<br>`axios`<br>`src/db/positions.js`<br>`src/db/intents.js`<br>`src/telegram/send.js` |
| **7** | **SQLite Database Schema & State Locks** | `src/db/positions.js`<br>`src/db/connection.js`<br>`src/db/candidates.js`<br>`src/db/decisions.js`<br>`src/db/intents.js`<br>`src/db/settings.js` | SQLite WAL database management (`charon.sqlite` across 19 tables/indexes), position state machine ('open', 'closed', 'pending'), pending position counter, risk-adjusted & source-weighted sizing, regime multipliers, 24h closed position re-entry dedup, 7-day past-win block guard, and atomic position limit checks (`openPositionCount()` + `canOpenMorePositions()`). | `DB_PATH`<br>`max_open_positions`<br>`dry_run_buy_sol`<br>Default strategies ('sniper', 'dip_buy', 'smart_money', 'degen') | `better-sqlite3`<br>`src/config.js`<br>`src/utils.js`<br>`src/pipeline/llm.js` |
| **8** | **Auto-Learn & Self-Tuning Engine** | `src/learning/autoApply.js`<br>`src/learning/lessons.js`<br>`src/learning/summary.js`<br>`src/learning/report.js`<br>`src/learning/commands.js`<br>`scripts/auto_learn.mjs` | Automated trade history performance analysis, rule extraction from active lessons (<7 days recency), type validation & recency gating (30 closed position minimum), 24h idempotency enforcement per strategy/parameter, automatic mutation of `settings` and `strategies` SQL tables, and audit logging in `learning_applied`. | 30 closed position minimum, 7-day recency cutoff, 24h action cooldown, 0.7 minConfidence threshold | `better-sqlite3`<br>`src/db/connection.js`<br>`src/utils.js` |
| **9** | **Telegram UI & Exit Card Renderer** | `src/telegram/bot.js`<br>`src/telegram/callbacks.js`<br>`src/telegram/commands.js`<br>`src/telegram/dailyReport.js`<br>`src/telegram/format.js`<br>`src/telegram/input.js`<br>`src/telegram/menus.js`<br>`src/telegram/report.js`<br>`src/telegram/send.js`<br>`src/visuals/exitCard.js`<br>`scripts/test_exit_card.mjs` | Operator notifications, command handling (`/start`, `/status`, `/positions`, `/settings`, `/report`, `/learning`), inline keyboard interactive menus (trade confirmation callbacks, parameter updates), HTML message formatting, and server-side PNG exit card rendering (800x420 canvas graphics for trade closure PNL visual cards). | `TELEGRAM_BOT_TOKEN`<br>`TELEGRAM_CHAT_ID` | `node-telegram-bot-api`<br>`canvas`<br>`src/db/settings.js`<br>`src/db/positions.js` |

---

## 4. Subsystem 1: Signals & Ingestion Layer

The **Signals & Ingestion Layer** acts as the high-speed gateway receiving real-time token events across multiple Solana signal providers.

- **`src/signals/pumpportal.js`**: Establishes a persistent WebSocket connection to `wss://pumpportal.fun/api/data`. Listens for `subscribeNewToken` (creation events) and `subscribeMigration` (Raydium migration events). Maintains an active tracking map of up to 50 bonding curve tokens. Polls GMGN every 30 seconds (`checkBondingCurve`) to track market cap progression. When market cap reaches $25,000 or a `migrate` event is received via WebSocket, `graduateToken()` registers the candidate and invokes `candidateHandler(processCandidateFromSignals)` with route `pumpportal_graduated`. Features 5-minute silence and disconnect monitors with automated Telegram alerts.
- **`src/signals/gmgnSignal.js`**: Polls GMGN API `/v1/market/token_signal` (POST with `signal_type: [12]`). Implements an in-memory 5-minute deduplication window (`gmgnSignals`). Mints ending with `pump` are dispatched to `candidateHandler` under route `gmgn_smart_money`.
- **`src/signals/serverClient.js`**: Connects to the central Signal Server via HTTP GET (`/api/signals?limit=100&minSources=2`). Maintains global maps (`graduated`, `trending`). Filters signals against configured strategy parameters (`min_source_count`, `require_fee_claim`, `token_age_max_ms`). Passes multi-source candidates to `candidateHandler` or queues them into `price_alerts` for `wait_for_dip` entry modes.
- **`src/signals/feeClaim.js` & `src/signals/pumpfunPregrad.js`**: Specialized signal ingestors tracking creator fee disbursements and pre-graduation bonding curve velocity.
- **`src/signals/priceMonitor.js`**: Dip-buy entry monitor that periodically evaluates token price pullbacks against target dip buy conditions.

---

## 5. Subsystem 2: Dynamic Enrichment Layer

The **Dynamic Enrichment Layer** fetches multi-dimensional market, holder, social, and security metrics in parallel before scoring.

- **`src/enrichment/gmgn.js`**: Interacts with `https://openapi.gmgn.ai`. Utilizes a global request queue (`enqueueGmgn`), enforcing minimum delay pacing (`gmgn_request_delay_ms`, default 2500ms). Automatically handles rate limits (HTTP 429) and Cloudflare managed challenges (HTTP 403) using exponential backoff (`setGmgnBackoff`). Caches response payloads in memory (`gmgnCache`) with configurable TTL (`GMGN_CACHE_TTL_MS`).
- **`src/enrichment/jupiter.js`**: Queries Jupiter Data API (`https://datapi.jup.ag`) and Price API (`https://lite-api.jup.ag`).
  - `fetchJupiterAsset`: Extracts token metadata, audit indicators (bot holder count & percentage, top 10 holder concentration, dev migrations, insider percentage), and transaction stats across 5m, 1h, 6h, and 24h windows.
  - `fetchJupiterHolders`: Analyzes top 20 holder concentration and calculates max single holder percentage.
  - `fetchJupiterChartContext`: Evaluates 5m, 1h, and 4h candle windows to derive distance from ATH (All-Time High) and range-high risk factors.
- **`src/enrichment/rugcheck.js`**: Fetches security audit reports from RugCheck API, evaluating mint authority, freeze authority, and liquidity LP burn status.
- **`src/enrichment/twitter.js`**: Tracks viral tweet velocity, follower counts, and engagement scores for token narrative verification.
- **`src/enrichment/wallets.js`**: Cross-references holder addresses against the `saved_wallets` SQLite table to measure smart wallet cluster exposure.

---

## 6. Subsystem 3: Core Pipeline Orchestrator & Scoring Engine

The **Core Pipeline Orchestrator** controls candidate flow, concurrency locks, deduplication, hard filtering, soft scoring, and ML momentum prediction.

1. **Concurrency Gating (`src/pipeline/orchestrator.js`)**:
   - Executes `canOpenMorePositions()` at entry. Compares `openPositionCount()` (active SQLite open positions + in-memory `pendingPositionCount`) against `max_open_positions` (from `settings` table, default 3). If capacity is reached, candidate processing aborts immediately.
2. **5-Tier Deduplication Protocol**:
   - **Tier 1 (Open Position Guard)**: Rejects candidates with active open positions.
   - **Tier 2 (Closed Cooldown Guard)**: Rejects mints closed within the last 4 hours (`CLOSED_COOLDOWN_HOURS`).
   - **Tier 3 (Candidate Window Guard)**: Rejects mints processed within the last 10 minutes (`CANDIDATE_DEDUP_MINUTES`).
   - **Tier 4 (Symbol Cooldown Guard)**: Rejects duplicate tickers traded within the last 24 hours (`SYMBOL_COOLDOWN_HOURS`).
   - **Tier 5 (Decision Cache Guard)**: Rejects candidates with active decision cache entries within 2 hours (`DECISION_CACHE_TTL_HOURS`).
3. **Hard Filtering (`src/pipeline/candidateBuilder.js`)**:
   - Evaluates UTC worst-hours window (blocks hours 11-14, 20, 22), fee claim requirements, minimum liquidity ($5,000 floor), minimum market cap ($10,000 floor), bot holder death zone (>= 40%), and organic buyer ratios.
4. **v45 Soft Scoring Engine (`computeSoftScore`)**:
   - Computes candidate score (0 to 150) based on liquidity, holder distribution, smart degen count, dev migrations, and organic score.
   - **Dynamic Soft Thresholding (`softScoreThreshold`)**: Base threshold is 50. Tightens (+15) during quiet UTC hours (06:00-14:00 UTC) and tightens (+10) when open position capacity is near max (`openCount >= maxOpen - 1`). Loosens (-10) when the system has 0 open positions.
5. **Rule-Based Pre-Scoring (`src/pipeline/preScorer.js`)**:
   - Evaluates candidate parameters against static risk heuristics to reject weak candidates before calling external LLM APIs.
6. **Python ML Momentum Prediction (`src/pipeline/momentumFilter.js` & `predict_momentum.py`)**:
   - Spawns a Python 3 subprocess running `predict_momentum.py`. Passes candidate JSON over `stdin`.
   - The Python script loads Scikit-Learn model `models/momentum_model.pkl`, StandardScaler `models/momentum_scaler.pkl`, and feature definitions `models/momentum_features.json`. Evaluates 35+ numerical features (price velocity, volume ratios, smart degen count, top holder concentration, rug ratio).
   - Returns momentum probability score (0.0 to 1.0) over `stdout`. Rejects candidates scoring below `momentum_threshold` (default 0.5).

---

## 7. Subsystem 4: Regime & Macro Intelligence Engines

The **Regime & Macro Intelligence Engines** provide macro-environmental awareness and dynamic regime adjustments.

- **`src/signals/macroEngine.js`**:
  - Periodically fetches live SOL/USDT spot price from Binance API (`ticker/price?symbol=SOLUSDT`).
  - Queries `dry_run_positions` table for closed trade win rate over the last 6 hours:
    $$\\text{Win Rate} = \\frac{\\text{Count}(\\text{pnl\\_percent} > 0)}{\\text{Total Closed Positions (6h)}}$$
  - Classifies market weather as `HOT` (win rate >= 50%) or `COLD` (win rate < 50%).
  - Formats macro summary text (e.g. `MACRO STATE: SOL is BULLISH at $154.20. Global win rate is 58.3%. Market weather is HOT.`) and updates SQLite `settings` table under key `current_macro_state`.
- **`src/evolution/regimeDetector.js`**:
  - Analyzes 24-hour closed positions from `dry_run_positions`, grouping trades into 4 market cap bands (`0-25k`, `25k-50k`, `50k-100k`, `100k+`).
  - Identifies the highest performing market cap band. If best band WR >= 50% and avg PnL > 0, sets regime to `HOT (Aggressive)` with 0.1 SOL default position size; otherwise `COLD (Safe)` with 0.05 SOL size.
  - Updates `min_mcap_usd` and `max_mcap_usd` in `strategies` table for the `sniper` strategy and writes `current_regime_summary` to `settings`.
- **Regime Position Size Multiplier (`src/db/positions.js` - `getRegimeMultiplier`)**:
  - Dynamically adjusts position sizing based on 24-hour closed trade win rate:
    - **Hot Market** (WR >= 40%): **1.5x** size multiplier.
    - **Normal Market** (WR >= 30%): **1.0x** size multiplier.
    - **Cold Market** (WR >= 20%): **0.5x** size multiplier.
    - **Ice Market** (WR < 20%): **0.25x** size multiplier.

---

## 8. Subsystem 5: LLM Integration & Decision Consensus Engine

The **LLM Integration Engine** (`src/pipeline/llm.js`) uses Large Language Models as Chief Investment Officer (CIO) evaluators.

- **Route-Based Model Selection (`selectModelForRoute`)**:
  - Real-time PumpPortal signals route to primary high-capability model (`LLM_MODEL`).
  - Signal Server batch signals route to lower-cost model (`LLM_MODEL_CHEAP`).
- **CIO System Prompt & Context Injection**:
  - System prompt includes CIO persona, candidate micro-metrics, active strategy lessons from `learning_lessons`, `current_macro_state` from MacroEngine, and `current_regime_summary` from RegimeDetector.
- **Resilient Multi-Tier Fallback Hierarchy**:
  - Requests attempt Primary Endpoint (`LLM_BASE_URL` / `LLM_API_KEY`).
  - On timeout or HTTP errors (401, 402, 412, 5xx), automatically falls back to **Zyloo API** (`LLM_FALLBACK_BASE_URL`).
  - On Zyloo failure, falls back to **OpenRouter API** (`https://openrouter.ai/api/v1`).
- **Confidence Sizing & Dual-LLM Consensus**:
  - `effectivePositionSizeSol`: Linearly scales position size based on LLM confidence score:
    $$\\text{Effective Size} = \\text{Base Size} \\times \\left( \\frac{\\text{LLM Confidence}}{100} \\right)$$
  - **Dual-LLM Consensus** (`dual_llm_consensus` setting): If enabled, a secondary LLM model evaluates `BUY` verdicts independently. If the secondary model disagrees, the decision is downgraded to `WATCH`.
  - Normalizes verdict output (`BUY`, `WATCH`, `PASS`) and enforces `llm_min_confidence` threshold from SQLite `settings`.

---

## 9. Subsystem 6: Execution Router & Jupiter Executor

The **Execution Layer** manages trade routing, pre-flight safety checks, transaction signing, and execution monitoring.

- **Execution Router (`src/execution/router.js`)**:
  - Operates across 3 system trading modes (`trading_mode` setting):
    - `dry_run`: Simulates entry and records virtual position in `dry_run_positions`.
    - `confirm`: Queues trade intent in `trade_intents` table and sends interactive Telegram message for human operator approval.
    - `live`: Routes execution to Jupiter Executor (`src/liveExecutor.js`).
  - **Freshness Guard (`refreshCandidateForExecution`)**: Re-queries market cap and liquidity immediately prior to execution to prevent execution on stale signals.
- **Jupiter Executor (`src/liveExecutor.js`)**:
  - Verifies minimum SOL wallet balance (`LIVE_MIN_SOL_RESERVE_LAMPORTS` reserve protection).
  - Requests quote and swap order from Jupiter Ultra API (`/order` and `/execute`).
  - Encodes slippage parameters (`JUPITER_SLIPPAGE_BPS`).
  - Signs `VersionedTransaction` locally using Solana Web3 `@solana/web3.js` Keypair (`SOLANA_PRIVATE_KEY`).
  - Broadcasts signed transaction to Solana RPC (`SOLANA_RPC_URL`).
  - Retries up to 3 times on entry failure (`ENTRY_MAX_ATTEMPTS = 3`).
  - On fatal execution failure, logs a `FAILED_ENTRY` audit record in `dry_run_positions`.

---

## 10. Subsystem 7: SQLite Database Schema & State Locks

The database module (`src/db/connection.js`) initializes `charon.sqlite` using `better-sqlite3` with Write-Ahead Logging (`PRAGMA journal_mode = WAL`).

### Core Tables & Schema Breakdown
1. **`settings`**: Dynamic system key-value configuration (`trading_mode`, `max_open_positions`, `current_macro_state`, `current_regime_summary`, `llm_min_confidence`, `dry_run_buy_sol`, `dual_llm_consensus`).
2. **`strategies`**: Strategy definitions (`sniper`, `dip_buy`, `smart_money`, `degen`) and JSON configurations (`config_json`).
3. **`candidates`**: Full JSON snapshots of ingested candidates and enrichment metrics.
4. **`dry_run_positions`**: Main position state table (`id`, `symbol`, `mint`, `status`, `size_sol`, `entry_mcap`, `exit_mcap`, `pnl_sol`, `pnl_percent`, `exit_reason`, `execution_mode`, `opened_at_ms`, `closed_at_ms`).
5. **`dry_run_trades`**: Transaction execution ledger linked to positions.
6. **`llm_decisions`**: Historical record of LLM prompts, model responses, confidence ratings, and decision verdicts.
7. **`learning_lessons` & `learning_applied`**: Active self-tuning lessons and audit trail of applied parameter modifications.
8. **`trade_intents`**: Pending queue for operator trade confirmation callbacks.
9. **`saved_wallets`**: Tracked smart wallet address repository.

### Atomic State Locks & Safety Guards
- **Atomic Concurrency Lock (`canOpenMorePositions`)**: Combines active SQLite open positions and `pendingPositionCount` memory counter within transaction boundaries.
- **7-Day Winning Trade Re-entry Guard (`WIN_BLOCK_DAYS = 7`)**: Inside `createDryRunPosition` and `createLivePosition` atomic transactions, queries historical winning positions for the target mint:
  $$\\text{Block trade if } \\exists \\text{ position with } \\text{mint} = M \\text{ AND } \\text{pnl\\_percent} > 0 \\text{ within past 7 days.}$$

---

## 11. Subsystem 8: Auto-Learn & Self-Tuning Engine

The **Auto-Learn Engine** (`src/learning/autoApply.js` & `scripts/auto_learn.mjs`) provides closed-loop self-tuning capabilities.

```
+---------------------+      +---------------------+      +---------------------+
|  Closed Positions   | ---> |  Lesson Generator   | ---> |   Active Lessons    |
| (dry_run_positions) |      | (generateLessons.js)|      |  (learning_lessons) |
+---------------------+      +---------------------+      +---------------------+
                                                                     |
                                                                     v
+---------------------+      +---------------------+      +---------------------+
| Dynamic Settings &  | <--- | Auto-Learn Mutator  | <--- |   Recency & Count   |
| Strategies SQL DB   |      |   (autoApply.js)    |      |  Gating Validation  |
+---------------------+      +---------------------+      +---------------------+
```

- **Execution Interval**: `runPeriodicLearning` runs every 6 hours via `src/app.js`.
- **Gating Rules**:
  - **Minimum Closed Positions**: Requires >= 30 closed positions in DB.
  - **Lesson Recency Gate**: Filters lessons created within the last 7 days (`created_at_ms >= Date.now() - 7 * 86400 * 1000`).
  - **24-Hour Idempotency Gate**: Checks `learning_applied` table to ensure a specific parameter/strategy combination has not been mutated within the last 24 hours.
  - **Confidence Floor**: Requires lesson confidence score >= 0.7.
- **Database Mutation Target**: Mutates `settings` table (`INSERT INTO settings ... ON CONFLICT DO UPDATE`) and `strategies` JSON configuration (`config_json`). Adjusts `default_sl_percent`, `default_tp_percent`, `llm_min_confidence`, `min_liquidity_usd`, `max_mcap_usd`.

---

## 12. Subsystem 9: Telegram UI & Exit Card Renderer

The **Telegram Subsystem** (`src/telegram/`) provides real-time operator alerts and command capabilities.

- **Interactive Bot Interface (`src/telegram/bot.js` & `commands.js`)**:
  - `/start`: Displays main dashboard menu.
  - `/status`: Returns live system metrics, active mode, open position count, and SOL balance.
  - `/positions`: Lists currently open positions with real-time PnL.
  - `/settings`: Interactive inline keyboard menu for modifying runtime parameters (`trading_mode`, `max_open_positions`, `llm_min_confidence`).
  - `/learning`: Displays recent auto-learn runs and applied lesson history.
  - `/confirm <intentId>` & `/reject <intentId>`: Human-in-the-loop trade execution approvals.
- **Server-Side PNG Exit Card Renderer (`src/visuals/exitCard.js`)**:
  - Uses `node-canvas` to render high-resolution 800x420 PNG exit cards upon position closure.
  - Visual styling includes status badges (`CLOSED`, `WIN`, `LOSS`, `RUG`), token symbol, deposited SOL, PnL %, PnL SOL, hold duration, entry/exit market caps, strategy name, and trading mode.
  - Verified via test script `scripts/test_exit_card.mjs`.

---

## 13. Verification Protocol

To independently verify the syntax, integrity, and rendering performance of the Charon system architecture:

### 1. Run Linter Inspection
Verify that all core JavaScript source files compile without syntax errors or undeclared variable references:
```bash
cd /root/Kaiser.charon
node lint.cjs
```
*Expected Result*: Process completes with exit code `0` and outputs no syntax or lint errors.

### 2. Run Exit Card Visual Renderer Test
Verify that the `node-canvas` graphics engine correctly generates valid PNG binary cards for trade outcomes (`profit`, `loss`, `rug`):
```bash
cd /root/Kaiser.charon
node scripts/test_exit_card.mjs
```
*Expected Output*:
```
[profit] OK  /tmp/test_exit_card.png  62060 bytes  800x420  depth=8 colorType=6
[loss] OK  /tmp/test_exit_card_loss.png  63633 bytes  800x420  depth=8 colorType=6
[rug] OK  /tmp/test_exit_card_rug.png  63285 bytes  800x420  depth=8 colorType=6
```
Process exits with code `0`.
"""

target_path = "/root/Kaiser.charon/charon_architecture.md"
with open(target_path, "w", encoding="utf-8") as f:
    f.write(doc_content)

print(f"Successfully generated {target_path} with {len(doc_content)} characters and {len(doc_content.splitlines())} lines.")
