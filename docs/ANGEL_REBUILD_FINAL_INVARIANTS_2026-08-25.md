# Angel Rebuild — Final Invariants (2026-08-25)

This addendum records the final compatibility decisions made while hardening PR #6.

## Research is semantic; `dry_run` remains the persisted compatibility value

User-facing mode names are:

- `RESEARCH`
- `SHADOW`
- `CONFIRM`
- `LIVE`

For backward compatibility, selecting Research is persisted in the settings table as `dry_run`.

Aliases:

```text
dry_run / dry-run / simulation / research -> stored dry_run -> semantic RESEARCH
shadow / shadow_live                       -> stored shadow_live -> semantic SHADOW
confirm                                    -> CONFIRM
live                                       -> LIVE
```

This is deliberate. Several mature safety components already treat raw `dry_run` as the no-money mode. Preserving that invariant avoids a broad rewrite that could accidentally make Research wallet-aware or fail-closed.

`src/research/policy.js` is the semantic mode boundary. Money-grade execution code may continue to use the legacy execution helper only after Research has been routed away.

## Zero-capital invariant is enforced in SQLite

For every `execution_mode='research'` position:

```text
real_capital_sol = 0
sim_notional_sol > 0
entry_signature IS NULL
exit_signature IS NULL
```

SQLite triggers reject inserts/updates that violate this rule.

The positive `sim_notional_sol` is a quote probe, never capital. It exists because a zero-size Jupiter request cannot measure executable route/liquidity/price impact.

## Research admission and capital admission are intentionally different

Research is an evidence-collection laboratory. It must not inherit every historical strategy veto, otherwise the dataset only contains the conservative setups Angel already likes.

Research therefore uses this hierarchy:

```text
Contract/catastrophic safety failure -> HARD REJECT
Strategy/statistical filter failure  -> SOFT RISK EVIDENCE
Low PreScore                         -> SOFT RISK EVIDENCE
ML unavailable/weak                  -> evidence, not a Research outage
LLM WATCH/PASS                       -> advisory; Hunter policy may sample
```

Money-grade modes preserve their existing strict behavior.

The hard Research boundary remains `contractSafety.passed`. Research does not bypass explicit malicious/unsafe contract evidence.

## Capacity is isolated and race-safe

Research and capital execution have separate capacity accounting.

Research uses an in-process pending reservation before asynchronous quote-ladder requests. This prevents multiple simultaneous candidates from all observing an available slot and oversubscribing the Research cap.

Research positions never consume `max_open_positions` for Shadow/Confirm/Live.

Closed Research experiments never create Live cooldown or recent-win bans.

An actively open Research position for the same mint still blocks a simultaneous capital position so position identity and reconciliation remain unambiguous.

## Monitoring is position-owned, not global-mode-owned

Every open position is monitored according to its stored `execution_mode`.

Changing the global mode cannot orphan an older Research/Shadow/Live position or cause it to be interpreted as the new global mode.

Only failures while monitoring a real `live` position escalate through the Live circuit-breaker failure path. Research quote/data failures do not latch the capital circuit breaker.

## Manual Telegram actions follow the same boundaries

A manual Research buy goes directly to the zero-capital Research engine.

It never calls the Shadow/Live executor, never reserves an execution slot, and never requires a wallet.

Manual Refresh of a Research position records R/MFE/MAE/realized-R even when that refresh itself triggers an automatic simulated exit.

The Telegram console exposes Research and Shadow as separate modes and shows Research `Capital: 0 SOL` separately from the quote probe.

## Market data honesty

Research entry requires a position-sized executable Jupiter quote.

Research exits prefer the position-sized executable Jupiter sell quote through the mature position monitor. If executable exit quoting is temporarily unavailable, the mature fallback path is retained so positions do not become unmonitorable.

For that reason, Research data quality must not claim that every observation is executable-quote sourced. Current labels distinguish an executable entry with executable-exit preference from degraded data. Future work may expose the exact valuation source from `refreshPosition()` for stricter sample filtering.

## Promotion boundary

No Research result automatically changes Live configuration.

Promotion order remains:

```text
Research evidence
-> R/expectancy/MFE/MAE/data-quality review
-> Shadow verification
-> Safety review
-> explicit Live promotion
```

No LLM, ML model, Research lesson, Hunter policy, or market regime may override the deterministic Live Safety Kernel.

## Validation status rule

Code-complete is not the same as test-green.

PR #6 must not be represented as fully validated until `npm run check` and the Research lifecycle tests execute successfully in a compatible Node >=22.18 environment. GitHub Actions was added for this purpose, but if repository Actions are unavailable, the PR should remain unmerged until equivalent checks are run elsewhere.
