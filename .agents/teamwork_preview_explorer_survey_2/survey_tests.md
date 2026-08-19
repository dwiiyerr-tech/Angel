# Charon Codebase Test Suite & Failure Survey (`survey_tests.md`)

**Agent**: Explorer 2 (Test Suite & Failure Explorer)  
**Date**: 2026-08-08  
**Working Directory**: `/root/Kaiser.charon/.agents/teamwork_preview_explorer_survey_2`  
**Repository Target**: `/root/Kaiser.charon`  

---

## 1. Executive Summary

This document presents a complete, rigorous survey of all test suites, test scripts, test harnesses, static analysis checks, backtest verification tools, and operational health check scripts in the `charon` repository.

### Key Survey Discoveries
1. **No Formal Unit Test Framework**: The `charon` codebase does not use standard JS test runners like Jest, Mocha, or Vitest. Instead, it relies on:
   - Built-in Node syntax check (`npm run check` -> `node --check`)
   - A custom Babel AST-based undeclared variable linter (`lint.cjs`)
   - 6 standalone Node integration test files (`test_custom.js`, `test_llm.js`, `test_migration_ws.js`, `test_server.js`, `scripts/test-spot-quote.mjs`, `scripts/test_exit_card.mjs`)
   - 10 Python backtest, analysis, and data verification scripts (`verify_backtest.py`, `analyze_positions.py`, `underground_wallet_finder.py`, `scripts/comprehensive_edge_backtest.py`, etc.)
   - Shell monitoring & health scripts (`scripts/health_check.sh`, `scripts/monitor.sh`, `start.sh`)

2. **Clean Syntax & Compilation Across Codebase**: 
   - All 61 JavaScript files in `src/` and project root pass Node syntax validation (`node --check`) with 0 syntax errors.
   - All 13 Python files pass python bytecode compilation (`python3 -m py_compile`) with 0 syntax errors.

3. **Primary Test Successes**:
   - Primary LLM HTTP connection (`test_llm.js`) passes against Hermes endpoint (`http://43.133.39.131:20128/v1`).
   - Price quote divergence assertion (`scripts/test-spot-quote.mjs`) passes (0.1179% divergence < 15% threshold).
   - Exit card visual PNG generation & binary header assertion (`scripts/test_exit_card.mjs`) passes cleanly for profit, loss, and rug scenarios.
   - Position PnL and trade statistics analyzer (`analyze_positions.py`) passes against `charon.sqlite`.
   - Underground wallet scanner (`underground_wallet_finder.py`) runs and initializes SQLite database successfully.

4. **Primary Test Failures & Defects Identified**:
   - **Missing Python Dependency**: `verify_backtest.py` fails with `ModuleNotFoundError: No module named 'pandas'`.
   - **Hardcoded Path Infrastructure Defect**: 11 Python, Shell, and startup scripts fail at runtime with `sqlite3.OperationalError: unable to open database file` or path errors due to hardcoded `/home/ubuntu/projects/charon/...` absolute paths instead of using relative paths or environment variables.
   - **Fallback LLM Server Unreachable**: `test_custom.js` `testFallbackLLM` sub-test fails with `socket hang up` at `http://localhost:8081/v1`.
   - **Telegram Polling Conflict**: `test_server.js` fetches signals from the server successfully (94 signals), but triggers a Telegram `409 Conflict: terminated by other getUpdates request` due to concurrent bot execution with the same API key.
   - **AST Linter Whitelist Defect**: `lint.cjs` flags `fetch` as undeclared in `src/signals/macroEngine.js:10` because Node 18+ global `fetch` is missing from the whitelist in `lint.cjs`.

---

## 2. Test Suite & Harness Inventory

| # | Test File / Command | Target Component / Capability | Type | Status |
|---|---|---|---|---|
| 1 | `npm run check` | Root & key `src/` entry points | Node Syntax Check | **PASS** |
| 2 | `node lint.cjs` | AST undeclared variable audit | AST Linter | **PASS with warning** |
| 3 | `node --check <all_js_files>` | 61 JS/MJS/CJS files across repo | Global Syntax Audit | **PASS** |
| 4 | `python3 -m py_compile <all_py>` | 13 Python files across repo | Python Bytecode Compilation | **PASS** |
| 5 | `node test_llm.js` | Primary LLM HTTP connection (`http://43.133.39.131:20128/v1`) | Integration Test | **PASS** |
| 6 | `node scripts/test-spot-quote.mjs` | Jupiter Quote API vs Asset API spot price divergence | Unit / API Test | **PASS** |
| 7 | `node scripts/test_exit_card.mjs` | Canvas PNG exit card generator and PNG byte validation | Unit / Visual Test | **PASS** |
| 8 | `python3 analyze_positions.py` | Position trade analysis & exit reason PnL statistics | Database Analysis | **PASS** |
| 9 | `python3 underground_wallet_finder.py` | Underground wallet discovery pipeline | Analysis Pipeline | **PASS** |
| 10 | `node test_custom.js` | Fallback LLM & PumpPortal WS connection | Integration Test | **FAIL** (LLM fallback socket hang up; PumpPortal WS OK) |
| 11 | `node test_server.js` | Signal server API fetch & Telegram polling | Integration Test | **FAIL** (Signal server OK; Telegram 409 Conflict) |
| 12 | `node test_migration_ws.js` | PumpPortal WebSocket stream observer | Stream Harness | **PASS / Running** |
| 13 | `python3 verify_backtest.py` | Backtest filter verification | Backtest Verification | **FAIL** (`ModuleNotFoundError: No module named 'pandas'`) |
| 14 | `python3 scripts/comprehensive_edge_backtest.py` | Feature extraction & edge backtest | Backtest Suite | **FAIL** (`sqlite3.OperationalError: unable to open database file`) |
| 15 | `python3 scripts/general_filter_backtest.py` | General filter backtest | Backtest Suite | **FAIL** (`sqlite3.OperationalError: unable to open database file`) |
| 16 | `python3 scripts/per_route_backtest.py` | Route-level backtest | Backtest Suite | **FAIL** (`sqlite3.OperationalError: unable to open database file`) |
| 17 | `python3 scripts/fill_reconstruct.py` | Trade fill reconstruction | Data Analysis | **FAIL** (`sqlite3.OperationalError: unable to open database file`) |
| 18 | `python3 scripts/full-enrichment-analysis.py` | Token enrichment analytics | Data Analysis | **FAIL** (`sqlite3.OperationalError: unable to open database file`) |
| 19 | `bash scripts/health_check.sh` | Process & trade health check | Shell Health Monitor | **FAIL** (Hardcoded `/home/ubuntu` DB path) |
| 20 | `bash scripts/monitor.sh` | Cron silent monitor alert script | Shell Monitor | **FAIL** (Hardcoded `/home/ubuntu` DB path) |
| 21 | `start.sh` | Application launch script | Shell Launcher | **FAIL** (Hardcoded `cd /home/ubuntu/...`) |
| 22 | `python3 scripts/dashboard.py` | HTML monitoring dashboard | HTTP Server | **FAIL** (Hardcoded `/home/ubuntu` DB path) |
| 23 | `python3 scripts/metrics_server.py` | Grafana JSON API server | HTTP Server | **FAIL** (Hardcoded `/home/ubuntu` DB path) |

---

## 3. Detailed Test Results & Failure Analysis

### 3.1 Passing Tests (Detailed Logs & Verifications)

#### Test 1: `npm run check`
- **Command**: `npm run check`
- **Command Details**: `node --check index.js && node --check src/app.js && node --check src/config.js && node --check src/liveExecutor.js`
- **Result**: `PASS` (Exit code 0)
- **Output**:
  ```text
  > charon@1.0.0 check
  > node --check index.js && node --check src/app.js && node --check src/config.js && node --check src/liveExecutor.js
  ```

#### Test 2: Primary LLM Connection (`test_llm.js`)
- **Command**: `node test_llm.js`
- **Result**: `PASS` (Exit code 0)
- **Output**:
  ```text
  Testing LLM Connection...
  URL: http://43.133.39.131:20128/v1
  Model: Hermes
  LLM Response Status: 200
  LLM Response Data: {"status":"WORKING"}
  LLM is WORKING.
  ```

#### Test 3: Spot Quote Divergence Assertions (`scripts/test-spot-quote.mjs`)
- **Command**: `node scripts/test-spot-quote.mjs`
- **Result**: `PASS` (Exit code 0)
- **Output**:
  ```text
  Token: GILF (2YxBvZ4BwYtoLdzf7pDAAQ6kExX94q5nz8RrLaPHpump)
  Entry: $0.0000755706392717288  mcap: $73943.6462830836

  Quote API price:   $0.0000137415
  Asset API price:  $0.0000137253

  Divergence: 0.1179%  (threshold: <15%)
  PASS
  ```

#### Test 4: Exit Card Generation & Binary PNG Validation (`scripts/test_exit_card.mjs`)
- **Command**: `node scripts/test_exit_card.mjs`
- **Result**: `PASS` (Exit code 0)
- **Output**:
  ```text
  [profit] OK  /tmp/test_exit_card.png  61973 bytes  800x420  depth=8 colorType=6
  [loss] OK  /tmp/test_exit_card_loss.png  63267 bytes  800x420  depth=8 colorType=6
  [rug] OK  /tmp/test_exit_card_rug.png  63099 bytes  800x420  depth=8 colorType=6
  ```

#### Test 5: Position Statistics Analyzer (`analyze_positions.py`)
- **Command**: `python3 analyze_positions.py`
- **Result**: `PASS` (Exit code 0)
- **Summary Output**: Analyzed 123 closed dry run trades from `charon.sqlite`. Win Rate: 24.4%, Total PnL: -0.2352 SOL. Exit reasons broken down into SL (66 trades), BREAK_EVEN (1 trade), MAX_HOLD (16 trades), SIDEWAYS_TIMEOUT (23 trades), TRAILING_TP (17 trades).

---

### 3.2 Failing Tests & Runtime Errors (Detailed Error Traces)

#### Failure 1: Missing `pandas` Dependency in `verify_backtest.py`
- **Command**: `python3 verify_backtest.py`
- **Result**: `FAIL` (Fatal Runtime Error)
- **Error Trace**:
  ```text
  Traceback (most recent call last):
    File "verify_backtest.py", line 4, in <module>
      import pandas as pd
  ModuleNotFoundError: No module named 'pandas'
  ```
- **Failing Line**: `verify_backtest.py:4` (`import pandas as pd`)
- **Root Cause**: The python environment lacks `pandas`. Additionally, line 6 contains hardcoded path `DB_PATH = "/home/ubuntu/projects/charon/charon.sqlite"`.

#### Failure 2: Fallback LLM Connection Timeout / Socket Hangup in `test_custom.js`
- **Command**: `node test_custom.js`
- **Result**: `PARTIAL FAIL`
- **Error Trace**:
  ```text
  --- Testing Fallback LLM ---
  URL: http://localhost:8081/v1 | Model: gemini 3.5 flash
  Fallback LLM Failed: socket hang up
  ```
- **Failing Code Line**: `test_custom.js:24` (`console.error('Fallback LLM Failed:', e.message);`)
- **Root Cause**: Local fallback LLM server at `http://localhost:8081/v1` is not running or rejected the HTTP POST connection.

#### Failure 3: Telegram Bot 409 Conflict in `test_server.js`
- **Command**: `node test_server.js`
- **Result**: `PARTIAL FAIL`
- **Error Trace**:
  ```text
  SIGNAL_SERVER_URL: 'https://api.thecharon.xyz/api'
  [server] 94 signals, 94 triggered, tracking 94
  error: [polling_error] {"code":"ETELEGRAM","message":"ETELEGRAM: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}
  ```
- **Failing Code Location**: `src/signals/serverClient.js` called from `test_server.js:4`
- **Root Cause**: Calling `fetchServerSignals()` initiates Telegram polling using the production Telegram token, which conflicts with another active Telegram bot polling process.

#### Failure 4: Hardcoded Database Path Failure in `scripts/comprehensive_edge_backtest.py`
- **Command**: `python3 scripts/comprehensive_edge_backtest.py`
- **Result**: `FAIL` (Fatal Runtime Error)
- **Error Trace**:
  ```text
  Traceback (most recent call last):
    File "scripts/comprehensive_edge_backtest.py", line 428, in <module>
    File "scripts/comprehensive_edge_backtest.py", line 209, in main
  sqlite3.OperationalError: unable to open database file
  ```
- **Failing Line**: `scripts/comprehensive_edge_backtest.py:11`:
  ```python
  DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'
  ```
- **Root Cause**: The script hardcodes `/home/ubuntu/projects/charon/charon.sqlite`, which does not exist on standard workspace paths like `/root/Kaiser.charon/charon.sqlite`.

#### Failure 5: Hardcoded Database Path Failure in `scripts/general_filter_backtest.py`
- **Command**: `python3 scripts/general_filter_backtest.py`
- **Result**: `FAIL` (Fatal Runtime Error)
- **Error Trace**:
  ```text
  Traceback (most recent call last):
    File "scripts/general_filter_backtest.py", line 184, in <module>
    File "scripts/general_filter_backtest.py", line 52, in main
  sqlite3.OperationalError: unable to open database file
  ```
- **Failing Line**: `scripts/general_filter_backtest.py:6`: `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'`

#### Failure 6: Hardcoded Database Path Failure in `scripts/per_route_backtest.py`
- **Command**: `python3 scripts/per_route_backtest.py`
- **Result**: `FAIL` (Fatal Runtime Error)
- **Error Trace**:
  ```text
  Traceback (most recent call last):
    File "scripts/per_route_backtest.py", line 194, in <module>
    File "scripts/per_route_backtest.py", line 153, in main
  sqlite3.OperationalError: unable to open database file
  ```
- **Failing Line**: `scripts/per_route_backtest.py:6`: `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'`

#### Failure 7: Hardcoded Database Path Failure in `scripts/fill_reconstruct.py`
- **Command**: `python3 scripts/fill_reconstruct.py`
- **Result**: `FAIL` (Fatal Runtime Error)
- **Error Trace**:
  ```text
  Traceback (most recent call last):
    File "scripts/fill_reconstruct.py", line 155, in <module>
    File "scripts/fill_reconstruct.py", line 68, in main
  sqlite3.OperationalError: unable to open database file
  ```
- **Failing Line**: `scripts/fill_reconstruct.py:19`: `DB = "/home/ubuntu/projects/charon/charon.sqlite"`

#### Failure 8: Hardcoded Database Path Failure in `scripts/full-enrichment-analysis.py`
- **Command**: `python3 scripts/full-enrichment-analysis.py`
- **Result**: `FAIL` (Fatal Runtime Error)
- **Error Trace**:
  ```text
  Traceback (most recent call last):
    File "scripts/full-enrichment-analysis.py", line 201, in <module>
    File "scripts/full-enrichment-analysis.py", line 136, in main
  sqlite3.OperationalError: unable to open database file
  ```
- **Failing Line**: `scripts/full-enrichment-analysis.py:18`: `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'`

#### Failure 9: Undeclared Variable Warning in `node lint.cjs`
- **Command**: `node lint.cjs`
- **Result**: `WARNING / LINT FAILURE`
- **Output**:
  ```text
  src/signals/macroEngine.js: Undeclared: [ 'fetch (L10)' ]
  ```
- **Failing Line**: `lint.cjs:17` (`let globals = new Set([...])`) missing `'fetch'`.
- **Root Cause**: `lint.cjs` lacks `fetch` in its global identifier whitelist.

---

## 4. Identification of Skipped, Commented-Out, or Disabled Tests

1. **Skipped/Disabled Test Suites**:
   - Standard automated unit test runners (e.g. `npm test` script in `package.json`) are **missing**.
   - No `jest`, `mocha`, `vitest`, or `pytest` configurations or test suites are registered in `package.json`.

2. **Commented-Out Test Code Blocks**:
   - `test_custom.js` lines 44-55: `testPumpFun()` connects to PumpPortal WS and auto-closes after 2000ms delay.
   - `test_migration_ws.js`: Test script runs a 60-minute loop logging new tokens and migrations.

3. **Bypassed / Disabled Feature Flags in Backtest Scripts**:
   - `verify_backtest.py` checks whether candidates bypassed filters, but the script itself is currently broken by `pandas` import failure.

---

## 5. Comprehensive Summary Recommendations for Fixer Agents

To achieve 100% test suite pass rate and production readiness (Acceptance Criteria R1 & R2):

1. **Install Missing Dependencies**:
   - Install `pandas` (or add `pandas` to system python/venv) so `verify_backtest.py` can execute.

2. **Fix Hardcoded Path Defects**:
   - Update `DB_PATH` in `verify_backtest.py`, `scripts/comprehensive_edge_backtest.py`, `scripts/general_filter_backtest.py`, `scripts/per_route_backtest.py`, `scripts/fill_reconstruct.py`, `scripts/full-enrichment-analysis.py`, `scripts/dashboard.py`, `scripts/metrics_server.py`, `scripts/health_check.sh`, `scripts/monitor.sh`, and `start.sh` to dynamically resolve relative to project root (e.g., `os.path.join(os.path.dirname(__file__), '../charon.sqlite')` or process environment variable `DB_PATH`).

3. **Update `lint.cjs` Whitelist**:
   - Add `'fetch'` to the `globals` Set in `lint.cjs` to eliminate undeclared variable lint warning for `src/signals/macroEngine.js`.

4. **Standardize Test Command (`npm test`)**:
   - Add a standard `"test"` script entry to `package.json` that runs `npm run check`, `node lint.cjs`, and all non-destructive Node/Python test scripts.

5. **Provide Mocking or Fallback Handling for Remote LLM / Telegram**:
   - In `test_custom.js` and `test_server.js`, handle unreachable fallback LLM servers gracefully and isolate Telegram bot polling in test mode to avoid 409 conflict errors.
