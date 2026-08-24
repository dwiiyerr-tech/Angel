# Angel Fast Hunter V1 — 2026-08-25

Fast Hunter V1 reduces signal-to-Research-entry latency without weakening Angel's irreversible-capital safety boundary.

## Scope

Fast Hunter V1 is enabled only when all of these are true:

- configured mode normalizes to `research`,
- `research_fast_hunter_enabled` is true (default true),
- route is `pumpportal_graduated` or `pumpfun_pregrad`.

Shadow, Confirm, and Live always fall back to the existing full orchestrator pipeline.

## Critical path

```text
PumpPortal migration / Pump.fun pre-grad
        |
        v
Jupiter asset + holders
(+ GMGN only if it arrives inside the bounded fast budget)
        |
        v
existing candidate filters
        |
        v
Contract Safety Kernel
        |
        v
PreScore
        |
        v
Momentum ML when its GMGN history features are already available
        |
        v
Runner + Route Edge evidence
        |
        v
Deterministic Research Hunter
        |
        v
Jupiter zero-capital executable Research entry
```

The fast path never signs or broadcasts and never changes the permanent Research invariant:

```text
real capital = 0 SOL
signer = none
broadcast = false
```

## Deferred evidence

The following are removed from the critical path and collected after the fast decision:

- deep GMGN token enrichment,
- Jupiter chart context,
- saved-wallet exposure,
- Twitter narrative,
- LLM advisory.

Late evidence is appended to the candidate as `lateAssessment`; it does not rewrite the original entry decision. This preserves a clean counterfactual comparison between the fast decision and the fuller later context.

## Solana fee WebSocket

`startFastHunterRuntime()` also starts the existing `feeClaim.js` Solana WebSocket listener. It subscribes to confirmed Pump Program and Pump AMM logs and reconnects after disconnects. It uses `SOLANA_WS_URL`, which defaults to the configured Helius WebSocket endpoint when `HELIUS_API_KEY` is used.

Fee-claim routes are not Fast Hunter routes in V1. They are routed through the normal orchestrator; the WebSocket simply restores the direct event-driven signal source.

## Telemetry

Each fast candidate writes one `fast_hunter_runs` row with timestamps for:

- signal received,
- essential enrichment complete,
- Contract Safety complete,
- Momentum/Edge complete,
- fast decision complete,
- Research entry/quote complete,
- late enrichment complete,
- asynchronous LLM complete.

The background comparison records:

- fast BUY/WATCH decision,
- late full-context filter result,
- asynchronous LLM verdict/confidence,
- signal-to-decision latency,
- signal-to-entry latency,
- signal-to-full-context latency.

Run:

```bash
npm run fast:report
npm run fast:report -- 7d
```

The report includes p50/p90 latency, fast-vs-late-context disagreement, fast-vs-LLM disagreement, and realized-R outcomes for closed Fast Hunter Research positions.

## Settings

Optional settings (all have defaults):

```text
research_fast_hunter_enabled=true
research_fast_hunter_gmgn_budget_ms=1500
research_fast_hunter_async_llm_enabled=true
```

The GMGN budget is a latency budget, not an API timeout guarantee. If GMGN history is unavailable inside the critical-path budget, Momentum ML may report unavailable; Runner/Route Edge remains advisory and the later background enrichment still collects GMGN evidence.

## Promotion rule

Fast Hunter V1 must collect Research evidence before any Shadow promotion. At minimum compare:

- p50/p90 signal-to-entry,
- expectancy R,
- clean-runner capture rate,
- MAE/MFE,
- execution spread/fees/quote deterioration,
- fast-vs-full-context disagreement rate,
- catastrophic Safety Kernel rejects.

No direct Research-to-Live promotion is permitted.
