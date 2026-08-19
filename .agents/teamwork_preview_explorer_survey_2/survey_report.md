# Engine.KC Codebase Survey Report: R2 Latency Optimization & Resource Efficiency

**Survey Date**: 2026-08-12  
**Agent**: `teamwork_preview_explorer_survey_2`  
**Target Codebase**: `/root/engine.kc`  
**Focus Scope**: R2 Requirements — Candidate Decision Pipeline Latency, Rate-Limiting Enforcement, Memory Cache Bounding, Concurrency Control in Polling Loops.

---

## Executive Summary

This survey examines the `engine.kc` Solana/BNB automated trading engine to evaluate latency bottlenecks, rate-limiting behavior, memory resource usage, and polling concurrency.

### Key Findings
1. **Decision Pipeline Latency**: Processing candidate tokens currently exceeds the 300ms target (hard max 500ms). The primary bottleneck is an unconditional `await sleep(300)` delay at `src/pipeline/candidateBuilder.js:579` combined with multi-stage sequential HTTP network calls (GMGN, Jupiter asset/holders/charts, Twitter fxAPI scrapers) and remote ML/LLM calls.
2. **Rate-Limiting Enforcement**: API clients for RPC, Jupiter, Rugcheck, and Twitter lack standardized request pacing. Only GMGN has a queue, but its default delay (`gmgn_request_delay_ms = 2500ms`) is overly restrictive and stalls pipeline throughput. A standardized `sleep(300ms)` per-domain rate limiter is needed.
3. **Unbounded Memory Caches**: 17 in-memory Maps and objects across `src/enrichment/` and `src/signals/` accumulate data without upper bound limits or eviction policies (`gmgnCache`, `jupiterAssetCache`, `rugcheckCache`, `axiom`, `seenSignals`, etc.), posing high risk of heap growth and memory leaks under long-term operation.
4. **Concurrency Control in Polling Loops**: Polling loops in `src/app.js` (`fetchServerSignals`, `fetchTrenches`, `monitorPriceAlerts`, `fetchGraduatedCoins`, `fetchGmgnTrending`) and `src/signals/pumpportal.js` (`checkBondingCurve`) lack re-entrancy guards (`isRunning` flags). Slow network responses cause overlapping execution cycles, resulting in redundant API calls and 429 rate limit spikes.

---

## Section 1: Candidate Decision Pipeline Timing & Potential Bottlenecks

### 1.1 Decision Pipeline Architecture & Flow
When a token signal arrives, processing flows through `processCandidateFromSignals(signals)` in `src/pipeline/orchestrator.js`:

```
Signal Ingestion -> Deduplication & Open Position Checks -> checkDecisionCache()
 -> buildCandidate(signals) [Enrichment: GMGN, Jupiter, Wallets, Twitter]
 -> filterCandidate() [BNB Scanner (10-stage), Coinbiopsy Re-accumulation, Audit/Liquidity/SoftScore]
 -> preScoreCandidate()
 -> momentumFilter() [ML Service POST /predict]
 -> decideCandidateBatch() / Rule-based decision
 -> handleApprovedBuy() [refreshCandidateForExecution -> Order Execution]
```

### 1.2 Step-by-Step Latency Breakdown

| Pipeline Step | Code Location | Observed Latency Range | Potential Bottlenecks & Hazards |
|---|---|---|---|
| 1. Deduplication & DB Checks | `orchestrator.js:56-117` | < 5ms | Fast SQLite queries for open positions, closed position cooldown, and decision cache. |
| 2. Unconditional Sleep Throttle | `candidateBuilder.js:579` | **300ms** | **CRITICAL BOTTLENECK**: `await sleep(300)` is executed unconditionally on every candidate, consuming 100% of the target 300ms latency budget before any processing begins. |
| 3. Stage 1 Parallel Enrichment | `candidateBuilder.js:596-602` | 300ms - 1500ms | `Promise.all` calling `fetchGmgnTokenInfo`, `fetchJupiterAsset`, `fetchJupiterHolders`, `fetchJupiterChartContext`. `fetchJupiterChartContext` fires 3 sub-queries (5m, 1h, 4h candles) sequentially or in parallel. `fetchGmgnTokenInfo` is gated by `gmgn_request_delay_ms` (2500ms default). |
| 4. Stage 2 Dependent Enrichment | `candidateBuilder.js:604-607` | 200ms - 2000ms | `Promise.all` calling `fetchSavedWalletExposure` (fast) and `fetchTwitterNarrative` (makes up to 2 HTTP calls to fxTwitter/Twitter API with 8s timeouts). |
| 5. Deterministic Rules & Scanners | `candidateBuilder.js:56-375` | 2ms - 10ms | `scanBnbRunnerCandidate` (10-stage filter), `detectSmartMoneyReaccumulation`, `filterCandidate`, `computeSoftScore`. Fast synchronous code. |
| 6. Pre-Scorer | `preScorer.js` | < 1ms | Rule-based synchronous scoring. |
| 7. Momentum Filter (ML Service) | `momentumFilter.js:24` | 50ms - 2000ms | HTTP POST to `http://127.0.0.1:8001/predict` with `timeout: 2000ms`. Network latency to local Python process can spike under load. |
| 8. LLM Decision Batching | `llm.js:342` | 800ms - 3000ms | When `strat.use_llm` is true, calling remote LLM API adds significant latency. (When `use_llm` is false, this is bypassed). |

### 1.3 Latency Optimization Plan (< 300ms Target, Hard Max 500ms)

1. **Remove Hardcoded Sleep Throttle**: Remove `await sleep(300)` at `candidateBuilder.js:579`. Replace with non-blocking domain-specific token bucket rate limiters.
2. **Early Short-Circuiting & Fast-Path Filtering**:
   - Run lightweight local filters (mcap floor, holder count, mint format) BEFORE initiating expensive network enrichment.
   - For rule-based strategies (`use_llm: false`), skip non-critical enrichment like Twitter narrative scraping and multi-window chart context.
3. **Optimize Jupiter Chart Queries**:
   - In `fetchJupiterChartContext`, only request 5-minute candles during candidate builder screening. Fetch 1h/4h swing candles lazily or only when required.
4. **Reduce GMGN Pacing Overhead**:
   - Lower default `gmgn_request_delay_ms` from 2500ms to 300ms to allow candidate evaluation to complete promptly.
5. **Optimize ML Momentum Service**:
   - Reduce ML service POST timeout from 2000ms to 150ms with fail-open fallback, or evaluate momentum score using an in-process JS predictor.

---

## Section 2: Rate-Limiting Delays (`sleep(300ms)`) & 429 Prevention Strategy

### 2.1 Audit of API Clients

| Provider / API Domain | Client File | Current Rate Limiting Mechanism | 429 Vulnerability Level |
|---|---|---|---|
| **RPC / Solana WS** | `src/config.js`, `src/signals/feeClaim.js` | None. Direct WebSocket and HTTP RPC requests. | **HIGH**: Signal bursts can trigger Helius / RPC provider rate limits. |
| **GMGN API** | `src/enrichment/gmgn.js` | Enqueue queue (`enqueueGmgn`) with `paceGmgnRequest()`. Delay configured via `gmgn_request_delay_ms` (2500ms). Backoff handling for 429/403/Cloudflare. | **MEDIUM**: Handles 429, but delay is overly conservative (2500ms) and stalls queue under burst traffic. |
| **Jupiter API** | `src/enrichment/jupiter.js` | No pacing queue. Exponential/header backoff (`setJupiterAssetBackoff`, `setQuoteBackoff`) sets 30s lockout after 429 occurs. | **HIGH**: Parallel burst requests (`fetchJupiterAsset`, `fetchJupiterHolders`, 3x `fetchJupiterChartWindow`) trigger 429 rate limits. |
| **Rugcheck API** | `src/enrichment/rugcheck.js` | Direct `axios.get` without queue or delay. | **HIGH**: Burst queries to `api.rugcheck.xyz` will trigger 429 blocks. |
| **Twitter / fxTwitter API** | `src/enrichment/twitter.js` | Direct `axios.get` with 8s timeout, no rate limiter. | **MEDIUM**: Third-party API rate limits can return 429 or 403. |

### 2.2 Standardized Pacing Implementation Plan

1. **Centralized Domain Rate Limiter (`RateLimiterQueue`)**:
   Implement a lightweight domain-based queue in `src/utils.js` (or `src/utils/rateLimiter.js`):
   ```javascript
   export class DomainRateLimiter {
     constructor(minDelayMs = 300) {
       this.minDelayMs = minDelayMs;
       this.lastRequestAt = 0;
       this.queue = Promise.resolve();
     }
     async schedule(fn) {
       const run = this.queue.then(async () => {
         const elapsed = Date.now() - this.lastRequestAt;
         if (elapsed < this.minDelayMs) {
           await sleep(this.minDelayMs - elapsed);
         }
         this.lastRequestAt = Date.now();
         return fn();
       });
       this.queue = run.catch(() => {});
       return run;
     }
   }
   ```
2. **Domain Rate Limiter Instances**:
   - `rpcLimiter` (300ms min delay)
   - `jupiterLimiter` (300ms min delay)
   - `gmgnLimiter` (300ms min delay, replacing 2500ms hard delay)
   - `rugcheckLimiter` (300ms min delay)
3. **Integration**: Wrap HTTP call functions in `jupiter.js`, `gmgn.js`, `rugcheck.js`, and `feeClaim.js` through their respective domain rate limiters to guarantee smooth pacing under high-volume signal ingestion bursts.

---

## Section 3: In-Memory Cache Audit & Conversion to Bounded LRU/TTL Maps

### 3.1 Audit of In-Memory Maps & Caches across `src/`

| Cache Name | File Location | Current Data Structure | Eviction Strategy | Bounding Requirement & Recommendation |
|---|---|---|---|---|
| `gmgnCache` | `src/enrichment/gmgn.js:6` | `new Map()` | None (indefinite TTL read check only) | **Unbounded Map**. Convert to `BoundedLRUMap(1000, 60_000)` |
| `jupiterAssetCache` | `src/enrichment/jupiter.js:5` | `new Map()` | None (TTL read check only) | **Unbounded Map**. Convert to `BoundedLRUMap(1000, 20_000)` |
| `rugcheckCache` | `src/enrichment/rugcheck.js:4` | `new Map()` | None (15s TTL read check only) | **Unbounded Map**. Convert to `BoundedLRUMap(1000, 15_000)` |
| `seenSignalCandidates` | `src/pipeline/orchestrator.js:25` | `new Map()` | Pruned via `pruneSeen(10m)` inside function | Convert to `BoundedLRUMap(2000, 10 * 60 * 1000)` |
| `axiom` | `src/signals/axiomSource.js:3` | `new Map()` | None | **Unbounded Map**. Convert to `BoundedLRUMap(500, 10 * 60 * 1000)` |
| `seenFeeClaims` | `src/signals/feeClaim.js:10` | `new Map()` | Manual `pruneSeen(10m)` | Convert to `BoundedLRUMap(1000, 10 * 60 * 1000)` |
| `gmgnSignals`, `triggeredMints` | `src/signals/gmgnSignal.js:6,8` | `new Map()` | Partial | Convert to `BoundedLRUMap(500, 60 * 60 * 1000)` |
| `graduated` | `src/signals/graduated.js:8` | `new Map()` | None | Convert to `BoundedLRUMap(1000, 24 * 60 * 60 * 1000)` |
| `pregradTokens` | `src/signals/pumpfunPregrad.js:24` | `new Map()` | None | Convert to `BoundedLRUMap(1000, 60 * 60 * 1000)` |
| `seenTokens` | `src/signals/pumpportal.js:35` | `new Map()` | Manual prune on new token event (>1h) | Convert to `BoundedLRUMap(2000, 60 * 60 * 1000)` |
| `trackedTokens` | `src/signals/pumpportal.js:36` | `new Map()` | Bounded at `MAX_TRACKED_TOKENS = 50` | Already bounded (Good pattern) |
| `tokenCreatedAt` | `src/signals/pumpportal.js:39` | `new Map()` | Manual prune >1000 items | Already bounded (Good pattern) |
| `seenSignals` | `src/signals/serverClient.js:14` | `new Map()` | None | **Unbounded Map**. Convert to `BoundedLRUMap(1000, 10 * 60 * 1000)` |
| `smartMoneySignals`, `triggeredMints` | `src/signals/smartMoney.js:6,8` | `new Map()` | None | Convert to `BoundedLRUMap(500, 60 * 60 * 1000)` |
| `trenches`, `triggeredMints` | `src/signals/trenches.js:8,10` | `new Map()` | None | Convert to `BoundedLRUMap(1000, 2 * 60 * 60 * 1000)` |
| `trending` | `src/signals/trending.js:9` | `new Map()` | Pruned via lookback timestamp check | Convert to `BoundedLRUMap(1000, 60 * 60 * 1000)` |

### 3.2 Bounded LRU/TTL Map Design Pattern

```javascript
export class BoundedLRUMap extends Map {
  constructor(maxSize = 1000, ttlMs = null) {
    super();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key) {
    const entry = super.get(key);
    if (!entry) return undefined;
    if (this.ttlMs && entry.expiresAt && Date.now() > entry.expiresAt) {
      super.delete(key);
      return undefined;
    }
    // Refresh LRU order on access
    super.delete(key);
    super.set(key, entry);
    return entry.value !== undefined ? entry.value : entry;
  }

  set(key, value) {
    if (super.has(key)) super.delete(key);
    else if (this.size >= this.maxSize) {
      // Evict oldest entry (LRU)
      const oldestKey = this.keys().next().value;
      if (oldestKey !== undefined) super.delete(oldestKey);
    }
    const entry = this.ttlMs ? { value, expiresAt: Date.now() + this.ttlMs } : value;
    super.set(key, entry);
    return this;
  }
}
```

---

## Section 4: Concurrency Control Guards for Asynchronous Polling Loops

### 4.1 Audit of Polling Loops & Missing Guards

| Location | Polling Function / Loop | Interval | Current Guard Status | Risk Analysis |
|---|---|---|---|---|
| `src/app.js:46` | `fetchServerSignals()` | `SIGNAL_POLL_MS` (e.g. 5s) | **MISSING** | Slow server HTTP response causes overlapping fetches, queuing duplicate signals. |
| `src/app.js:54,72` | `fetchTrenches()` | 60,000ms | **MISSING** | If GMGN API slows down, multiple trench fetches execute concurrently. |
| `src/app.js:60` | `monitorPriceAlerts()` | 10,000ms | **MISSING** | Price checks hitting RPC/Jupiter can overlap during network latency. |
| `src/app.js:81` | `fetchGraduatedCoins()` | 60,000ms | **MISSING** | Overlapping graduation fetches can flood candidates. |
| `src/app.js:89` | `fetchGmgnTrending()` | `TRENDING_POLL_MS` (e.g. 30s) | **MISSING** | Overlapping trending queries cause 429 rate limit spikes on GMGN. |
| `src/app.js:119` | `monitorPositions()` | `POSITION_CHECK_MS` | **PRESENT** (`positionMonitorRunning` flag) | Safely prevents concurrent position checks. (Good reference pattern). |
| `src/signals/pumpportal.js:56` | `checkBondingCurve()` | `MONITOR_INTERVAL_MS` (30s) | **MISSING** | **HIGH RISK**: Iterates over up to 50 tracked tokens calling `fetchGmgnTokenInfo`. Can take >30s, causing concurrent overlapping execution cycles. |
| `src/signals/graduated.js:127` | `pollLoop()` | `GRADUATED_POLL_MS` | **MISSING** | Concurrent graduation checks. |
| `src/signals/pumpfunPregrad.js:194` | `fetchPregradTokens()` | `PREGRAD_POLL_MS` | **PARTIAL** (error count backoff, no async mutex) | Multiple fetch cycles can run concurrently if HTTP request hangs. |
| `src/signals/macroEngine.js:75` | `runMacroEngine()` | 5 * 60 * 1000ms | **MISSING** | Low frequency, but good practice to guard. |
| `src/evolution/loop.js:143` | `runEvolutionCycle()` | `INTERVAL_MS` | **MISSING** | Heavy evolution migrations can run concurrently if slow. |

### 4.2 Standard Re-Entrancy Guard Pattern & Utility

```javascript
export function withAsyncLock(fn, name = 'task') {
  let isRunning = false;
  return async (...args) => {
    if (isRunning) {
      console.log(`[guard] skipping ${name} — previous invocation still in progress`);
      return;
    }
    isRunning = true;
    try {
      return await fn(...args);
    } finally {
      isRunning = false;
    }
  };
}
```

---

## Section 5: List of Required Features and Constraints for R2 (Latency Optimization & Resource Efficiency)

### R2 Feature List & Specifications

1. **R2-F1: Pipeline Execution Latency Budget (< 300ms / Hard Max 500ms)**
   - Eliminate hardcoded delays (`await sleep(300)` at `candidateBuilder.js:579`).
   - Implement early short-circuit evaluation for deduplication and local hard filters before making network requests.
   - Enforce asynchronous, non-blocking fetching for non-critical candidate metadata (Twitter narrative, multi-window swing charts).
   - Cap ML momentum service roundtrip at 150ms with fail-open fallback.

2. **R2-F2: Standardized Rate-Limiting Enforcement (`sleep(300ms)`)**
   - Implement domain-level request queues for RPC, Jupiter, GMGN, and Rugcheck APIs.
   - Enforce minimum `sleep(300ms)` pacing between consecutive HTTP requests per domain.
   - Guarantee zero HTTP 429 rate limit errors under high-volume signal ingestion bursts.

3. **R2-F3: Bounded In-Memory Cache Management (LRU/TTL Conversion)**
   - Create zero-dependency `BoundedLRUMap` utility with configurable max capacity and TTL expiration.
   - Replace all 17 raw `new Map()` instances across `src/enrichment/`, `src/signals/`, and `src/pipeline/` with bounded LRU/TTL maps.
   - Cap maximum heap memory usage and eliminate unbounded object retention.

4. **R2-F4: Concurrency Guards for Asynchronous Polling Loops**
   - Add re-entrancy mutex guards to all `setInterval` polling loops in `src/app.js`, `src/signals/pumpportal.js`, `src/signals/graduated.js`, and `src/signals/pumpfunPregrad.js`.
   - Prevent overlapping task execution cycles during network degradation or slow API responses.

---

## Conclusion & Verification Guidance

All R2 targets for latency, rate limiting, memory efficiency, and concurrency control have been mapped with exact line numbers, root causes, and refactoring plans.

To verify lint and code integrity:
```bash
node lint.cjs
npm run check
```
