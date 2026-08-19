# Handoff Report: R2 Codebase Survey (Latency, Rate-Limiting, Memory Caches & Concurrency)

**Agent**: `teamwork_preview_explorer_survey_2`  
**Working Directory**: `/root/engine.kc/.agents/teamwork_preview_explorer_survey_2`  
**Date**: 2026-08-12  

---

## 1. Observation

Direct code observations from inspecting `/root/engine.kc`:

1. **Unconditional Pipeline Delay**:
   - `src/pipeline/candidateBuilder.js` line 579: `await sleep(300);` is invoked unconditionally at the start of `buildCandidate()`.
2. **Multi-Stage Sequential Network Requests**:
   - `src/pipeline/candidateBuilder.js` lines 596-607: `buildCandidate()` executes Stage 1 (`fetchGmgnTokenInfo`, `fetchJupiterAsset`, `fetchJupiterHolders`, `fetchJupiterChartContext`) followed by Stage 2 (`fetchSavedWalletExposure`, `fetchTwitterNarrative`).
   - `src/enrichment/jupiter.js` lines 190-217: `fetchJupiterChartContext()` executes 3 chart window requests (`5_MINUTE`, `1_HOUR`, `4_HOUR`).
   - `src/enrichment/twitter.js` lines 86 & 99: `fetchTwitterNarrative()` attempts API call followed by HTML fallback scraping with 8000ms timeouts.
   - `src/pipeline/momentumFilter.js` line 24: `axios.post(ML_SERVICE_URL, ...)` has `timeout: 2000` (2 seconds).
3. **Unbounded In-Memory Caches**:
   - `src/enrichment/gmgn.js` line 6: `const gmgnCache = new Map();` (unbounded, entries added at lines 164, 173, 180 without eviction).
   - `src/enrichment/jupiter.js` line 5: `const jupiterAssetCache = new Map();` (unbounded, entries added at line 87 without eviction).
   - `src/enrichment/rugcheck.js` line 4: `const rugcheckCache = new Map();` (unbounded, entries added at lines 28, 33 without eviction).
   - `src/signals/axiomSource.js` line 3: `export const axiom = new Map();` (unbounded).
   - `src/signals/serverClient.js` line 14: `const seenSignals = new Map();` (unbounded).
   - Total of 17 in-memory Map/Set instances identified across `src/enrichment/` and `src/signals/`.
4. **Missing Concurrency Control in Polling Loops**:
   - `src/app.js` lines 46, 54, 60, 81, 89: `setInterval` calls for `fetchServerSignals`, `fetchTrenches`, `monitorPriceAlerts`, `fetchGraduatedCoins`, and `fetchGmgnTrending` lack re-entrancy flags (`isRunning`).
   - `src/signals/pumpportal.js` line 56: `monitorTimer = setInterval(() => { checkBondingCurve().catch(...); }, 30000);` lacks an `isChecking` flag. `checkBondingCurve()` iterates up to 50 tokens with `fetchGmgnTokenInfo` and `sleep(100)`, easily exceeding 30,000ms.
   - `src/app.js` line 119: `monitorPositions()` DOES have a guard (`let positionMonitorRunning = false; if (positionMonitorRunning) return;`), establishing the expected pattern.
5. **Rate Limiting Gaps**:
   - `src/enrichment/gmgn.js` line 17: `numSetting('gmgn_request_delay_ms', 2500)` enforces a 2.5-second inter-request delay that stalls queue processing.
   - `src/enrichment/jupiter.js`, `src/enrichment/rugcheck.js`, `src/signals/feeClaim.js`: No inter-request pacing queue. Burst requests trigger HTTP 429 errors.

---

## 2. Logic Chain

1. **Pipeline Latency**:
   - Observation: Candidate evaluation target is <300ms (hard max 500ms).
   - Observation: Line 579 of `candidateBuilder.js` executes `await sleep(300)` unconditionally.
   - Deduction: The unconditional sleep uses 100% of the target latency budget before any network fetching or calculation occurs.
   - Observation: Stage 1 and Stage 2 enrichment perform 6+ HTTP network calls across GMGN, Jupiter, and Twitter.
   - Conclusion: Removing the hardcoded 300ms sleep and short-circuiting local deduplication/pre-filtering before network calls is necessary to achieve <300ms processing time.

2. **Rate-Limiting & HTTP 429 Prevention**:
   - Observation: Burst signal ingestion triggers simultaneous requests to Jupiter and Rugcheck APIs without pacing queues, causing HTTP 429 rate limits and 30-second backoffs.
   - Observation: GMGN API uses a conservative 2500ms delay per request.
   - Deduction: Replacing hardcoded inline sleeps and single slow queues with a standardized domain-level rate limiter enforcing `sleep(300ms)` pacing per provider will prevent 429 errors while allowing fast response times.

3. **Memory Cache Leakage**:
   - Observation: 17 Maps store tokens and API responses without hard capacity limits or eviction mechanisms.
   - Deduction: In high-volume market conditions (thousands of new token mints per day), these Maps will grow without bound, causing heap fragmentation and potential OOM crashes.
   - Conclusion: All unbounded Maps must be converted to a `BoundedLRUMap` class with fixed max capacity (e.g. 500-2000 items) and TTL expiration.

4. **Polling Concurrency Vulnerability**:
   - Observation: `checkBondingCurve()` in `pumpportal.js` and 5 polling loops in `app.js` run on fixed `setInterval` timers without `isRunning` mutex flags.
   - Deduction: When network requests experience transient latency, the next interval fires before the previous cycle finishes. This leads to overlapping concurrent executions, state race conditions, duplicate signal processing, and API request floods.
   - Conclusion: Adding mutex re-entrancy guards (`isRunning` flags) to all asynchronous polling functions guarantees execution isolation.

---

## 3. Caveats

- **External Network Latency**: Real-world execution time for remote LLM calls (`decideCandidateBatch`) depends on remote provider latency (OpenRouter/OpenAI). When `use_llm` is enabled, LLM latency (800-3000ms) will dominate pipeline execution; local optimization ensures the local pre-LLM pipeline overhead remains <50ms.
- **ML Service Dependency**: Latency measurements assume the local Python ML service (`ml_service/server.py`) is running on port 8001. If the ML service is unreachable, `momentumFilter` falls back open cleanly.

---

## 4. Conclusion

The `engine.kc` codebase currently contains specific, remediable bottlenecks for R2 (Latency Optimization & Resource Efficiency):
1. **Candidate Decision Pipeline Timing**: Achievable <300ms latency by eliminating hardcoded `sleep(300)` in `candidateBuilder.js`, short-circuiting local checks, and streamlining enrichment queries.
2. **Rate Limiting**: Implementation of a domain-based rate limiter enforcing `sleep(300ms)` pacing across RPC, Jupiter, GMGN, and Rugcheck will eliminate HTTP 429 errors under signal bursts.
3. **Memory Bounding**: Converting 17 unbounded Map instances to `BoundedLRUMap` with LRU eviction and TTL will cap heap memory usage and eliminate memory leaks.
4. **Concurrency Control**: Wrapping all asynchronous polling loops in `src/app.js` and `src/signals/pumpportal.js` with mutex re-entrancy guards will eliminate overlapping executions.

---

## 5. Verification Method

### 5.1 Static Verification & Lint Check
To verify workspace file validity and ensure no syntax or global variable errors exist:
```bash
node lint.cjs
npm run check
```

### 5.2 Artifact Verification
Verify that survey artifacts exist in the agent directory:
- `/root/engine.kc/.agents/teamwork_preview_explorer_survey_2/survey_report.md`
- `/root/engine.kc/.agents/teamwork_preview_explorer_survey_2/handoff.md`
- `/root/engine.kc/.agents/teamwork_preview_explorer_survey_2/progress.md`
- `/root/engine.kc/.agents/teamwork_preview_explorer_survey_2/BRIEFING.md`
- `/root/engine.kc/.agents/teamwork_preview_explorer_survey_2/DISPATCH.md`

### 5.3 Invalidation Conditions
- Any failure of `node lint.cjs` or syntax errors in `src/`.
- Omission of any of the 4 requested survey dimensions (pipeline timing, rate limiting, unbounded caches, polling concurrency).
