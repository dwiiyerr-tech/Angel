## 2026-08-07T20:24:37Z
You are Worker 1 for Milestone M1 (Infrastructure & Environment Fixes).
Your working directory is: /root/Kaiser.charon/.agents/teamwork_preview_worker_m1_1

Required context files:
- ORIGINAL_REQUEST: /root/Kaiser.charon/.agents/ORIGINAL_REQUEST.md
- PROJECT: /root/Kaiser.charon/PROJECT.md
- SCOPE: /root/Kaiser.charon/.agents/sub_orch_m1/SCOPE.md
- Explorer 1 (M1-PATH) Report: /root/Kaiser.charon/.agents/teamwork_preview_explorer_m1_1/handoff.md
- Explorer 2 (M1-PYDEP) Report: /root/.gemini/antigravity-cli/brain/869a99bb-509f-4e79-ab47-b2dac900d177/handoff_m1_2.md
- Explorer 3 (M1-LINT) Report: /root/Kaiser.charon/.agents/teamwork_preview_explorer_m1_3/handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Assigned Work Items:

1. M1-PATH: Fix hardcoded `/home/ubuntu/projects/charon` absolute paths across 11 scripts:
   - `start.sh`: Replace `cd /home/ubuntu/projects/charon` with dynamic script directory resolution:
     `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`
     `cd "$SCRIPT_DIR"`
   - `verify_backtest.py`: Replace `DB_PATH = "/home/ubuntu/projects/charon/charon.sqlite"` with:
     `SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))`
     `DB_PATH = os.path.join(SCRIPT_DIR, "charon.sqlite")`
   - `scripts/comprehensive_edge_backtest.py`: Replace `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'` with:
     `SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))`
     `PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)`
     `DB_PATH = os.path.join(PROJECT_ROOT, 'charon.sqlite')`
   - `scripts/dashboard.py`: Replace `DB = "/home/ubuntu/projects/charon/charon.sqlite"` with:
     `SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))`
     `PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)`
     `DB = os.path.join(PROJECT_ROOT, "charon.sqlite")`
   - `scripts/metrics_server.py`: Replace `DB = "/home/ubuntu/projects/charon/charon.sqlite"` with:
     `SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))`
     `PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)`
     `DB = os.path.join(PROJECT_ROOT, "charon.sqlite")`
   - `scripts/general_filter_backtest.py`: Replace `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'` with:
     `SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))`
     `PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)`
     `DB_PATH = os.path.join(PROJECT_ROOT, 'charon.sqlite')`
   - `scripts/per_route_backtest.py`: Replace `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'` with:
     `SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))`
     `PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)`
     `DB_PATH = os.path.join(PROJECT_ROOT, 'charon.sqlite')`
   - `scripts/fill_reconstruct.py`: Replace `DB = "/home/ubuntu/projects/charon/charon.sqlite"` and `out = "/home/ubuntu/projects/charon/reports/fill_recon.json"` with dynamic PROJECT_ROOT resolution and `os.makedirs(out_dir, exist_ok=True)`.
   - `scripts/full-enrichment-analysis.py`: Replace `DB_PATH = '/home/ubuntu/projects/charon/charon.sqlite'` with dynamic PROJECT_ROOT resolution.
   - `scripts/health_check.sh`: Replace `DB="/home/ubuntu/projects/charon/charon.sqlite"` and `cd /home/ubuntu/projects/charon` with dynamic PROJECT_ROOT resolution.
   - `scripts/monitor.sh`: Replace `DB="/home/ubuntu/projects/charon/charon.sqlite"` with dynamic PROJECT_ROOT resolution.

2. M1-PYDEP: Create `/root/Kaiser.charon/requirements.txt` with required dependencies (`pandas`, `numpy`, `scikit-learn`, `requests`, `httpx`), and run `pip3 install -r requirements.txt` to install and verify Python dependencies.

3. M1-LINT: Update `/root/Kaiser.charon/lint.cjs` line 17 to add `'fetch'` to the `globals` Set.

Verification Instructions:
- Run `grep -rn "/home/ubuntu" start.sh verify_backtest.py scripts/` to confirm 0 matches remain in scripts.
- Run `python3 -c "import pandas, numpy, sklearn, requests, httpx; print('ALL DEPS INSTALLED SUCCESSFULLY')"`
- Run `node lint.cjs` to confirm linter passes without undeclared variable errors on `macroEngine.js:10`.
- Test execution of affected scripts (`bash -n start.sh`, `python3 verify_backtest.py`, `python3 scripts/comprehensive_edge_backtest.py --help`, `node lint.cjs`).

Write your completion status, command outputs, and handoff report to `/root/Kaiser.charon/.agents/teamwork_preview_worker_m1_1/handoff.md` and send a message when complete.
