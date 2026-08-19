# Charon Upgrade & Hardening Log

**Date:** 2026-08-09  
**Scope:** Multi-Agent Code Audit, System Hardening, & Cooldown Optimizations  
**Impact:** Zero unhandled promise crashes, Eliminated DB locking issues, Optimized API costs, Faster screening frequency.

---

## 🛠️ 1. Node.js Core & Pipeline Fixes

### Orchestrator & Deduplication (`src/pipeline/orchestrator.js`)
- **Race Condition Fixed:** `refreshCandidateForExecution` now properly rejects (`Promise.reject()`) if fresh data cannot be fetched, rather than executing on stale (outdated) data.
- **Cooldown Relaxed:** 
  - Reduced LLM Decision Cache TTL from `24 hours` ➔ `2 hours` to catch rapid market narrative shifts.
  - Reduced Post-Trade Cooldown from `72 hours` ➔ `4 hours` to allow re-entry on strong runners after a Take Profit / Stop Loss.
- **NaN Bug Fixed:** Fixed an edge case where missing timestamps resulted in `NaN` hold durations.

### LLM Pipeline (`src/pipeline/llm.js`)
- **Dual LLM Consensus Optimization:** Previously, the fallback model (`LLM_FALLBACK_MODEL`) was called on *every* token, wasting credits. It is now strictly conditioned to only trigger if the Primary LLM votes `BUY`.

### Execution & Router (`src/execution/positions.js`, `src/execution/router.js`)
- **Infinite Retry Loop Fixed:** If a Partial Take Profit (`executeLiveSell`) failed, the system would infinitely retry. It now forces a DB update `partial_tp_done = 1` even on failure to break the loop.
- **Math Clamp:** Bound `trailDrop` calculations to `-100%` minimum to prevent extreme negative math glitches.
- **Fatal Error Handling:** Added fatal error detection in Jupiter swap retries. It now aborts retries immediately on known failures like "insufficient funds" or extreme slippage.
- **DB Crash Prevention:** Added input sanitization to prevent `NULL` values from crashing SQLite `INSERT` statements during failed trade logging.

---

## 🐍 2. Python Analytics & Machine Learning

### Python Momentum Daemon (`src/pipeline/momentumFilter.js`)
- **Architectural Shift:** Replaced the highly inefficient method of spawning a fresh Python process for every candidate. The momentum filter now uses a **Long-lived Python Daemon** that receives data asynchronously via `stdin`. 
- **Impact:** Eliminates 100% CPU spikes and Out-of-Memory (OOM) crashes when 10+ tokens are detected simultaneously.

### Analysis Script Hardening (`analyze_positions.py`)
- **SQLite Concurrency:** Added `timeout=30` to the SQLite connection string. This prevents the Python script from throwing `database is locked` errors when the Node.js core (running in WAL mode) is heavily writing.
- **ZeroDivisionError:** Patched division-by-zero crashes in Win Rate calculations.
- **Null Handling:** Added safe fallback for tokens with `NULL` `entry_mcap`.

### Underground Wallet Finder (`underground_wallet_finder.py`)
- **API Validation:** Script now validates the Helius API key on startup and cleanly exits if missing, rather than failing silently mid-scan.
- **Thread Safety:** Replaced the fragile and thread-unsafe `signal.alarm()` timeout implementation with native `requests` timeouts.
- **Score Inflation:** Fixed the consistency score calculation to enforce a minimum 1-day time span (`span = max(..., 1.0)`), preventing burst-trading bots from getting inflated consistency scores.

### Gemini Web2API Bridge (`gemini_web2api.py`)
- **JSON Error Handling:** Bad requests now correctly return HTTP `400 Bad Request` instead of crashing the server with `500 Internal Server Error`.
- **Stream Fallback:** If the HTTP 405 stream fallback fails, it now gracefully yields an error text chunk to the client rather than abruptly dropping the connection.
- **Config Edge Case:** Fixed a crash triggered when `retry_attempts` was set to `0`.

---

## 🏗️ 3. Infrastructure

### Unified Setup (`setup.sh`)
- Created a `setup.sh` bash script in the root directory to unify dependency installation (`npm install` && `pip install -r requirements.txt`) for easier onboarding and deployments.
