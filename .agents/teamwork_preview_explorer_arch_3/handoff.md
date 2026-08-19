# Handoff Report — Explorer 3: Charon Logic Connections & Mermaid Diagram Design

## 1. Observation

A comprehensive codebase deep dive of `/root/Kaiser.charon/src` (comprising 62 JavaScript ES Module files, Python ML scripts, and SQLite database schemas) was conducted to map component control flows, influence mechanisms, state locks, parameter feedback loops, and visual architecture layout.

### Verbatim Code Evidence & Component Locations:

1. **Signals Ingestion Layer (`src/signals/`)**:
   - `src/signals/pumpportal.js` (lines 8-225, 283-349): Maintains WebSocket connection (`wss://pumpportal.fun/api/data`), listens for `create` and `migrate` events. On `migrate`, triggers `graduateToken()` which registers candidate in `graduated` Map and passes candidate to `candidateHandler(processCandidateFromSignals)` with route `pumpportal_graduated`.
   - Other sources (`src/signals/trenches.js`, `src/signals/graduated.js`, `src/signals/trending.js`, `src/signals/pumpfunPregrad.js`, `src/signals/priceMonitor.js`, `src/signals/serverClient.js`) feed candidates into `processCandidateFromSignals` in `src/pipeline/orchestrator.js`.

2. **SQLite Position Lock & State Gating (`src/db/positions.js` & `src/pipeline/orchestrator.js`)**:
   - `src/db/positions.js` (lines 10-37): Exports `openPositionCount()`, which calculates SQLite open positions plus in-memory `pendingPositionCount`.
   - `src/pipeline/orchestrator.js` (lines 42-46): Calls `canOpenMorePositions()` at entry. If `openPositionCount() >= max_open_positions` (default 3 from DB `settings`), skips processing immediately before performing expensive enrichment or LLM API calls.
   - `src/pipeline/orchestrator.js` (lines 219-232, 276-280, 323-331): Re-checks `canOpenMorePositions()` prior to `handleApprovedBuy` and after async candidate refresh to prevent race conditions when multiple signals execute concurrently.
   - `src/db/positions.js` (lines 107-170, 183-245): `createDryRunPosition` and `createLivePosition` execute inside atomic `db.transaction()`, enforcing a 24-hour closed position cooldown and blocking re-entry if a token had a winning trade within `WIN_BLOCK_DAYS = 7`.

3. **Dynamic Soft Scoring & Threshold Adjustments (`src/pipeline/candidateBuilder.js`)**:
   - `src/pipeline/candidateBuilder.js` (lines 38-343): `filterCandidate()` evaluates hard filters (market cap, liquidity, holders, rug ratio, bot holder death zone ≥40%, ATH distance, flow metrics) and computes a soft score via `computeSoftScore()`.
   - `src/pipeline/candidateBuilder.js` (lines 349-466): `computeSoftScore()` assigns a score (0-150) based on liquidity, bot%, top10 concentration, dev migrations, holder count, smart degens (`smart_degen_count`), and organic score.
   - `src/pipeline/candidateBuilder.js` (lines 468-486): `softScoreThreshold(strat)` dynamically adjusts the soft score threshold:
     - Base threshold: `50`.
     - Time-of-day adjustment: Quiet hours (06:00-14:00 UTC) add `+15` (tightens to 65+).
     - Load-based adjustment: Reads `openPositionCount()`. If `openCount >= maxOpen - 1`, adds `+10` (tightens); if `openCount === 0`, subtracts `-10` (loosens).
   - `src/pipeline/candidateBuilder.js` (lines 328-342): `sourceWeight` assigns route-based position sizing multipliers (`pumpportal_graduated`: 1.0, `trenches_completed`: 0.8, `fee_trending`: 0.8, `pumpfun_pregrad`: 0.7, `trending` / `dual_source`: 0.5).

4. **Macro & Regime Intelligence Engines (`src/signals/macroEngine.js` & `src/evolution/regimeDetector.js`)**:
   - `src/signals/macroEngine.js` (lines 40-68): `runMacroEngine()` fetches SOL/USDT price from Binance API, queries SQLite `dry_run_positions` for 6-hour closed position win-rate (`SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END)`), and writes `current_macro_state` formatted text to SQLite `settings` table via `setSetting()`.
   - `src/pipeline/llm.js` (lines 221-224, 231-232): `decideCandidateBatch()` reads `current_macro_state` and `current_regime_summary` from SQLite `settings` table and injects them directly into the LLM system prompt under `== MACRO WEATHER ==` and `== REAL-TIME REGIME MEMORY ==`.
   - `src/db/positions.js` (lines 48-67): `getRegimeMultiplier()` queries 24-hour win-rate from SQLite `dry_run_positions` to adjust position sizes dynamically (Hot WR ≥40% → 1.5x, Normal WR ≥30% → 1.0x, Cold WR ≥20% → 0.5x, Ice WR <20% → 0.25x).

5. **LLM Decision Engine & Resilient Fallbacks (`src/pipeline/llm.js`)**:
   - `src/pipeline/llm.js` (lines 11-15): `llmBuyMinConfidence()` reads `llm_min_confidence` dynamically from SQLite `settings` (default 40).
   - `src/pipeline/llm.js` (lines 100-123): `selectModelForRoute()` routes real-time PumpPortal signals to primary model (`LLM_MODEL`) and batch server signals to cheap model (`LLM_MODEL_CHEAP`).
   - `src/pipeline/llm.js` (lines 359-446): Axios HTTP client implements multi-tier fallback handling for API rate limits, timeouts, 401/402/412/5xx errors: Primary -> Zyloo Fallback -> OpenRouter Fallback.
   - `src/pipeline/llm.js` (lines 69-81): `effectivePositionSizeSol()` dynamically scales position size linearly with LLM confidence score (`base * (confidence / 100)`).
   - `src/pipeline/llm.js` (lines 457-496): Optional Dual-LLM Consensus (`dual_llm_consensus` setting): If primary returns BUY, queries secondary model; downgrades to WATCH if secondary disagrees.

6. **Auto-Learn & Closed-Loop Strategy Mutator (`src/learning/autoApply.js` & `src/app.js`)**:
   - `src/app.js` (lines 112-130): Schedules periodic learning cycle every 6 hours (`runPeriodicLearning`).
   - `src/learning/autoApply.js` (lines 64-170): `autoApplyLessons(0.7)` checks closed position count (`closedCount >= 30`), filters active lessons created in the last 7 days, enforces 24-hour idempotency per action/strategy, and directly mutates SQLite `settings` table (`INSERT INTO settings ... ON CONFLICT DO UPDATE`) or `strategies.config_json`.
   - Modifies key parameters such as `default_sl_percent`, `default_tp_percent`, `llm_min_confidence`, `min_liquidity_usd`, `max_mcap_usd`. Audit records are saved in `learning_applied` table.

7. **Execution Router & Jupiter Executor (`src/execution/router.js` & `src/liveExecutor.js`)**:
   - `src/execution/router.js` (lines 21-109): `executeLiveBuy` checks wallet balance (`liveWalletBalanceLamports() >= amount + LIVE_MIN_SOL_RESERVE_LAMPORTS`), retries swap up to 3 times (`ENTRY_MAX_ATTEMPTS = 3`), and records `FAILED_ENTRY` position in SQLite on fatal errors.
   - `src/liveExecutor.js` (lines 65-126): Integrates Jupiter Ultra API `/order` and `/execute` endpoints, deserializes base64 transactions, signs with `@solana/web3.js` Keypair (`SOLANA_PRIVATE_KEY`), and posts signed transactions to Solana RPC.

8. **Telegram UI & Human-in-the-Loop (`src/telegram/`)**:
   - Operator receives batch reveals (`sendBatchReveal`), position open alerts (`sendPositionOpen`), and trade intents (`sendTradeIntent`).
   - Operator can issue Telegram commands (`/confirm <intentId>`, `/reject <intentId>`), executing `executeConfirmedIntent()` in `src/execution/router.js`.

---

## 2. Logic Chain

From these observations, we establish the step-by-step logic chain governing Charon's architecture:

1. **Ingestion & Early Rate-Limiting**: Raw WebSocket signals or HTTP poll results trigger `processCandidateFromSignals()`. Before executing expensive API enrichment calls or ML models, the orchestrator queries SQLite open position counts and pending position flags via `canOpenMorePositions()`. If capacity is maxed out, processing terminates immediately, saving CPU and external API rate limits.

2. **Deduplication & Multi-Source Enrichment**: If position slots are available, 5 deduplication guards run against SQLite tables (`dry_run_positions`, `candidates`, `llm_decisions`) to block open positions, closed position cooldowns (<4h), recent LLM decisions (<2h), candidate duplicates (<10min), and copycat symbols (<24h). Passed mints trigger parallel enrichment across GMGN, Jupiter Ultra, RugCheck, Twitter, and Wallet Exposure services.

3. **Multi-Stage Filtering & Soft Thresholding**: `CandidateBuilder` evaluates hard safety rules (liquidity floor, top 10 concentration, bot holder death zone ≥40%, ATH distance, flow metrics). Candidates passing hard filters undergo soft scoring (0-150). The soft threshold dynamically tightens (+15 during low-volume hours, +10 when position slots are nearly full) or loosens (-10 when idle). `preScoreCandidate` and `momentumFilter` (`predict_momentum.py` ML model) perform secondary rule and predictive screening.

4. **Macro-Aware CIO Decision & Resilience**: Passed candidates enter `decideCandidateBatch()`. The LLM receives candidate metrics alongside real-time macro weather (`current_macro_state` set by `MacroEngine` from 6h win-rates) and regime memory (`RegimeDetector`). The LLM acts as Chief Investment Officer, balancing macro weather against micro intelligence and active strategy lessons. Multi-tier fallbacks (Primary -> Zyloo -> OpenRouter) ensure high availability, while confidence scores dictate position size scaling.

5. **Execution Routing & Protection**: Approved BUY decisions route to `handleApprovedBuy()`. Execution refresh guards re-verify live market data to reject stale setups. Depending on `trading_mode`, the system either logs a `dry_run` trade in SQLite, queues a `confirm` trade intent for Telegram operator approval, or triggers `executeLiveBuy()`. Live execution verifies SOL balance, calls Jupiter Ultra API, signs transactions on-chain, and stores position records in SQLite.

6. **Closed-Loop Self-Tuning**: Closed trades update SQLite PnL metrics. Every 6 hours, `summarizeLearningWindow` generates lessons, and `autoApplyLessons()` updates SQLite `settings` and `strategies.config_json`. These modified settings immediately alter subsequent candidate filtering thresholds, LLM confidence floors, and position limits, forming a closed feedback control loop.

---

## 3. Caveats

1. **Read-Only Scope**: This report is produced under read-only investigation rules. No runtime source code in `src/` was modified.
2. **Network & RPC Congestion**: Live execution performance relies on Jupiter API responsiveness and Solana RPC network congestion, which can introduce latency or slippage during periods of extreme Solana network activity.
3. **LLM API Rate Limits & Cost**: While multi-tier fallbacks (Primary -> Zyloo -> OpenRouter) and cheap model routing mitigate downtime, high signal volume requires careful management of LLM API budgets and timeouts.

---

## 4. Conclusion

Charon is a modular, highly resilient, closed-loop trading bot where SQLite (`charon.sqlite`) acts as the single source of truth for runtime parameters, position locks, decision caches, and performance feedback. Component influences are bi-directional: strategy rules govern pipeline execution, while trade outcomes dynamically update strategy rules via `AutoApply` and `MacroEngine`.

The complete visual representation and technical report structure have been synthesized below.

---

## 5. Complete Mermaid.js Architecture Diagram

```mermaid
graph TD
    %% Global Styling & Layout %%
    classDef signalFill fill:#1f2937,stroke:#3b82f6,stroke-width:2px,color:#fff;
    classDef enrichFill fill:#1e1b4b,stroke:#6366f1,stroke-width:2px,color:#fff;
    classDef pipeFill fill:#1e293b,stroke:#0ea5e9,stroke-width:2px,color:#fff;
    classDef engineFill fill:#312e81,stroke:#8b5cf6,stroke-width:2px,color:#fff;
    classDef llmFill fill:#4c1d95,stroke:#a855f7,stroke-width:2px,color:#fff;
    classDef execFill fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#fff;
    classDef dbFill fill:#451a03,stroke:#f59e0b,stroke-width:2px,color:#fff;
    classDef learnFill fill:#701a75,stroke:#ec4899,stroke-width:2px,color:#fff;
    classDef tgFill fill:#0f5132,stroke:#20c997,stroke-width:2px,color:#fff;

    subgraph Signals_Ingestion ["📡 1. Signals & Ingestion Layer"]
        PP["PumpPortal WS (wss://pumpportal.fun)<br/>New Token & Migration Listener"] :::signalFill
        GMGN_T["GMGN Trenches / Trending Poller"] :::signalFill
        PUMP_PRE["PumpFun Pre-Grad Poller"] :::signalFill
        FEE_CLAIM["Fee Claim Monitor"] :::signalFill
        PRICE_MON["Price Alert Monitor (Dip Buy)"] :::signalFill
        SIG_SERVER["Signal Server Client (HTTP/WS)"] :::signalFill
    end

    subgraph Dynamic_Enrichment ["🔍 2. Dynamic Enrichment Layer"]
        GMGN_API["GMGN Token API<br/>MarketCap, Liquidity, Holder Stats"] :::enrichFill
        JUP_API["Jupiter Ultra API<br/>Asset Info, Holders, Audit & Flow Stats"] :::enrichFill
        RUG_CHECK["RugCheck API<br/>Security Audit"] :::enrichFill
        TWITTER_EN["Twitter / Narrative Tracker"] :::enrichFill
        WALLET_EN["Saved Wallet Exposure Tracker"] :::enrichFill
    end

    subgraph SQLite_DB ["💾 SQLite Database Layer (charon.sqlite)"]
        TBL_POS["dry_run_positions<br/>Open / Closed Positions & Status"] :::dbFill
        TBL_CAND["candidates<br/>Ingested Candidates & Snapshots"] :::dbFill
        TBL_DEC["llm_decisions<br/>Batch & Single Decision Log"] :::dbFill
        TBL_SETT["settings & strategies<br/>Dynamic Runtime Config & Multi-Strategy Config"] :::dbFill
        TBL_LEARN["learning_lessons & learning_applied<br/>Active Lessons & Auto-Applied History"] :::dbFill
        TBL_INTENT["trade_intents<br/>Pending Operator Confirmation Queue"] :::dbFill
    end

    subgraph Pipeline_Orchestrator ["⚡ 3. Core Pipeline & Scoring Orchestrator"]
        ORCH["Pipeline Orchestrator<br/>(processCandidateFromSignals)"] :::pipeFill
        POS_LOCK["Position Lock Guard<br/>(canOpenMorePositions)"] :::pipeFill
        DEDUP["Multi-Tier Dedup & Cooldown Checks<br/>(2h Position, 4h Closed, 10m Candidate, 24h Symbol)"] :::pipeFill
        CB["Candidate Builder<br/>(buildCandidate & computeSoftScore)"] :::pipeFill
        PRE_SCORE["Pre-Scorer<br/>(Rule-Based Check)"] :::pipeFill
        MOM_FILTER["Momentum Filter<br/>(predict_momentum.py ML Model)"] :::pipeFill
    end

    subgraph Intelligence_Engines ["🧠 4. Regime & Macro Intelligence Engines"]
        MACRO["MacroEngine<br/>Binance SOL/USDT & 6h Win-Rate Tracker"] :::engineFill
        REGIME["RegimeDetector<br/>Market Dynamic Classification"] :::engineFill
    end

    subgraph LLM_Integration ["🤖 5. LLM Decision & Consensus Engine"]
        LLM_ROUTER["LLM Router & Model Selector<br/>(selectModelForRoute)"] :::llmFill
        LLM_PRIMARY["Primary LLM<br/>(CIO Decision Prompt + Lessons + Macro Context)"] :::llmFill
        LLM_CHEAP["Cheap LLM<br/>(Batch Signal Screening)"] :::llmFill
        LLM_FALLBACK["Fallback Models<br/>(Zyloo / OpenRouter Resilience Tier)"] :::llmFill
        DUAL_CONS["Dual LLM Consensus Evaluator<br/>(Secondary Verification)"] :::llmFill
    end

    subgraph Execution_Layer ["🚀 6. Execution Router & Swap Layer"]
        EXEC_ROUTER["Execution Router<br/>(executeLiveBuy / executeLiveSell / Mode Switcher)"] :::execFill
        REFRESH_GUARD["Fresh Execution Refresh Guard<br/>(refreshCandidateForExecution)"] :::execFill
        JUP_EXECUTOR["Jupiter Executor<br/>(Order + Sign + Execute Swap Endpoint)"] :::execFill
        SOL_RPC["Solana RPC & Web3 Keypair<br/>(Transaction Signing & On-Chain Finality)"] :::execFill
    end

    subgraph Auto_Learn ["🎓 7. Auto-Learn & Self-Tuning Engine"]
        LEARN_SUM["Learning Summarizer<br/>(summarizeLearningWindow)"] :::learnFill
        LESSON_GEN["Lesson Generator<br/>(generateLessons)"] :::learnFill
        AUTO_APPLY["AutoApply Mutator<br/>(autoApplyLessons - DB Mutator)"] :::learnFill
    end

    subgraph Telegram_UI ["💬 8. Telegram UI & Alert System"]
        TG_BOT["Telegram Bot Interface<br/>(Commands: /confirm, /reject, /status, /settings)"] :::tgFill
        TG_SEND["Telegram Alert Service<br/>(Batch Reveal, Position Open, Trade Intent, Failures)"] :::tgFill
        CARD_GEN["PNG Exit Card Renderer"] :::tgFill
    end

    %% Data & Control Flow Connections %%

    %% Ingestion to Orchestrator %%
    PP -->|Token Creation / Migration Signal| ORCH
    GMGN_T -->|Trenches Candidate| ORCH
    PUMP_PRE -->|Pre-Grad Candidate| ORCH
    FEE_CLAIM -->|Fee Claim Signal| ORCH
    PRICE_MON -->|Dip Buy Trigger| ORCH
    SIG_SERVER -->|Server Batch Signals| ORCH

    %% Orchestrator & Position Lock / Dedup %%
    ORCH -->|Check Max Position Cap| POS_LOCK
    POS_LOCK <-->|Read Open Position Count| TBL_POS
    ORCH -->|Check Dedup & Cooldown| DEDUP
    DEDUP <-->|Query Closed/Recent Positions| TBL_POS

    %% Candidate Building & Dynamic Enrichment %%
    ORCH -->|Build & Filter Candidate| CB
    CB -->|Fetch Token Metadata & Fees| GMGN_API
    CB -->|Fetch Asset Audit & Flow Stats| JUP_API
    CB -->|Fetch Security Metrics| RUG_CHECK
    CB -->|Fetch Sentiment & Social Hype| TWITTER_EN
    CB -->|Fetch Wallet Exposure| WALLET_EN
    CB -->|Persist Ingested Candidate| TBL_CAND

    %% Scoring & Filters %%
    CB -->|Hard Filter & Soft Score| PRE_SCORE
    PRE_SCORE -->|Pass Rule-Based Floor| MOM_FILTER
    MOM_FILTER -->|Passed ML Momentum Score| LLM_ROUTER

    %% Macro & Regime Influence Loops %%
    MACRO -->|Fetch SOL/USDT Price| Binance_API["Binance API"]
    MACRO <-->|Query 6h Closed Trade Win-Rate| TBL_POS
    MACRO -->|Write current_macro_state| TBL_SETT
    REGIME -->|Write current_regime_summary| TBL_SETT
    TBL_SETT -.->|Inject Macro & Regime Context| LLM_PRIMARY

    %% LLM Invocations & Fallbacks %%
    LLM_ROUTER -->|PumpPortal Route| LLM_PRIMARY
    LLM_ROUTER -->|Batch Server Route| LLM_CHEAP
    LLM_PRIMARY -.->|On HTTP 401/402/5xx/Timeout| LLM_FALLBACK
    LLM_PRIMARY -->|If dual_llm_consensus enabled| DUAL_CONS
    LLM_PRIMARY -->|Store Verdict & Confidence| TBL_DEC
    LLM_ROUTER <-->|Inject Active Lessons| TBL_LEARN

    %% Execution Flow %%
    TBL_DEC -->|Approved BUY Verdict| EXEC_ROUTER
    EXEC_ROUTER -->|Re-verify Market Data| REFRESH_GUARD
    EXEC_ROUTER <-->|Read Mode: dry_run / confirm / live| TBL_SETT
    
    EXEC_ROUTER -->|Dry-Run Mode| TBL_POS
    EXEC_ROUTER -->|Confirm Mode| TBL_INTENT
    EXEC_ROUTER -->|Live Mode: Swap SOL for Token| JUP_EXECUTOR
    
    JUP_EXECUTOR -->|Build Swap Order & Slippage| JUP_API
    JUP_EXECUTOR -->|Sign Transaction with Wallet Keypair| SOL_RPC
    JUP_EXECUTOR -->|On Swap Success| TBL_POS

    %% Auto-Learn Loop %%
    TBL_POS -.->|Closed Trade Performance (12h)| LEARN_SUM
    LEARN_SUM --> LESSON_GEN
    LESSON_GEN --> TBL_LEARN
    TBL_LEARN -->|Trigger AutoApply (6h Interval)| AUTO_APPLY
    AUTO_APPLY -->|Mutate Dynamic Settings & Strategy Config| TBL_SETT
    TBL_SETT -.->|Dynamic Parameter Override| CB
    TBL_SETT -.->|Dynamic Parameter Override| ORCH

    %% Telegram UI Feedback Loop %%
    EXEC_ROUTER -->|Send Open Alert| TG_SEND
    TBL_INTENT -->|Send Trade Intent for Confirmation| TG_SEND
    AUTO_APPLY -->|Send Auto-Learn Notification| TG_SEND
    TG_BOT <-->|Operator Commands (/confirm, /reject)| TBL_INTENT
    TG_BOT <-->|View Status & Modify Settings| TBL_SETT
    TG_SEND --> CARD_GEN
```

---

## 6. Technical Report Structure Outline for `charon_architecture.md`

The following section-by-section outline structures the final technical report (`charon_architecture.md`) required by `ORIGINAL_REQUEST.md`:

```markdown
# Charon System Architecture & Logic Connections Technical Report

## 1. Executive Summary
- System mission: Modular, self-tuning Solana meme coin trading bot and analytics engine.
- High-level overview of core data flow: Signals -> Enrichment -> Pipeline Scoring -> LLM Evaluation -> Execution -> Auto-Learning Feedback.
- Key architectural highlights: Single source of truth in SQLite, multi-tier fallback resilience, dynamic soft thresholding, and continuous closed-loop learning.

## 2. Overall Architectural Overview & Visual Diagram
- Mermaid.js System Architecture Diagram (Complete visual map showing all 11 core components, data flows, and control loops).
- Core Subsystems Inventory table (Component Name, File Paths, Role, Dependencies).

## 3. Signals & Ingestion Layer
- WebSocket and HTTP Signal Providers (`pumpportal.js`, `trenches.js`, `graduated.js`, `trending.js`, `pumpfunPregrad.js`, `serverClient.js`).
- Event triggers: Token creation, bonding curve migration, dip alerts, fee claim signals.
- Ingestion deduplication and rate-limiting at the boundary.

## 4. Multi-Source Dynamic Enrichment Engine
- Parallel API enrichment across GMGN (`gmgn.js`), Jupiter Ultra (`jupiter.js`), RugCheck (`rugcheck.js`), Twitter narrative tracker (`twitter.js`), and Saved Wallet Exposure tracker (`wallets.js`).
- Fast-path enrichment for freshly graduated tokens vs standard 2-stage enrichment.
- Memory caching, TTL eviction, and rate-limit backoff handling.

## 5. Core Pipeline Orchestrator & Scoring Engine
- Entry orchestration flow (`orchestrator.js`).
- Position slot lock gating (`canOpenMorePositions()`, `openPositionCount()`).
- 5-Tier Deduplication & Cooldown Protocol (Open position, closed position 4h cooldown, LLM decision cache 2h, candidate 10min, symbol 24h).
- Rule-based Hard Filters (`filterCandidate()`).
- v45 Soft Scoring Engine (`computeSoftScore()`) & Dynamic Thresholding (`softScoreThreshold()`) based on time-of-day and open position load.
- Machine Learning Momentum Prediction (`predict_momentum.py` via `momentumFilter.js`).
- Route-based Signal Weighting (`sourceWeight`) for dynamic position sizing.

## 6. Regime & Macro Intelligence Engines
- `MacroEngine` (`macroEngine.js`): Binance SOL/USDT trend tracking, 6h closed trade win-rate calculation, and `current_macro_state` injection into LLM system prompt.
- `RegimeDetector` (`regimeDetector.js`): Market dynamic classification and `current_regime_summary` injection.
- Regime-based position size multipliers (`getRegimeMultiplier()`).

## 7. LLM Integration & Decision Consensus Engine
- Dynamic model routing (`selectModelForRoute()`): PumpPortal real-time vs signal server batching.
- Chief Investment Officer (CIO) prompt calibration, strategy guidelines, and active lesson injection.
- Resilience & Multi-Tier Fallback Hierarchy: Primary Model -> Zyloo Fallback -> OpenRouter Fallback.
- Dynamic confidence-based position sizing (`effectivePositionSizeSol()`).
- Optional Dual-LLM Consensus (`dual_llm_consensus`).

## 8. Execution Router & Jupiter Executor
- Multi-mode trade router (`trading_mode`: `dry_run`, `confirm`, `live`).
- Fresh execution refresh guard (`refreshCandidateForExecution()`) to prevent stale trades.
- Wallet balance validation & reserve lamports enforcement (`LIVE_MIN_SOL_RESERVE_LAMPORTS`).
- Jupiter Ultra API integration (`liveExecutor.js`): `/order` construction, `JUPITER_SLIPPAGE_BPS` enforcement, VersionedTransaction web3 signing, and `/execute` posting.
- Failed entry recording (`FAILED_ENTRY`) and transaction audit logging.

## 9. SQLite Database Schema & State Locks
- SQLite database layout (`charon.sqlite` via `connection.js`, `schema.js`).
- Detailed table breakdown: `candidates`, `dry_run_positions`, `dry_run_trades`, `llm_decisions`, `settings`, `strategies`, `learning_lessons`, `learning_applied`, `trade_intents`.
- Concurrency locks, transaction boundaries, atomic slot reservation, and winning trade re-entry blocking (`WIN_BLOCK_DAYS = 7`).

## 10. Auto-Learn & Self-Tuning Engine
- Periodic learning cycle (every 6h via `app.js`).
- Window summarizer (`summarizeLearningWindow()`) and lesson generator (`generateLessons()`).
- Automated parameter mutator (`autoApplyLessons()`): Recency gate (7d), closed count gate (≥30), 24h idempotency gate, and direct SQLite mutation of `settings` and `strategies.config_json`.
- Closed feedback control loop visualization.

## 11. Telegram UI & Operator Controls
- Real-time notifications: Batch reveals, position opens, trade intents, learning runs, execution failures.
- Interactive operator bot commands (`/confirm`, `/reject`, `/status`, `/settings`).
- Visual PNG exit card renderer (`test_exit_card.mjs`).

## 12. Verification & Invalidation Protocol
- Methods for independent architectural verification:
  - Linter whitelist checks (`node lint.cjs`).
  - Unit & E2E test suite execution.
  - Live log tracing for component influence loops (`[macro]`, `[learn]`, `[candidate]`, `[llm]`, `[live]`).
- Invalidation conditions and regression prevention guidelines.
```

---

## 7. Verification Method

To independently verify the findings in this report:

1. **Verify Linter & Code Structure**:
   ```bash
   node lint.cjs
   ```
2. **Verify Code Locations**:
   - Inspect `src/signals/macroEngine.js` line 64: `setSetting('current_macro_state', text)`.
   - Inspect `src/pipeline/llm.js` lines 223-224: `setting('current_macro_state', 'Unknown')`.
   - Inspect `src/pipeline/candidateBuilder.js` lines 468-486: `softScoreThreshold(strat)` checking `openPositionCount()`.
   - Inspect `src/learning/autoApply.js` lines 133, 155: `db.prepare('INSERT INTO settings ...')` and strategy `config_json` updates.
   - Inspect `src/db/positions.js` lines 20-37, 107-170: `canOpenMorePositions()` and atomic `db.transaction()` position locks.
   - Inspect `src/execution/router.js` line 34: `executeJupiterSwap()` integration.

3. **Invalidation Conditions**:
   - The analysis would be invalidated if SQLite settings mutations in `autoApply.js` failed to take immediate effect on `activeStrategy()` calls, or if `canOpenMorePositions()` failed to gate candidate processing in `orchestrator.js`.
