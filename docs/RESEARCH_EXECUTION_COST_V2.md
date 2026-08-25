# Research Execution Cost V2

Angel PAPER remains a no-real-capital market laboratory with its own virtual wallet. V2 makes the virtual execution path closer to live trading without signing or broadcasting a transaction.

## Invariants

- `real_capital_sol = 0`
- no real wallet balance or private key is required
- the configured PAPER virtual balance is enforced for entry reservations
- no private key is required
- no transaction is signed
- no transaction is broadcast
- Jupiter executable quotes remain the source of virtual token amounts
- Live Safety Kernel behavior is unchanged

PAPER uses the same strategy sizing and money-grade market/safety admission as
LIVE. The only execution settlement difference is that the input SOL and
resulting token/SOL fills are committed to the virtual ledger rather than to a
wallet transaction.

## Entry model

For the configured Research notional, Angel now performs:

```text
signal quote
  -> configured quote-to-submit latency
  -> second Jupiter quote (virtual fill)
  -> immediate token->SOL quote
  -> position opens using the second quote
```

This produces:

- measured quote-to-fill latency
- quote deterioration during latency
- immediate round-trip executable spread/friction
- size impact relative to the smallest quote-ladder point
- position-sized virtual token amount

The immediate round-trip metric is intentionally called executable spread/friction rather than a traditional order-book spread. It includes the economic effect of AMM curves, route fees, pool fees and price impact already present in Jupiter's executable quote.

Do **not** add an arbitrary slippage haircut on top of this unless deliberately stress-testing. `JUPITER_SLIPPAGE_BPS` is a transaction tolerance, not proof that the trade actually loses that percentage.

## Fee model

### Base network fee

Research keeps the configured Solana base-fee estimate (`dry_run_network_fee_sol`, default 0.000005 SOL).

### Dynamic priority fee

When `research_dynamic_priority_fee_enabled` is enabled (default), Angel calls Solana RPC `getRecentPrioritizationFees`, selects a configurable percentile, interprets the returned value as micro-lamports per compute unit, and estimates:

```text
priority fee lamports
  = ceil(micro_lamports_per_CU * estimated_CU_limit / 1,000,000)
```

Defaults:

```text
research_compute_unit_limit = 400000
research_priority_fee_percentile = 0.75
research_max_priority_fee_sol = 0.01
```

If RPC data is unavailable, the model falls back to `dry_run_priority_fee_sol` and marks the fee quality as degraded.

### Jito tip

Jito cost modeling follows the Live Jito setting by default. When enabled, Research reads Jito's public tip-floor endpoint and uses a configurable landed-tip percentile.

Defaults:

```text
research_include_jito_tip = JITO_ENABLED
research_jito_tip_percentile = 50
research_jito_tip_fallback_sol = 0.000001
research_max_jito_tip_sol = 0.01
```

The tip is virtual only. Research never sends it.

### Failure/retry overhead

Research can optionally model expected fees lost to failed/retried transactions:

```text
expected_failure_overhead
  = transaction_fee * failure_probability * expected_retries
```

Defaults keep this disabled until Angel has enough empirical live/shadow evidence:

```text
research_tx_failure_probability = 0
research_expected_retries = 1
```

## Exit model

The mature Angel position engine still chooses TP/SL/trailing/profit-lock/time exits. Research does not fork that logic.

When a Research position closes:

1. the existing position-sized Jupiter liquidation quote determines virtual market value;
2. Execution Cost V2 samples network/priority/Jito fee conditions again at exit time;
3. the old fixed dry-run exit-fee assumption is replaced in Research accounting by the fresh modeled exit cost;
4. `pnl_sol`, `pnl_percent`, `realized_r` and modeled PnL fields reflect the V2 net result.

This keeps Alpha logic and execution-cost accounting separate.

## Persisted metrics

Research positions add:

```text
research_execution_cost_json
entry_latency_ms
entry_quote_deterioration_pct
entry_roundtrip_spread_pct
entry_size_impact_pct
entry_priority_fee_sol
entry_jito_tip_sol
modeled_exit_fee_sol
modeled_net_pnl_sol
modeled_net_pnl_percent
```

`npm run research:report` reports aggregate execution-cost statistics together with expectancy R, MFE and MAE.

## What V2 is and is not

V2 is a quote-based near-live execution model. It measures real market quotes, real liquidity/route economics, quote deterioration over simulated latency, current fee conditions and optional Jito auction cost.

It is not a guarantee of the exact fill a future signed transaction would receive. Exact live results can still differ because of leader scheduling, state changes between quote and inclusion, MEV, transaction contention, compute-budget differences, failed transactions and RPC/provider latency.

The correct promotion path remains:

```text
RESEARCH V2 -> SHADOW LIVE -> CONFIRM/LIVE
```

Research may be aggressive. Live capital remains protected by the deterministic Safety Kernel.
