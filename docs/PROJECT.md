# Project: angel Codebase Stabilization

## Architecture
The `angel` system is a modular Solana meme coin trading bot and analytics engine.

### Subsystems:
1. **Core Pipeline & Decision Engine**: (`src/pipeline/orchestrator.js`, `candidateBuilder.js`, `predict_momentum.py`) - Signal filtering, score evaluation, dynamic soft-thresholding, LLM decision making.
2. **Signals & Ingestion**: (`src/signals/pumpportal.js`, `gmgn.js`, `macroEngine.js`, `serverClient.js`) - Real-time WebSocket and HTTP signal ingestion.
3. **Dynamic Enrichment**: (`src/enrichment/gmgn.js`, `jupiter.js`) - Metadata, asset info, and price enrichment with caching.
4. **Execution Router & Jupiter Executor**: (`src/execution/router.js`, `src/liveExecutor.js`) - Trade routing, Jupiter Ultra API swap ordering, and slippage controls.
5. **SQLite Database & Positions**: (`src/db/positions.js`, `schema.js`, `angel.sqlite`) - Position tracking, trade history, deduplication guards, and open position limits.
6. **Learning & AutoApply Engine**: (`src/learning/autoApply.js`, `autoApplyLessons`) - Performance analysis and strategy parameter optimization.
7. **Telegram UI & Card Renderer**: (`src/telegram/`, `scripts/test_exit_card.mjs`) - Operator alerts, status reporting, and PNG exit card generation.
8. **Analytics & Backtesting**: (`scripts/`, `verify_backtest.py`, `comprehensive_edge_backtest.py`, `dashboard.py`) - Split-half backtesting, metric reporting, and trade reconstruction.

---

## Feature Inventory
| # | Feature / Bug ID | Description | Milestone | Source |
|---|------------------|-------------|-----------|--------|
| 1 | M1-PATH | Fix hardcoded `/home/ubuntu/projects/angel` absolute paths across 11 python/shell/JS scripts | M1 | Survey Infra/Test |
| 2 | M1-PYDEP | Ensure Python runtime dependencies (`pandas`, etc.) are installed and functional | M1 | Survey Test |
| 3 | M1-LINT | Fix `lint.cjs` whitelist missing global `fetch` symbol for `macroEngine.js:10` | M1 | Survey Test |
| 4 | M2-C1 | Wire `JUPITER_SLIPPAGE_BPS` parameter into Jupiter swap URL and order payload in `src/liveExecutor.js` | M2 | Survey Features |
| 5 | M2-C2 | Fix swap-before-dedup race in `src/execution/router.js` by checking `createLivePosition` before `executeJupiterSwap` | M2 | Survey Features |
| 6 | M2-C3 | Require explicit confirmation/flag for `autoApplyLessons` strategy SQL table mutations in `src/learning/autoApply.js` & `src/app.js` | M2 | Survey Features |
| 7 | M3-H1 | Fix TOCTOU race condition in `canOpenMorePositions()` with atomic position reservation locking in `src/db/positions.js` | M3 | Survey Features |
| 8 | M3-H2 | Reconcile wallet token balance on Jupiter swap timeouts before logging `FAILED_ENTRY` | M3 | Survey Features |
| 9 | M3-H3 | Add TTL / LRU eviction cap to global memory caches (`gmgnCache`, `jupiterAssetCache`) | M3 | Survey Features |
| 10 | M3-H4 | Prevent stale price reads during API rate limit backoff in price enrichment | M3 | Survey Features |
| 11 | M4-B4 | Fix ESM `require('./positions.js')` bug in `src/pipeline/candidateBuilder.js` to enable dynamic soft score thresholding | M4 | Survey Features |
| 12 | M4-B1 | Correct inverted volume gate logic (`trending_min_volume_usd`) in candidate scoring | M4 | Survey Features |
| 13 | M4-LLM1 | Calibrate LLM decision prompt and confidence threshold for autonomous BUY decisions | M4 | Survey Features |
| 14 | M4-FALLBACK | Fix fallback LLM error handling and offline server handling in `test_custom.js` | M4 | Survey Test |
| 15 | M4-TGPOLL | Resolve Telegram `409 Conflict` polling error in test script `test_server.js` | M4 | Survey Test |
| 16 | M5-SUITE | Create formal headless test runner and complete E2E test suite (Tiers 1-4) | M5 | Survey Test |
| 17 | M-ARCH | Deep dive codebase analysis, Mermaid.js architectural diagram, and technical report in angel_architecture.md | M-ARCH | User Request 2026-08-08 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Infrastructure & Environment Fixes | Hardcoded path fixes (11 scripts), Python dependencies (`pandas`), AST linter whitelist fix | none | IN_PROGRESS (conv: 0c390ee1-a119-432a-8f68-e022e7644953) |
| M2 | Critical Execution & Safety Fixes | C1 Jupiter slippage BPS cap, C2 post-swap dedup token orphan guard, C3 ungated auto-apply strategy SQL mutator | M1 | PLANNED |
| M3 | Concurrency, Memory & Resilience | H1 TOCTOU position limit lock, H2 swap timeout balance reconciliation, H3 Map memory leak TTL eviction, H4 rate limit stale price fix | M1 | PLANNED |
| M4 | Strategy Pipeline & Runtime Fixes | B4 ESM require fix in candidateBuilder, B1 inverted volume gate fix, LLM prompt/confidence calibration, fallback LLM handling, Telegram test conflict fix | M1, M2 | PLANNED |
| M5 | Final E2E Test Verification & Hardening | Pass 100% of E2E test suite (Tiers 1-4) and complete Tier 5 adversarial coverage hardening | M1, M2, M3, M4 | PLANNED |
| M-ARCH | Architectural Diagram & Technical Report | Analyze codebase data & logic flows, build Mermaid.js diagram, write angel_architecture.md | none | DONE |


---

## Interface Contracts

### 1. Position Deduplication & Creation Contract (`src/db/positions.js` & `src/execution/router.js`)
- `reservePositionSlot(tokenAddress)`: Atomically checks open position limit and acquires slot lock before any network trade call.
- `releasePositionSlot(tokenAddress)`: Releases slot lock if buy fails or is rejected before position creation.
- `createLivePosition(params)`: Must be executed or checked *before* submitting swap orders to Jupiter API.

### 2. Live Execution Order Contract (`src/liveExecutor.js`)
- `executeJupiterSwap(inputMint, outputMint, amountLamports, taker, userSlippageBps)`:
  - MUST append `slippageBps` (from `JUPITER_SLIPPAGE_BPS` config) to API parameters.
  - MUST return structured result containing `txid`, `executedAmount`, `status`, and `error`.

### 3. Candidate Builder Dynamic Threshold Contract (`src/pipeline/candidateBuilder.js`)
- Uses ES Module imports for `openPositionCount()`.
- Calculates dynamic soft threshold cleanly without throwing ESM `ReferenceError`.

---

## Code Layout
- `src/` — Core application code (ES Modules)
  - `app.js` — Main daemon entry point
  - `config.js` — System configuration and environment parameters
  - `liveExecutor.js` — Jupiter API integration
  - `db/` — Database interface and SQLite position queries
  - `execution/` — Trade routing and live execution handlers
  - `pipeline/` — Signal scoring, candidate building, and Python ML integration
  - `signals/` — Signal provider listeners and filters
  - `enrichment/` — Token metadata and market data enrichers
  - `learning/` — Automated lesson learning and strategy tuning
  - `telegram/` — Operator bot and UI handlers
- `scripts/` — Operational, analytical, testing, and backtesting scripts
- `models/` — Pre-trained Python ML model artifacts (`.pkl`, `.json`)
- `lint.cjs` — AST linter and symbol check script
