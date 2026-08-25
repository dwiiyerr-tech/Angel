# Angel Decision Intelligence + Telegram Manager V1

## Purpose

Angel treats Research as a zero-real-capital paper-trading laboratory for discovering and falsifying edge using real-time market evidence and executable Jupiter quotes. Live remains a separate irreversible-capital mode that only the authenticated human owner may authorize.

The V1 architecture adds two connected but authority-separated systems:

1. **Decision Intelligence** — an immutable record and counterfactual outcome layer for every formal `BUY`, `WATCH`, or `PASS` decision.
2. **Telegram Manager** — a natural-language, read-only LLM manager grounded in Angel's database and reports.

Neither component can authorize Live, sign transactions, broadcast transactions, change settings, reset safety controls, or mutate the Strategy Control Plane.

## Authority invariant

```text
Research / Shadow / Reports / LLM Manager
                 |
                 v
          analysis / proposal
                 |
                 v
          HUMAN OWNER ONLY
                 |
       deterministic /liveapprove
                 |
                 v
            Safety Kernel
                 |
                 v
                Live
```

The LLM Manager intentionally has no `approveLive`, `setTradingMode`, signer, broadcast, setting mutation, or circuit-breaker mutation tool. Live approval continues through the existing deterministic Telegram command and checksum path.

A Manager response saying that evidence looks strong is **not** approval.

## Immutable Decision Receipt

Every canonical formal decision stored through `storeDecision()` creates a `decision_receipts` row containing only information available at decision time:

- token / route / signal evidence,
- contract Safety result,
- market cap, liquidity, holder evidence,
- Quality score,
- Momentum score,
- Runner probability and evidence sample,
- Route `P(win)` and Expected R when eligible,
- combined opportunity probability,
- risk flags and data quality,
- decision reason / confidence / risks,
- planned TP, SL and R:R,
- chart, Twitter, saved-wallet and other context if they were already available at decision time.

The receipt payload is immutable and SHA-256 identified. Later market outcomes never rewrite the receipt.

### PASS vs WATCH preservation

The legacy batch orchestrator may display the current candidate as `WATCH` when the batch LLM selected no candidate. If the underlying LLM result was an actual `PASS`, Decision Intelligence preserves it as a canonical `PASS` receipt so PASS false-negative analysis remains meaningful.

Fast Hunter `WATCH` decisions are also promoted into the durable decision/receipt path. Fast Hunter asynchronous LLM commentary remains advisory and does not rewrite the original Fast Hunter decision.

## Executable market probe

For Research receipts only, Angel asynchronously obtains or reuses an executable zero-capital entry profile.

`BUY` receipts first attempt to reuse the Research position's existing Execution Cost V2 profile. This avoids competing with the critical Fast Hunter entry path for Jupiter quota.

`WATCH` and `PASS` receipts receive a separate counterfactual executable Jupiter probe after the decision. It records, when available:

- simulation notional,
- executable token amount,
- effective entry price / market cap,
- decision-to-probe latency,
- quote-to-fill modeled latency,
- quote deterioration,
- immediate executable round-trip spread,
- size impact when available,
- modeled entry fee,
- modeled expected exit fee,
- configured Jupiter slippage tolerance.

**Slippage tolerance is not realized slippage.** It is the maximum configured route tolerance. V1 reports measured quote deterioration and executable round-trip spread separately.

Probe failures never change the original decision. They are marked degraded/failed and retained as data-quality evidence.

## Counterfactual outcome tracker

Research receipts schedule executable token-to-SOL exit quotes at:

- +5 minutes,
- +15 minutes,
- +30 minutes,
- +60 minutes.

Each observation records counterfactual net PnL and R after modeled entry/exit fees.

V1 derives:

- final sampled R at +60m when available,
- **sampled** MFE R = best observed R among the discrete horizons,
- **sampled** MAE R = worst observed R among the discrete horizons,
- decision classification.

These are discrete-horizon samples, **not continuous path MFE/MAE**. A future path-recorder can provide true continuous path statistics without changing V1 receipt semantics.

V1 classifications include:

- `TRUE_POSITIVE`
- `FALSE_POSITIVE`
- `BUY_EXIT_DEPENDENT`
- `TRUE_NEGATIVE`
- `FALSE_NEGATIVE`
- `FALSE_NEGATIVE_RUNNER`
- `WATCH_VALID`
- `WATCH_MISSED_UPSIDE`
- `WATCH_MISSED_RUNNER`
- `INCOMPLETE`

This makes PASS/WATCH scientifically useful instead of discarded decisions.

## Telegram Manager

The existing deterministic command handler remains unchanged as the authority for trading controls. A separate listener handles Manager conversation.

Normal authorized Telegram text can now be used conversationally, for example:

```text
Angel bagaimana performa 24h terakhir?
Kenapa keputusan #184 tadi PASS?
WATCH kita terlalu konservatif tidak selama 7d?
Route apa yang punya expectancy terbaik dari data yang sudah finalized?
Apakah sistem secara evidence terlihat siap dipertimbangkan untuk Live?
```

Explicit commands:

```text
/ask <question>
/decision <receipt_id|mint>
/decisions [24h]
/managerclear
```

`/decision` shows the detailed Decision Receipt plus the separately stored execution probe and later outcome observations.

`/decisions` summarizes verdict distribution, execution-probe quality, sampled outcomes, false negatives and route-level sampled R.

`/managerclear` removes only conversational LLM history. It does not delete Decision Receipts, Research positions, execution evidence or learning data.

## Manager grounding

For each question the Manager receives a read-only evidence snapshot containing:

- current system mode and active strategy,
- open-position summary,
- Live Safety state and unresolved executions,
- current human-approval presence,
- Strategy Control Plane active/proposal metadata if available,
- Decision Intelligence summary for the inferred time window,
- recent Decision Receipts,
- recent positions,
- a focused receipt when the question names a receipt ID or mint.

The LLM prompt explicitly separates decision-time evidence from later counterfactual outcomes to prevent hindsight bias.

## Failure behavior

If the LLM provider is unavailable, Telegram returns a deterministic read-only evidence summary. No trading or safety state is changed.

If Decision Intelligence probe infrastructure is unavailable, trading decisions remain unaffected. Decision Intelligence is an evidence layer, not a trading veto.

If Angel crashes while a Research probe is `running`, the V1 sweeper can retry it after restart. All probes are zero-capital Research-only.

## CLI

```bash
npm run decision:report
npm run decision:report -- 7d
npm run decision:report -- 7d --json
```

The report focuses on verdict distribution, probe completion, latency/friction, outcome classifications and route-level sampled R.

## Safety boundary

Decision Intelligence + Telegram Manager V1 does **not** make Live automatic and does not weaken existing Live safety:

```text
LLM Manager          read-only
Decision Intelligence evidence-only
Strategy Analyst     proposal-only
Readiness (future)   eligibility-only
Human owner          sole Live approval authority
Safety Kernel        execution sovereignty
```

This separation is intentional and must remain an invariant in later versions.
