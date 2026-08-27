# 👼 Angel

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)

**Angel** adalah bot Telegram cerdas berbasis Node.js untuk memonitor, memfilter dengan Machine Learning, dan mengeksekusi trading token Solana pump.fun via Jupiter Exchange.

Angel berawal sebagai fork dari [Charon](https://github.com/yunus-0x/charon) oleh [@yunus-0x](https://github.com/yunus-0x), dan kini telah berkembang menjadi bot mandiri dengan filter momentum ML, empat domain evidence, model Edge deterministik, dan guard eksekusi ketat. Mode publiknya adalah `paper` (nol modal riil) dan `live` (tetap memerlukan approval owner).

## What changed in this fork

- **FLOW filter** — candidates need `s1h_priceChange >= 0` and `net_buyer_ratio_5m >= 0.2` before they enter the pipeline. Cut a lot of dying-chart entries.
- **PumpPortal WebSocket source** — real-time graduated-token stream instead of polling. Also feeds the pre-graduation scanner.
- **Pre-grad scanner** — optional module that watches tokens before they hit the bonding curve cap.
- **GMGN signed auth** — enrichment calls use Ed25519-signed requests against GMGN's API for holder counts, fees, and socials.
- **Trailing TP guard** — trailing take-profit no longer triggers on underwater positions. It used to "lock in profits" at a loss. Fixed.
- **Tightened exit logic** — trailing stop narrows once a position clears a peak threshold, with a profit floor after arming. Reduces giving back runners.
- **Fill-to-fill dry run pricing** — paper entries use an executable Jupiter buy quote and exits use executable Jupiter sell quotes, instead of synthetic mark prices. Recorded PnL includes the simulated entry/exit fill difference and execution fees, so dry-run results track live execution more closely.
- **Telegram reports + visual cards** — daily PnL reports and rendered entry/exit cards.
- **Backtest tooling** — scripts that run filter candidates against local trade history so changes get measured before they get deployed.
- **Live execution hardening** — realized PnL tracking, sell guards, Jupiter Ultra routing.

Everything from the original still applies: signal server, strategies (`sniper`, `dip_buy`, `smart_money`, `degen`), hot-reloaded config in SQLite, Telegram menus, the works.

## Latest additions (August 2026)

This fork now includes:

- **Deterministic Edge authority** — Safety veto, Market/On-chain/Flow/Narrative evidence, calibrated survival/runner/route models, and bounded position sizing. LLM is configuration-analysis only.
- **Asymmetric runner lifecycle** — PAPER probe-to-scale, immediate catastrophic stop, flow-aware trailing, first-passage labels, and gap-aware executable v32-v33 replay.
- **Counterfactual reject tracking** — WATCH/PASS and early screening rejects receive executable outcome probes, so missed runners train the models instead of disappearing.
- **Versioned rollback** — human-gated config challengers plus an optional VPS release-slot guard for atomic v33-to-v32 rollback. Both remain PAPER-only by default.
- **Multi-source signal fan-in** — exact route blocking plus PumpPortal, Trending, trenches, fee, pre-grad, and smart-money evidence merging per mint.
- **ML Momentum Filter** (`src/pipeline/momentumFilter.js` + `src/pipeline/predict_momentum.py`) — Python subprocess scoring candidates 0.0-1.0 using the bundled model artifacts in `models/`. Uses `momentum_threshold` (default `0.5`). The model, scaler, and feature metadata are included in the repository, so forks can run momentum scoring immediately.
- **Hybrid Filter Strategy** (`OPTION_C_IMPLEMENTATION.md`) — bot holders ≥25% → HARD REJECT; holder deadzone [100,400] + dev migrations ≥20 → 50% size cut. Expected +20 SOL uplift based on 30-day backtest.
- **Tier 1 Universal Filters** (`TIER1_FILTERS.md`) — 3 data-driven filters from 634-trade backtest with bucketed evidence.
- **Code Audit** (`AUDIT_OPUS_2026-07-07.md`) — Claude Opus 4.8 static audit: 3 CRITICAL findings including C1 (Jupiter slippage cap never sent) and C2 (post-swap dedup → orphaned tokens).
- **Backtest Edge Analysis** (`BACKTEST_EDGE_2026-07-07.md`) — 1,146-position split-half backtest showing regime decay: 40.3% WR (+5.1 SOL) → 25.7% WR (-3.9 SOL).
- **Bug Fixes** (`BUGFIX_SUMMARY.md`) — 4 LLM-layer fixes: cache, pre-filter guard, execution failure logging, past-win audit trail.

## Requirements

- **Node.js 20+** (developed on v22).
- **Native build tools** — `better-sqlite3` and `canvas` compile from source:
  - Debian/Ubuntu: `sudo apt install -y build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
  - macOS: `xcode-select --install` and `brew install pkg-config cairo pango libpng jpeg giflib librsvg`
- A **Telegram bot token** and your chat ID.
- A **signal server key** — see the [original repo](https://github.com/yunus-0x/charon) for access.
- A **Helius RPC endpoint** (free tier is fine for `dry_run`).
- For `live` mode only: a **Solana wallet private key** and a **Jupiter API key**.

## Setup

```bash
git clone https://github.com/dwiiyerr-tech/Angel.git
cd Angel
npm install
cp .env.example .env
# fill in .env — at minimum: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
# SIGNAL_SERVER_KEY, HELIUS_API_KEY / SOLANA_RPC_URL
npm run check   # syntax check before first boot
npm start
```

The SQLite database is created automatically at `DB_PATH` on first run. Nothing else to provision.

If `npm install` fails on `better-sqlite3` or `canvas`, it's the native build — install the build tools listed above and retry.

## Configuration

`.env.example` documents every environment variable the bot reads. The ones without a default are the ones you actually have to fill in; the rest have sane values already.

Optional subsystems are off by default and stay off until you set their flag:

- `GMGN_ENABLED=true` — enrichment via GMGN (on by default; set `false` to fall back to Jupiter data)
- `PUMPPORTAL_ENABLED=true` — real-time WebSocket signals, needs `PUMPPORTAL_API_KEY`
- `PREGRAD_ENABLED=true` — pre-graduation scanner
- `ENABLE_LLM=true` — optional configuration analyst; it cannot select entries, bypass Safety/Risk, promote itself, or enable LIVE

Strategy parameters live in SQLite, not `.env`, and are hot-read — most tuning happens from the Telegram chat without restarts. API keys and RPC URLs are env values, so those need a restart.

## Usage

Run it, open Telegram, `/menu`.

Start with `TRADING_MODE=paper`. Collect at least 14 days, 100 total outcomes, and 30 outcomes per represented route. PAPER uses executable Jupiter quotes for entry and exit, but it remains an estimate: live swaps add wallet state, finality, and timing risk. LIVE v33 authorities remain disabled until explicitly approved.

## Honest warnings

- This trades memecoins. Most memecoins go to zero. The bot's edge is catching the few that don't — one good runner pays for a lot of small losses, and that's the whole strategy. If the runners don't show up, the PnL is negative. That's not a bug.
- Live mode signs transactions automatically. Use a dedicated wallet with money you can afford to lose completely.
- GMGN rate limits are aggressive. Don't lower `GMGN_REQUEST_DELAY_MS` below 2500 unless you enjoy banned API keys.
- Never commit your `.env`. It's gitignored — keep it that way.

## Credit

Original project: [yunus-0x/charon](https://github.com/yunus-0x/charon). If you're looking for the upstream version, that's the one. This fork is my personal trading setup, shared as-is.
\n## Contributing\n\nPlease see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to contribute to this project.\n\n## License\n\nThis project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
