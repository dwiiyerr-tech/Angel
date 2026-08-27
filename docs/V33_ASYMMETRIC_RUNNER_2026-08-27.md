# Angel v33 — Asymmetric Runner Layer

Status: PAPER challenger. LIVE authority stays disabled by default.

## Objective

Shape outcomes as many bounded probe losses plus a small number of large runners. Win rate is not the optimization target; expectancy after executable costs and drawdown is.

## Decision authority

1. Contract safety remains binary and cannot be overridden.
2. Quality describes tradability.
3. `P(survive)` labels whether the executable path avoids an early `-1R` failure.
4. `P(runner)` labels whether the path reaches `+3R` before `-1R` inside the configured horizon.
5. Route edge supplies expected R after Research history reaches its sample floor.
6. Admission is deterministic: `GOOD`, `REJECT`, or internal `LEARN` while samples are insufficient.
7. Four independent evidence domains are recorded: Market, On-chain, Flow, and Narrative. At least two core domains (Market/On-chain/Flow) must confirm a statistically eligible `GOOD`; Narrative has only 5% weight.
8. `deterministic_edge_v1` ranks candidates and maps Edge to a bounded size fraction. LLM candidate selection is disconnected from execution.
9. Risk caps remain the final authority. The LLM is a configuration analyst only: it may create a bounded proposal but cannot activate v33, promote a challenger, change protected Safety/Risk keys, or raise size caps.

## Signal fan-in

- PumpPortal, Trending, fee, trenches, pre-grad, GMGN smart-money, and dedicated smart-money polling feed one mint-keyed aggregation window.
- Independent routes are preserved in `signals.routes`; multiple sources become `dual_source` while keeping a ranked `primaryRoute`.
- Route blocks use exact membership. Blocking `trending` does not block `fee_trending`.
- A second route updates the recent mint snapshot instead of being discarded as a duplicate.
- Every route arrival is persisted in `candidate_evidence_events`. Independent evidence arriving inside the default three-minute window refreshes the candidate thesis and, when a position is already open, supplies conservative lifecycle context without overriding observed selling.

## Counterfactual learning

- BUY, WATCH, and PASS decisions receive immutable receipts in PAPER.
- Contract, hard-filter, prescore, and Momentum rejects are recorded too; they are not silently lost from the dataset.
- A decision-time executable Jupiter entry probe is followed at 2, 5, 15, 30, and 60 minutes by executable exit quotes.
- WATCH/PASS outcomes are blended into survival, runner, and route models with a bounded share of history, so selected trades cannot censor false-negative runners.
- Missing or failed probes remain missing; they are never converted into synthetic neutral outcomes.

## Position lifecycle

- `PROBE`: PAPER enters with 20% of its edge-capped target by default.
- `CONFIRMED`: price and buyer flow validate within 30–90 seconds; PAPER may add only up to its stored target.
- `RUNNER`: peak exceeds the runner boundary and healthy flow widens the trail.
- `MOON`: peak exceeds 100%; healthy flow receives maximum bounded trail allowance.
- `DISTRIBUTION`: weakening buyer flow tightens the trail and raises the floor.
- `FAILED`: thesis or catastrophic invalidation exits the position.

There is no averaging down. A scale leg requires a new executable quote, atomic stage claim, virtual-wallet capacity, and a separate trade-ledger row.

## Safety behavior

The normal SL may retain a short volatility grace period. `CATASTROPHIC_STOP` is separate and active from the first monitor cycle. It uses executable PnL and confirmed liquidity retention where available.

## Defaults

- PAPER lifecycle, probe sizing, and eligible edge rejection: enabled.
- LIVE lifecycle, probe scaling, and edge admission: disabled.
- Enabling LIVE changes the approved runtime checksum and requires the existing live-config approval workflow.

## Promotion

Each observation updates first-passage labels for `+1R`, `+2R`, `+3R`, and `+5R`, including whether the level arrived before `-1R`. The `npm run v33:replay` command replays v32 and v33 over the same Decision Intelligence paths. Replay is gap-aware, includes partial realization, and uses net executable quotes instead of granting ideal fills at a stop/trailing threshold.

A challenger re-evaluates both entry eligibility and exit policy under the active and proposed config. It requires at least 14 days, 100 total outcomes, and 30 outcomes for every represented route before it can become promotion-ready. A changed setting with insufficient replay telemetry blocks promotion. Promotion remains human-approved.

In PAPER mode only, a promoted child automatically rolls its configuration back to its parent when expectancy, maximum drawdown, or catastrophic-loss frequency breaches the configured guard. When release rollback is explicitly installed and enabled on the VPS, the same guard writes a durable v33-to-v32 rollback request; the external release guard atomically swaps the `current` release symlink and restarts the service. The running process never performs a Git checkout. LIVE stays disabled and requires a fresh checksum approval after every change.
