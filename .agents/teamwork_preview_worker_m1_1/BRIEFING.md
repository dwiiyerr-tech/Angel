# BRIEFING — 2026-08-08T04:26:00Z

## Mission
Implement Milestone M1 infrastructure fixes: remove hardcoded absolute paths across 11 scripts, install python dependencies via requirements.txt, and update AST linter global symbols.

## 🔒 My Identity
- Archetype: worker
- Roles: implementer, qa, specialist
- Working directory: /root/Kaiser.charon/.agents/teamwork_preview_worker_m1_1
- Original parent: 0c390ee1-a119-432a-8f68-e022e7644953
- Milestone: M1

## 🔒 Key Constraints
- DO NOT CHEAT: All implementations must be genuine.
- Minimal change principle: only modify what is necessary.
- Verify every change with real execution.

## Current Parent
- Conversation ID: 0c390ee1-a119-432a-8f68-e022e7644953
- Updated: 2026-08-08T04:26:00Z

## Task Summary
- **What to build**:
  1. Fix hardcoded paths in 11 scripts (`start.sh`, `verify_backtest.py`, `scripts/comprehensive_edge_backtest.py`, `scripts/dashboard.py`, `scripts/metrics_server.py`, `scripts/general_filter_backtest.py`, `scripts/per_route_backtest.py`, `scripts/fill_reconstruct.py`, `scripts/full-enrichment-analysis.py`, `scripts/health_check.sh`, `scripts/monitor.sh`).
  2. Create `requirements.txt` and install python dependencies (`pandas`, `numpy`, `scikit-learn`, `requests`, `httpx`).
  3. Add `'fetch'` to `globals` Set in `lint.cjs`.
- **Success criteria**:
  - `grep -rn "/home/ubuntu" start.sh verify_backtest.py scripts/` returns 0 matches.
  - Python imports for pandas, numpy, sklearn, requests, httpx succeed.
  - `node lint.cjs` runs without error on `macroEngine.js:10`.
  - Scripts execute cleanly without path errors.

## Change Tracker
- **Files modified**:
  - `lint.cjs`: Added 'fetch' to globals Set.
  - `requirements.txt`: Created dependency manifest.
  - (11 scripts pending path replacement)
- **Build status**: IN_PROGRESS
- **Pending issues**: None

## Quality Status
- **Build/test result**: TBD
- **Lint status**: lint.cjs updated
- **Tests added/modified**: Verification commands prepared
