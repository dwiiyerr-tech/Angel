# Angel Live Safety Hardening V2 — 2026-08-25

This phase hardens irreversible-capital execution. It does not change signal selection, alpha logic, Runner/Route Edge models, or Research Fast Hunter behavior.

## 1. Durable atomic capital reservation

Every Live/Confirm buy execution claim now reserves its planned SOL exposure in SQLite inside the same transaction that creates the execution operation.

The hard budget includes:

- open/unknown Live positions,
- active capital reservations,
- hard maximum open positions,
- hard total SOL exposure,
- 24-hour entry count,
- 24-hour realized loss limit.

A known pre-broadcast failure releases the reservation. `outcome_unknown` keeps it reserved. Once an operation is attached to a position or becomes completed, the reservation is converted because the position ledger becomes the exposure source of truth.

This closes the previous check-then-act window where two different mints could both read the same old exposure before either position was persisted.

## 2. Crash-durable transaction identity

A Solana transaction has its primary signature immediately after local signing. Angel persists that local signature to the active execution operation before sending the signed transaction to Jupiter/Jito.

Therefore a crash after broadcast but before the HTTP response or position write still leaves a durable signature for restart reconciliation.

If a provider returns a different signature from the locally signed transaction, Angel treats the outcome as unsafe/unknown rather than trusting the provider response.

## 3. Finalized settlement

A Live swap is not considered settled merely because it reached `confirmed` commitment.

Angel waits for a `finalized` signature status and reads the finalized transaction receipt. The receipt is used to recover:

- fee lamports,
- output token delta,
- input token debit,
- native SOL output when applicable.

If finality is not reached within the bounded wait, the operation becomes UNKNOWN and automatic retry is blocked.

## 4. Autonomous finalized-signature reconciliation

The mixed-mode position monitor runs the execution reconciler before normal position monitoring.

For `pending` / `outcome_unknown` operations with a durable signature:

- finalized failure -> operation becomes failed and an unknown sell is restored to open,
- finalized buy success -> missing/orphaned Live position can be reconstructed from persisted candidate/decision evidence,
- finalized full sell success -> position is settled closed from the finalized receipt,
- finalized partial sell success -> remaining token amount, cost basis, realized PnL, and realized fees are restored.

The circuit breaker is deliberately not auto-cleared after reconciliation. Human review/reset and a fresh Live approval remain separate controls.

## 5. Irreducibly ambiguous state

If Angel has no durable signature and no authoritative chain proof, it does not guess that an execution failed or succeeded.

The operation remains unresolved, its reservation remains active, and Live stays blocked.

This is intentional fail-closed behavior. Availability is sacrificed before capital safety.

## 6. Multi-token-account balances

Live token balance reads now sum every parsed token account owned by the wallet for the mint. The previous first-account-only behavior could under-report holdings when a wallet had multiple token accounts.

## 7. SQLite durability

The money-grade ledger enables:

- WAL (existing database behavior),
- `busy_timeout = 5000`,
- `foreign_keys = ON`,
- `synchronous = FULL`.

The reservation ledger is persisted in `live_capital_reservations` and survives restart.

## 8. Tests

`test/unit/test_live_safety_hardening_v2.js` covers:

- concurrent reservation/exposure collision,
- hard third-entry rejection,
- reservation release after known failure,
- reservation retention for UNKNOWN,
- reservation persistence across idempotent initialization,
- multi-account balance aggregation,
- finalized buy receipt token delta,
- finalized sell native SOL receipt,
- finalized failed transaction semantics.

Existing execution-safety, deduplication, swap-effect validation, Research, Strategy Control Plane, Fast Hunter, and dependency-security tests continue to run in CI.

## Remaining safety statement

This hardening materially reduces known execution-state and concurrency gaps, but it does **not** make Live execution mathematically or operationally 100% bug-free. RPC/provider outages, chain behavior, process/host failure, unknown future dependency bugs, and unmodeled edge cases remain possible.

Promotion to unattended Live should still follow Research -> Shadow -> human-approved Live configuration with conservative initial capital and active monitoring.
