# Angel Two-Mode Trading Model — PAPER / LIVE

Date: 2026-08-25

Angel exposes exactly two public trading modes:

1. **PAPER**
2. **LIVE**

No public Research, Shadow, or Confirm mode exists after this migration.

## PAPER

PAPER is Angel's zero-capital trading laboratory. It keeps the mature Research engine internally, including real Solana market signals, position-sized Jupiter quotes, simulated quote-to-submit latency, entry re-quotes, realistic exit re-quotes, spread/price-impact evidence, modeled Solana/priority/Jito costs where available, TP, SL, trailing, partial TP, MFE/MAE, realized R, and Decision Intelligence.

Hard invariants:

- real capital = 0 SOL
- no wallet required for execution
- no transaction signing
- no transaction broadcast
- no transaction signature may be persisted on PAPER/Research positions
- catastrophic Contract Safety remains non-bypassable
- Fast Hunter is PAPER-only

PAPER positions continue to use historical `execution_mode='research'` storage internally. This is a compatibility/storage label, not a third public mode.

## LIVE

LIVE uses real capital and the money-grade execution stack.

Entering LIVE still requires an owner-approved Live configuration snapshot. Enabling the mode does **not** grant Angel or the LLM autonomous entry authority.

Every new LIVE BUY follows:

`decision -> fresh money-grade checks -> pending LIVE trade intent -> authenticated Telegram owner approve/reject -> fresh checks again -> live risk budget -> wallet checks -> sign/broadcast -> finalized receipt -> durable position ledger`

Hard invariants:

- every LIVE BUY requires explicit authenticated owner approval
- LLM/Manager cannot approve or enable LIVE
- direct manual LIVE BUY callbacks cannot bypass the intent approval path
- approval is size-capped; execution may reduce size after fresh risk checks but cannot exceed the approved size
- stale intents expire
- config approval is rechecked before broadcast
- transaction outcome ambiguity remains fail-closed and enters reconciliation

### Protective exits

After an owner has approved a LIVE entry and the position exists, protective exits remain automatic. TP, SL, trailing, partial TP, circuit-breaker/reconciliation safety, and manual emergency close do not wait for a second human approval. This avoids turning human latency into position risk.

## Legacy compatibility aliases

Old configured names are migration aliases only:

- `dry_run`, `dry-run`, `simulation`, `research`, `shadow`, `shadow_live` -> **PAPER**
- `confirm` -> **LIVE**

Canonical settings persistence is only:

- PAPER -> `trading_mode='dry_run'`
- LIVE -> `trading_mode='live'`

Historical position/event rows are not bulk-rewritten. Reports may still encounter legacy `research`, `shadow_live`, or `confirm` labels and must map them to their public two-mode meaning without inventing a new runtime mode.

## Readiness

Readiness is now a single evidence gate:

`PAPER -> READY_FOR_LIVE_REVIEW`

It evaluates Paper sample size, evidence span, expectancy R, profit factor, realized-R coverage, executable entry evidence, realistic exit coverage, pending settlements, execution friction, Decision Intelligence quality, Live ledger/safety state, and Control Plane stability.

`READY_FOR_LIVE_REVIEW` is not authorization. Only the authenticated human owner can approve the Live configuration and each LIVE BUY.

## Telegram / LLM Manager

Telegram shows only PAPER and LIVE.

The LLM Manager may read evidence, explain decisions, compare edge, summarize readiness, and recommend actions. It has no authority or tool to approve Live, enable Live, sign transactions, broadcast transactions, or mutate safety-critical settings.

## Realism boundary

PAPER is a near-live execution-economics simulation, not a claim of 100% identical on-chain execution. Actual validator inclusion, transaction contention, exact MEV interaction, and state changes between quote and landing can only be observed with real transactions. The PAPER engine should remain conservative enough to reject edges that disappear after realistic market friction.