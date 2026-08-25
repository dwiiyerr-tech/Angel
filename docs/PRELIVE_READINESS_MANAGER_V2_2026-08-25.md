# Angel Pre-Live Readiness Engine + Telegram Manager V2

## Purpose

Angel now has a deterministic evidence gate for staged promotion:

```text
RESEARCH -> SHADOW -> CONFIRM -> LIVE CONSIDERATION
```

The engine does not change trading mode, approve Live, sign transactions, broadcast transactions, or mutate strategy/config. It only evaluates whether the currently collected evidence satisfies explicit thresholds.

Live remains owner-controlled. `ELIGIBLE_FOR_LIVE_CONSIDERATION` means only that the evidence is eligible for human review.

## Stage 1 — Research -> Shadow

The Research gate evaluates zero-capital paper-trading evidence using real-time market data and executable Jupiter economics. Hard gates include:

- minimum closed Research sample;
- minimum evidence span;
- positive minimum expectancy in R;
- minimum profit factor;
- native realized-R coverage;
- executable entry evidence coverage;
- Research Exit Simulator V3 coverage;
- no pending Research exit settlements.

Warnings include maximum drawdown, median quote deterioration, executable round-trip spread, Decision Intelligence finalized sample, executable-probe coverage, BUY false-positive rate, and PASS/WATCH missed-runner rate.

Missing native Research `realized_r` is not reconstructed. It remains missing evidence and lowers coverage.

## Stage 2 — Shadow -> Confirm

Shadow is the money-grade no-broadcast rehearsal. The gate requires the Research gate to remain eligible and additionally evaluates:

- minimum closed Shadow sample;
- minimum evidence span;
- Shadow expectancy and profit factor;
- Shadow R coverage;
- clear money-grade safety/ledger state;
- stable active Control Plane config with no challenger/config transition.

Older Shadow rows do not always persist native `realized_r`. Readiness therefore reports R provenance explicitly and may derive Shadow R in this order:

1. stored `realized_r` when present;
2. `pnl_sol / initial_risk_sol`;
3. if initial risk was not persisted, `pnl_sol / (size_sol * abs(sl_percent)/100)`;
4. final fallback `pnl_percent / abs(sl_percent)`.

This derivation is read-only. Historical rows are not rewritten.

## Stage 3 — Confirm -> Live consideration

The gate requires:

- the Shadow gate still passes;
- current mode is explicitly `confirm`;
- Live safety/ledger state is clear;
- active strategy/config is stable;
- no pending Research exit settlement.

Current storage uses the same money-grade Live ledger identity for Confirm execution. V1 therefore does **not** invent a separate Confirm performance sample. The readiness report and Manager must disclose this as a warning.

A future version may add explicit Confirm-origin telemetry without changing reconciliation identity.

## Safety state

The deterministic safety snapshot checks, among other invariants:

- unresolved execution operations;
- active capital reservations;
- unknown Live positions;
- Live inventory anomalies;
- active buys without reservation;
- broken reservation links;
- duplicate active Live mints;
- circuit-breaker state;
- SQLite WAL / synchronous / busy-timeout / foreign-key durability settings.

Any hard safety blocker prevents Shadow -> Confirm and Confirm -> Live consideration.

## Telegram

```text
/readiness
/readiness 24h
/readiness 7d
```

The command returns the current deterministic gate, score, hard blockers, Research/Shadow evidence summary, execution coverage, and safety state.

Normal Manager chat is also grounded with the same readiness report. For example:

```text
Angel apakah Research sudah siap Shadow?
Apa yang masih menghalangi Confirm?
Apakah evidence sekarang layak dipertimbangkan untuk Live?
```

Manager V2 must state the deterministic status first. It may explain warnings and recommend what evidence to collect next, but it must not override a `NOT_READY` gate by intuition.

## CLI

```bash
npm run readiness:report
npm run readiness:report -- 24h
npm run readiness:report -- 7d --json
```

## Authority invariant

```text
Readiness Engine   eligibility-only
Telegram Manager   read-only analysis
Strategy Analyst   proposal-only
Human owner        sole Live approval authority
Safety Kernel      execution sovereignty
```

The readiness engine must never expose an `approveLive`, `setTradingMode`, signer, broadcaster, settings mutation, or circuit-breaker mutation capability.
