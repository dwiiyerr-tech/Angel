# Research Exit Simulator V3

Angel Research remains zero-capital paper trading. V3 makes every Research sell leg materially closer to Solana/Jupiter live execution without signing or broadcasting a transaction.

## Authority boundary

V3 does **not** change when Angel chooses to exit. The shared position engine remains authoritative for:

- TP
- SL / dynamic ATR SL
- trailing
- break-even
- profit lock
- partial TP
- time tightening
- max hold / sideways exit

V3 starts only after that engine emits a virtual sell action.

## Settlement path

```text
exit trigger
  -> position-sized Jupiter token->SOL quote
  -> configurable quote-to-fill latency
  -> position-sized Jupiter re-quote
  -> virtual fill from the re-quote
  -> current Solana base/priority fee model
  -> optional current Jito tip model
  -> corrected partial/final Research ledger
```

Default exit latency inherits `research_quote_to_submit_latency_ms` (500 ms) unless `research_exit_quote_to_fill_latency_ms` is configured explicitly.

A positive `quote_deterioration_pct` means the post-latency virtual sell receives less SOL than the trigger-time quote. A negative value means the route improved during the simulated inclusion delay.

## Partial TP

Research partial TP now receives an exact V3 settlement overlay. The existing shared position engine still reduces virtual token inventory and cost basis. V3 derives the exact raw amount sold from the before/after Research inventory, re-quotes that amount after latency, samples current exit fees, then replaces only the partial leg's legacy virtual PnL/fee accounting.

This prevents partial TP from being treated as a free mark-price bookkeeping event.

## Final exits

For TP, SL, trailing, profit-lock and time exits, V3 replaces the legacy static dry-run exit settlement with the post-latency position-sized Jupiter re-quote. Final net PnL includes:

- previously realized partial PnL;
- remaining virtual position cost;
- entry fee;
- partial realized fees;
- current modeled exit fee;
- V3 executable post-latency liquidation value.

The corrected values are persisted to the Research position and final sell trade.

## Crash/retry behavior

Every V3 sell leg has a durable row in `research_exit_settlements`.

```text
pending -> executable quote/re-quote -> completed
```

If the first executable exit quote is unavailable, the row remains `pending` and retries with bounded exponential backoff. If only the second quote fails, V3 uses the first executable quote and marks the settlement `degraded_signal_quote_fallback` rather than inventing a fill.

Research monitoring resumes pending settlements before processing new market state. No real capital is involved.

### Settlement ordering invariant

Exit legs are causal. A final TP/SL/trailing/time settlement may not finalize ahead of an earlier partial-TP settlement for the same Research position. If an earlier partial leg is still `pending`, the final settlement remains durable but waits without issuing its own executable quote. Open Research positions with unresolved exit settlement are also held from new exit decisions until that settlement is resolved.

When the final settlement eventually completes, it reads the latest corrected `realized_pnl_sol` and `realized_fee_sol` from the Research position. This prevents provider outages or process restarts from freezing a stale legacy partial-PnL snapshot into the final result.

## Data written

Each settlement records:

- exact raw token amount;
- partial/final kind and exit reason;
- trigger-time executable SOL output;
- post-latency executable SOL output;
- configured and measured quote-to-fill latency;
- quote deterioration percentage;
- modeled exit fee;
- evidence quality;
- retry/error state;
- full profile/accounting JSON.

The associated `dry_run_trades.payload_json` also receives `researchExitV3` evidence.

## Reporting

```bash
npm run research:exit-report
npm run research:exit-report -- 24h
```

The report shows settlement counts, pending rows, degraded fills, p50/p95 exit quote deterioration, p50/p95 quote-to-fill latency and p50/p95 modeled exit fee.

## What V3 still cannot reproduce

V3 is a quote-based near-live simulator, not a claim of 100% Live equivalence. It still cannot know the exact future validator/leader inclusion result, MEV interaction, block contention, transaction compute behavior, failed signed transaction path, or state mutation between the final quote and a real block landing.

Promotion remains:

```text
RESEARCH -> SHADOW -> CONFIRM -> LIVE
```

Only the authenticated owner can authorize Live capital.
