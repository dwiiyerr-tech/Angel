# Handoff Report — Codebase Structure & Infrastructure Survey

**Agent**: Explorer 1 (Codebase Structure & Infra Explorer)  
**Target Path**: `/root/Kaiser.charon`  
**Artifact Directory**: `/root/Kaiser.charon/.agents/teamwork_preview_explorer_survey_1`  
**Report File**: `survey_infra.md`

---

## 1. Observation

1. **Repository Core Stack & Layout**:
   - `package.json` specifies `"type": "module"`, `"name": "charon"`, `"version": "1.0.0"`, Node.js engine requirement `>= 20`.
   - Core JavaScript codebase in `src/` (62 JS files across `db/`, `enrichment/`, `evolution/`, `execution/`, `learning/`, `pipeline/`, `signals/`, `telegram/`, `visuals/`).
   - Bundled Python scripts and ML artifacts: `src/pipeline/predict_momentum.py` uses `models/momentum_model.pkl`, `models/momentum_scaler.pkl`, and `models/momentum_features.json`.
   - SQLite database files present at root: `charon.sqlite` (531.9 MB), `charon.sqlite-wal` (4.3 MB), `charon.sqlite-shm` (32.8 KB). Schema migration present in `migrations/001_decision_cache.sql`.

2. **Syntax and Execution Tool Results**:
   - `npm run check` (`node --check index.js && node --check src/app.js && node --check src/config.js && node --check src/liveExecutor.js`) exited with code `0`.
   - Custom test script iterating through all 72 `.js`/`.mjs`/`.cjs` files (`node --check <file>`) exited with code `0` (all 72 files passed syntax check).
   - Python compilation check (`python3 -c "import glob, py_compile; ..."`) exited with code `0` (all 13 `.py` files passed syntax check).
   - `node scripts/test_exit_card.mjs` exited with code `0` (`[profit] OK /tmp/test_exit_card.png 61925 bytes 800x420`, `[loss] OK`, `[rug] OK`).
   - `node scripts/test-spot-quote.mjs` exited with code `0` (`Divergence: 1.2518% (threshold: <15%) PASS`).
   - `echo '{}' | python3 src/pipeline/predict_momentum.py` exited with code `0` (`{"momentum_score": 0.2309, ...}`).
   - `node lint.cjs` exited with code `0`, output: `src/signals/macroEngine.js: Undeclared: [ 'fetch (L10)' ]`.

3. **Hardcoded Environment Paths**:
   - `grep_search` for `/home/ubuntu` returned 15 files, including 11 active scripts:
     - `start.sh:2`: `cd /home/ubuntu/projects/charon`
     - `verify_backtest.py:6`: `DB_PATH = "/home/ubuntu/projects/charon/charon.sqlite"`
     - `scripts/comprehensive_edge_backtest.py:11`: `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'`
     - `scripts/dashboard.py:17`: `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'`
     - `scripts/fill_reconstruct.py`, `scripts/full-enrichment-analysis.py`, `scripts/general_filter_backtest.py`, `scripts/health_check.sh`, `scripts/metrics_server.py`, `scripts/monitor.sh`, `scripts/per_route_backtest.py`.
   - Running `python3 scripts/comprehensive_edge_backtest.py --help` failed with `sqlite3.OperationalError: unable to open database file` due to hardcoded `/home/ubuntu/projects/charon/charon.sqlite`.

---

## 2. Logic Chain

1. *From Observation 1*: The project is structured as a Node.js 20+ ES Module application with Python 3 sub-processes for ML inference and analytical backtesting. Native C/C++ build tools (`build-essential`, `libcairo2-dev`, `libpango1.0-dev`) are required by `better-sqlite3` and `canvas`.
2. *From Observation 2*: All primary JavaScript entry points (`index.js`, `src/app.js`, `src/config.js`, `src/liveExecutor.js`) and all 72 JS/MJS/CJS source files compile cleanly under Node.js syntax validation. The Python ML model daemon loads its binary artifacts (`.pkl`) and executes inference without error. Main canvas visual card generation and spot quote verification scripts execute and pass.
3. *From Observation 3*: The codebase has hardcoded absolute path assumptions (`/home/ubuntu/projects/charon`) in `start.sh`, `verify_backtest.py`, and 9 utility scripts in `scripts/`. Running these scripts in the workspace directory (`/root/Kaiser.charon`) fails at runtime when attempting to connect to SQLite or switch directories.

---

## 3. Caveats

- Live market signals (`pumpportal.js`, `gmgnSignal.js`), external API connectivity (`GMGN_API_KEY`, `HELIUS_API_KEY`, `JUPITER_API_KEY`), and Solana wallet transaction signing (`live` mode) require external API credentials in `.env` and live network access.
- Deep static analysis of logic errors across all strategies or pipeline filters was not performed (scope reserved for bug-hunting / domain explorer tasks).

---

## 4. Conclusion

The `charon` codebase has a clean modular architecture and its primary Node.js and Python codebases pass syntax validation and binary model loading without syntax errors. However, there is an infrastructure defect: 11 operational and backtest scripts contain hardcoded `/home/ubuntu/projects/charon` absolute paths, which breaks script invocation in non-standard deployment paths like `/root/Kaiser.charon`.

---

## 5. Verification Method

1. **Check Node.js Syntax & Main Entrypoints**:
   ```bash
   cd /root/Kaiser.charon
   npm run check
   ```
2. **Verify Visual Card Generator Test**:
   ```bash
   node scripts/test_exit_card.mjs
   ```
3. **Verify Python ML Momentum Model Inference**:
   ```bash
   echo '{}' | python3 src/pipeline/predict_momentum.py
   ```
4. **Inspect Hardcoded Path Invalidation**:
   ```bash
   grep -rn "/home/ubuntu" scripts/ start.sh verify_backtest.py
   ```
