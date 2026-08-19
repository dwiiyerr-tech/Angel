## 2026-08-08T04:15:53Z

<USER_REQUEST>
You are Sub-Orchestrator for Milestone 1 (M1: Infrastructure & Environment Fixes) of the charon codebase stabilization project.

Working Directory: /root/Kaiser.charon/.agents/sub_orch_m1
Project Scope Document: /root/Kaiser.charon/PROJECT.md
Original Request: /root/Kaiser.charon/.agents/ORIGINAL_REQUEST.md

Your Assigned Scope (Milestone M1):
1. M1-PATH: Fix hardcoded `/home/ubuntu/projects/charon` absolute paths across 11 operational, backtest, and utility scripts (`start.sh`, `verify_backtest.py`, `scripts/comprehensive_edge_backtest.py`, `scripts/dashboard.py`, `scripts/metrics_server.py`, `scripts/general_filter_backtest.py`, `scripts/per_route_backtest.py`, `scripts/fill_reconstruct.py`, `scripts/full-enrichment-analysis.py`, `health_check.sh`, `monitor.sh`). Replace hardcoded paths with dynamic project root detection (e.g. `process.cwd()` or `os.path.dirname` or relative to script location) so they work reliably under `/root/Kaiser.charon`.
2. M1-PYDEP: Ensure Python environment dependencies (e.g. `pandas` required by `verify_backtest.py`) are installed and functional.
3. M1-LINT: Update `lint.cjs` global symbol whitelist to include `fetch` so `node lint.cjs` parses `src/signals/macroEngine.js:10` without undeclared variable errors.

Your Instructions:
1. Create `SCOPE.md` in your working directory `/root/Kaiser.charon/.agents/sub_orch_m1/SCOPE.md`.
2. Execute the iteration loop: Explorer -> Worker -> Reviewer -> Challenger -> Auditor gate loop to complete M1.
   - Dispatch Explorer to analyze exact line numbers and code changes needed for M1.
   - Dispatch Worker (`teamwork_preview_worker`) to implement the changes and verify syntax/execution.
   - Dispatch Reviewer (`teamwork_preview_reviewer`) to review the diffs.
   - Dispatch Challenger (`teamwork_preview_challenger`) to run the affected scripts.
   - Dispatch Forensic Auditor (`teamwork_preview_auditor`) to perform integrity verification.
3. Once all gate checks pass, record completion in your `progress.md` and send a handoff message back to parent orchestrator (`babc7aa8-5183-470b-8057-3dc02f159a43`).
</USER_REQUEST>
