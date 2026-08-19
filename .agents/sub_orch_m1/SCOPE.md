# Scope: M1 Infrastructure & Environment Fixes

## Assigned Scope (Milestone M1):
1. **M1-PATH**: Fix hardcoded `/home/ubuntu/projects/charon` absolute paths across 11 operational, backtest, and utility scripts (`start.sh`, `verify_backtest.py`, `scripts/comprehensive_edge_backtest.py`, `scripts/dashboard.py`, `scripts/metrics_server.py`, `scripts/general_filter_backtest.py`, `scripts/per_route_backtest.py`, `scripts/fill_reconstruct.py`, `scripts/full-enrichment-analysis.py`, `health_check.sh`, `monitor.sh`). Replace hardcoded paths with dynamic project root detection (e.g. `process.cwd()` or `os.path.dirname` or relative to script location) so they work reliably under `/root/Kaiser.charon`.
2. **M1-PYDEP**: Ensure Python environment dependencies (e.g. `pandas` required by `verify_backtest.py`) are installed and functional.
3. **M1-LINT**: Update `lint.cjs` global symbol whitelist to include `fetch` so `node lint.cjs` parses `src/signals/macroEngine.js:10` without undeclared variable errors.

## Work Items & Subagents Loop
- **Iteration 1**:
  - Explorer: `teamwork_preview_explorer` (analyze exact line numbers and code changes)
  - Worker: `teamwork_preview_worker` (implement changes, verify syntax/execution)
  - Reviewer: `teamwork_preview_reviewer` (review diffs)
  - Challenger: `teamwork_preview_challenger` (run affected scripts)
  - Auditor: `teamwork_preview_auditor` (forensic integrity verification)
