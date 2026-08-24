# Angel Live Safety Hardening V3 — Chaos / Fault Injection

This phase tests Angel's irreversible-capital state machine by deliberately reproducing crash windows and ambiguous provider/RPC outcomes. It does not change signal selection, Runner/Route Edge models, Research Fast Hunter, or Strategy Control Plane policy.

## Hidden P0 found during V3 preparation

The pre-V3 Live sell path used the wallet's full token balance for a non-partial exit. If the wallet also held the same mint from a manual transfer or another system, Angel could attempt to sell inventory that was not owned by the tracked position.

V3 changes the invariant to:

- the position ledger defines Angel's sell inventory,
- wallet balance is used only to prove that the wallet has at least that much inventory,
- a larger wallet balance never increases the sell amount,
- a smaller or unavailable wallet balance causes a fail-closed refusal.

The old UNKNOWN recovery based only on wallet balance deltas is also removed. External transfers must never be mistaken for swap fills. UNKNOWN recovery is finalized-signature/receipt driven.

## Chaos matrix

`test/unit/test_live_safety_chaos_v3.js` exercises:

1. **Crash after capital reservation, before signature**
   - child process claims Live capital,
   - exits abruptly,
   - reservation survives,
   - reconciler refuses to guess because no durable signature exists.

2. **Crash after signature journaling**
   - child process persists an operation signature,
   - exits abruptly,
   - a simulated RPC timeout leaves the operation unresolved,
   - a later finalized receipt reconstructs the missing Live position.

3. **Finalized-before-position-write**
   - models a transaction that landed on chain while the process died before the position DB write,
   - finalized receipt + persisted candidate/decision evidence reconstruct the position.

4. **Duplicate reconciliation / repeated restart**
   - repeated reconciliation after recovery must not create a duplicate position or duplicate finalized exit.

5. **Ambiguous sell -> finalized chain failure**
   - `exit_unknown` / `partial_exit_unknown` is restored to `open`,
   - operation becomes `failed`,
   - no false close is recorded.

6. **Partial sell finalized after crash**
   - remaining inventory is derived from tracked position inventory minus finalized sold amount,
   - wallet-wide balances do not contaminate position accounting.

7. **Full sell finalized after crash**
   - missing normal close write is reconstructed from finalized receipt,
   - position closes once and the recovered trade is recorded once.

8. **Finalized inclusion but missing asset delta**
   - operation remains `outcome_unknown`,
   - active reservation remains locked,
   - finality alone is insufficient without authoritative output amount.

9. **SQLite writer contention**
   - a second process holds `BEGIN IMMEDIATE`,
   - the main connection waits through transient contention using `busy_timeout`,
   - the write succeeds after the lock releases instead of failing immediately.

## Fault injection design

The production reconciler remains network-driven by default. Its top-level function now accepts an optional receipt fetcher and wallet-availability override for deterministic tests. Runtime callers do not pass these options, so production behavior remains unchanged.

No environment switch can make production randomly crash or fake a fill. Fault injection is dependency injection from the test process only.

## Pre-Live chaos report

Run:

```bash
npm run chaos:report
```

For structured output:

```bash
npm run chaos:report -- --json
```

The report checks:

- unresolved execution operations,
- unresolved operations missing durable signatures,
- active capital reservations and reserved SOL,
- `entry_unknown`, `exit_unknown`, and `partial_exit_unknown` positions,
- open Live positions missing tracked inventory or entry signature,
- active Live buys that have no matching active reservation,
- broken reservation -> operation links,
- duplicate active Live positions for the same mint,
- SQLite money-grade pragmas,
- completed legacy operations that do not carry V2 finalized metadata.

A `BLOCK_LIVE` report is an operational stop signal. It is not an automatic circuit-breaker reset mechanism and it never authorizes Live.

## Safety boundary after V3

V3 materially improves confidence in crash recovery and state ownership, but it still does not make Angel 100% bug-free. Remaining classes include unknown future provider behavior, Solana/runtime changes, OS/storage faults beyond SQLite guarantees, malicious dependencies, untested hardware/network failure modes, and code paths not reached by the current fault matrix.

The intended promotion path remains:

`Research -> Shadow -> chaos/pre-live checks -> human-approved config -> conservative Live capital -> active monitoring`.
