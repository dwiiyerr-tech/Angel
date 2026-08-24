# Angel Strategy Control Plane — 2026-08-25

This phase implements the Iza-style versioned learning loop on top of the Wiyar safety boundary and Angel's Research/Edge foundation.

## Authority model

```text
Research + Shadow evidence
        |
Strategy Analyst
        |
PROPOSE config-vN+1
        |
Human APPROVE / REJECT
        |
Shadow challenger observation
        |
Human PROMOTE / EXTEND / REJECT
        |
Pre-live performance guard
        |
Live requires a fresh /liveapprove snapshot
```

`/configapprove` means **approve for challenger testing**, not approve for Live.

The Strategy Analyst can only propose these soft-policy keys in v1:

- `llm_min_confidence`
- `blocked_routes`
- `min_opportunity_size_multiplier`

Everything else is protected from analyst mutation. In particular the analyst cannot change wallet, signer, exposure, slippage, contract safety, circuit breaker, hard risk caps, or position-size authority.

## Immutable registry

Every config artifact stores:

- `config-vN` version and parent version,
- canonical config hash,
- prompt-set version,
- Momentum model hash,
- Runner model version,
- Route Edge model version,
- Research simulator version,
- evidence window/sample/payload,
- approval/promotion/rollback metadata.

SQLite triggers reject attempts to rewrite an existing config payload, model-version identity, parent, hash, or evidence payload. Status metadata may advance through the lifecycle, but the artifact itself cannot be rewritten.

## Evidence gate

A weekly review uses Research plus compatible Shadow evidence. A proposal is not eligible until at least 50 version-compatible closed observations are present and either:

- Research itself has at least 50 closed outcomes, or
- the Shadow learning window passes the existing data-quality gate.

If the evidence is insufficient, the analyst returns `HOLD`/`insufficient`; no config is created and no settings change.

## Strategy Analyst

The LLM is optional. When unavailable, deterministic evidence rules can create a bounded proposal. The same key whitelist and numeric bounds apply to both paths.

The LLM receives only the supplied evidence and current managed config. It is explicitly forbidden from proposing protected Safety/Risk/Execution keys. Invalid LLM output is discarded or falls back to deterministic analysis.

## Challenger

Once a human runs:

```text
/configapprove <proposal-id>
```

the proposal enters `testing` for seven days by default. Active settings remain unchanged.

For each candidate, Angel records whether the active policy and challenger policy would admit it using:

- BUY/WATCH/PASS verdict,
- route block state,
- LLM confidence floor,
- opportunity-size floor.

Closed Research/Shadow outcomes are then joined to those observations and compared by expectancy-R and win rate.

Default promotion evidence requires:

- at least 30 challenger outcomes,
- at least 24 hours of test age,
- non-negative challenger expectancy,
- at least +0.05R expectancy improvement when the control sample is mature,
- no more than 5 percentage points win-rate degradation.

These thresholds are evidence gates, not Live authorization.

## Promotion

Promotion is explicit:

```text
/configpromote <proposal-id>
```

and is allowed only while Angel is in Research or Shadow no-broadcast mode with no unresolved execution outcomes.

Promotion changes only the proposal's whitelisted soft-policy settings. The resulting managed config hash must exactly match the immutable proposed artifact or the transaction aborts.

Any previous Live approval checksum becomes stale after promotion. A new `/liveapprove create` + approval is still required before Live.

## Rollback

Manual rollback:

```text
/configrollback <parent-version> <reason>
```

Only the direct parent may be restored.

The automatic performance guard runs only in Research/Shadow. After at least 30 post-promotion outcomes, it can roll back when expectancy is both materially negative and materially worse than the proposal's evidence baseline.

The automatic guard deliberately does **not** mutate config while Live. Live safety incidents remain owned by the existing circuit breaker, reconciliation, and startup downgrade system.

## Telegram commands

```text
/configstatus
/configreview [7d]
/configapprove <proposal-id>
/configreject <proposal-id> [note]
/configextend <proposal-id> [days]
/configeval <proposal-id>
/configpromote <proposal-id>
/configrollback <parent-version> [reason]
```

## CLI / report

```bash
npm run control:report
```

This prints the active immutable config identity, open proposal, latest review, and current Research/Shadow evidence without changing settings.

## Permanent invariant

```text
LLM -> proposes
Human -> authorizes test/promotion
Safety Kernel -> remains sovereign
Live -> still requires separate cryptographic config approval
```
