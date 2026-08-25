# Angel Pre-Live Readiness Engine + Telegram Manager V2

## Purpose

Angel now has a deterministic evidence gate for deciding whether the system has accumulated enough quality evidence to **consider advancing one stage** in the execution ladder:

```text
RESEARCH -> SHADOW -> CONFIRM -> LIVE CONSIDERATION
```

The Readiness Engine does **not** change trading mode, approve Live, sign transactions, or broadcast transactions. It only produces an evidence eligibility verdict.

`ELIGIBLE_FOR_LIVE_CONSIDERATION` means the deterministic evidence gate is satisfied for human review. It is **not** Live authorization.

Only the authenticated human owner can authorize Live through Angel's existing deterministic Live approval flow.

## Authority boundary

```text
Research / Shadow evidence
Decision Intelligence
Execution realism
Live Safety state
Strategy Control Plane
        |
        v
Deterministic Readiness Engine
        |
        +--> NOT_READY
        +--> READY_FOR_SHADOW
        +--> READY_FOR_CONFIRM
        +--> ELIGIBLE_FOR_LIVE_CONSIDERATION
                        |
                        v
                HUMAN OWNER REVIEW
                        |
                deterministic /liveapprove
                        |
                        v
                   Safety Kernel
                        |
                        v
                       LIVE
```

The LLM Manager cannot override this gate in either direction. If the deterministic gate says `NOT_READY`, the Manager may explain the blockers but may not declare the system ready from narrative confidence. If the gate says ready, the Manager may discuss warnings but must preserve the deterministic readiness label.

## Evidence window

The standalone `/readiness` command and CLI default to **7 days**.

Natural-language readiness questions such as:

```text
Apakah Angel siap Live?
Apakah evidence sudah cukup untuk Shadow?
Are we ready for Confirm?
```

also default to a 7-day evidence window unless the owner supplies an explicit interval such as `24h`, `3d`, or `14d`.

Ordinary Manager questions continue to default to 24 hours.

## Research -> Shadow gate

The default hard requirements are:

- at least 50 closed Research positions;
- at least 24 hours of evidence span;
- expectancy at least `+0.05R`;
- profit factor at least `1.15`;
- realized-R coverage at least 90%;
- executable entry evidence coverage at least 80%;
- Research Exit Simulator V3 final-settlement coverage at least 80%;
- zero pending Research exit settlements.

Additional warnings contribute to the readiness score but do not automatically veto this stage by default:

- max drawdown above 10R;
- median entry quote deterioration above 5%;
- median executable round-trip spread above 20%;
- fewer than 30 finalized Decision Intelligence outcomes;
- executable Decision probe coverage below 80%;
- missed-runner rate above 15%;
- BUY false-positive rate above 40%.

These thresholds are intentionally configurable through Angel settings, but Readiness itself does not mutate them.

## Shadow -> Confirm gate

The default hard requirements are:

- the Research -> Shadow gate still passes;
- at least 30 closed Shadow positions;
- at least 24 hours of Shadow evidence span;
- Shadow expectancy at least `0R`;
- Shadow profit factor at least `1.10`;
- Shadow R coverage at least 95%;
- money-grade Live Safety state has zero blockers;
- an active Strategy Control Plane config exists;
- no challenger/config transition is pending, testing, promotion-ready, or awaiting extension.

Shadow max drawdown above 10R is a warning by default.

### Shadow R derivation

Research natively stores `realized_r`. Older/current Shadow rows may not.

Readiness therefore uses the following deterministic priority without rewriting historical rows:

```text
stored realized_r
  -> pnl_sol / initial_risk_sol
  -> pnl_sol / (size_sol * abs(SL%))
  -> pnl_percent / abs(SL%)
```

The report exposes native versus derived R sample counts so the owner can see the telemetry quality.

## Confirm -> Live consideration gate

The gate requires:

- the Shadow -> Confirm gate still passes;
- the configured system mode is explicitly `confirm`;
- money-grade Live Safety state has zero blockers;
- Strategy Control Plane is stable with an active config;
- no pending Research exit settlement remains.

Passing produces:

```text
ELIGIBLE_FOR_LIVE_CONSIDERATION
```

It never produces `LIVE_APPROVED`, never changes `trading_mode`, and never creates a Live approval snapshot.

## Confirm telemetry caveat

Current Angel execution architecture routes Confirm through the same money-grade executor used by Live after per-trade human confirmation. Persisted capital-bearing positions are currently stored with Live execution identity.

Because historical storage does not safely distinguish a standalone Confirm performance population, Readiness V1 **does not invent a Confirm performance sample**.

This is intentional. A future telemetry migration can add explicit Confirm attribution only after all Live Safety queries and reconciliation invariants are migrated safely.

## Money-grade safety evidence

Readiness consumes the same durable safety state used by Live Safety hardening, including:

- unresolved execution operations;
- active capital reservations;
- unknown Live positions;
- open Live inventory anomalies;
- active buy operations missing reservations;
- broken reservation-operation links;
- duplicate active Live mints;
- circuit-breaker state;
- SQLite WAL mode;
- `synchronous=FULL` or equivalent FULL value;
- `busy_timeout`;
- foreign-key enforcement.

Any money-grade blocker prevents Shadow -> Confirm and Confirm -> Live consideration.

## Decision quality evidence

Decision Intelligence remains separate from trading authority. Readiness consumes its finalized outcome evidence to expose:

- executable probe completion rate;
- false-positive rate among finalized BUY decisions;
- missed-runner rate among finalized PASS/WATCH decisions;
- final sampled R;
- sampled MFE/MAE.

These metrics are warnings at the Research -> Shadow stage by default because Decision Intelligence may have fewer finalized 60-minute outcomes than the primary Research position sample. They still reduce the readiness score and are visible to the owner.

## Readiness score

Each hard check has weight 2 and each warning check has weight 1.

```text
score = passed weighted checks / total weighted checks * 100
```

The score is descriptive. Stage eligibility is determined by hard blockers, not by crossing an arbitrary score number.

## Telegram Manager V2

New deterministic command:

```text
/readiness
/readiness 24h
/readiness 7d
/readiness 14d
```

The report shows:

- current mode;
- current stage verdict and score;
- all three stage gates;
- Research expectancy/PF/drawdown/evidence coverage;
- executable entry and Exit V3 coverage;
- quote deterioration and round-trip spread;
- Decision Intelligence false-positive/missed-runner evidence;
- Shadow expectancy/PF/drawdown;
- money-grade safety blockers;
- current hard blockers.

Manager V2 conversational evidence now includes the entire deterministic readiness report. Examples:

```text
Angel apakah sekarang siap Shadow?
Apa yang masih memblokir Confirm?
Kenapa readiness cuma 72/100?
Kalau evidence bagus apakah sudah boleh Live?
```

For Live authorization requests, Manager V2 still refuses to approve or enable Live and points the owner back to deterministic owner controls.

## CLI

```bash
npm run readiness:report
npm run readiness:report -- 7d
npm run readiness:report -- 7d --json
```

CI runs the JSON report against a fresh database as a smoke test. A fresh database should return `NOT_READY`, not crash and not mutate trading authority.

## Safety invariants

Readiness V1 must preserve all of the following:

```text
Research capital                     0 SOL
Readiness transaction authority     NONE
Readiness setting mutation           NONE
Readiness mode mutation              NONE
Manager Live approval                FORBIDDEN
Manager signer access                NONE
Manager broadcast access             NONE
Strategy Analyst                     proposal-only
Safety Kernel                        sovereign
Human owner                          sole Live authority
```

Readiness is a decision-support layer, not an execution authority.
