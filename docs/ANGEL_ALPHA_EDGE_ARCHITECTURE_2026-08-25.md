# Angel Alpha / Edge Architecture — 2026-08-25

This document consolidates the owner's working specification from the Wiyar audit, the Iza discussion, the Kaiser.charon comparison, and the Angel Research rebuild.

## 1. Core operating model

Angel separates opportunity from irreversible safety:

```text
SIGNALS
  |
  +-- PumpPortal / pre-grad / graduated
  +-- Trending / fee / trenches / flow
  |
  v
SAFETY KERNEL                -> reject / pass
  |
  v
QUALITY LAYER                -> score
  |
  v
MOMENTUM ML                  -> P(momentum continuation)
  |
  v
RUNNER MODEL                 -> P(clean runner)
  |
  v
ROUTE EDGE MODEL             -> P(win), Expected R
  |
  v
LLM STRATEGY ANALYST         -> interpretation / ranking / proposal
  |
  v
RISK ENGINE                  -> penalty
  |
  v
POSITION SIZING              -> size
  |
  v
EXECUTION SAFETY -> JUPITER -> RECONCILIATION -> LEARNING DATA
```

The authority boundary is permanent:

- Safety Kernel decides catastrophic reject/pass.
- Quality describes market quality; it is not contract safety.
- Edge models estimate probability/expectancy; they do not bypass Safety.
- Risk Engine applies penalties and hard capital caps.
- Position engine chooses final size.
- LLM may analyze and propose, but is never the risk or execution authority.

## 2. Wiyar audit requirements retained

The Wiyar audit concluded that Angel already had a strong safety foundation but risk/execution needed to become one atomic and persistent source of truth before increasing live aggression. The implementation roadmap therefore preserves these priorities:

P0:
- persistent/atomic entry reservation,
- exposure = open + pending + reserved,
- UNKNOWN -> RECONCILING -> CONFIRMED/FAILED,
- orphaned successful execution recovery.

P1:
- SQLite integrity / WAL / busy timeout / foreign-key/state validation,
- concurrency and restart recovery tests,
- LLM calibration through Research/Shadow rather than direct live-size increases.

P2:
- group correlated evidence into MARKET / ONCHAIN / FLOW / NARRATIVE / EXECUTION,
- improve observability,
- optimize TP/SL only after enough closed-trade evidence.

No alpha feature is allowed to weaken these invariants.

## 3. Iza configuration-control target

The desired learning loop is versioned and human-approved:

```text
config-v31
   |
7-day Research/Shadow evidence
   |
LLM Strategy Analyst
   |
PROPOSE config-v32
   |
Human APPROVE / REJECT / EXTEND TEST
   |
Shadow challenger validation
   |
PROMOTE or ROLLBACK to v31
```

A config version must be immutable and parent-linked. A later phase should store at least:

- config version + parent version,
- prompt-set version,
- Momentum model version,
- Runner model version,
- Route Edge model version,
- simulator version,
- evidence window/sample,
- approval hash/timestamp,
- rollback reason.

Protected Safety Kernel keys cannot be proposed by the LLM.

## 4. Kaiser.charon lessons retained

Kaiser frequently captures runners because its pipeline is momentum-first:

- PumpPortal / fresh-grad timing is early,
- flow checks favor positive 1h direction and net buyers,
- Momentum ML explicitly predicts runner-like outcomes,
- admission is permissive enough to let uncertain fresh tokens be observed,
- trailing logic lets large winners run.

Angel should copy the hunting instinct, not Kaiser's weaker execution/risk guarantees.

The resulting philosophy is:

> Kaiser instinct + Angel armor.

And for non-catastrophic uncertainty:

> YES, but smaller.

## 5. Runner Model v1

Kaiser's historical classifier used exit labels such as TRAILING_TP versus MAX_HOLD. Angel's Research data is richer, so Runner v1 uses future path instead.

Default clean-runner label:

```text
MFE >= +3R
AND MAE >= -1R
AND time-to-MFE <= 30 minutes
```

If MFE reaches the target but MAE is worse than the clean-path threshold, the sample is `messy_runner`, not a clean runner.

Prediction is Bayesian/evidence-weighted across:

- route,
- Momentum bucket,
- Quality bucket,
- liquidity bucket,
- holder bucket,
- 5m net-buyer-flow bucket.

Insufficient samples remain advisory and cannot veto a candidate.

## 6. Route Edge Model v1

Route Edge estimates:

```text
P(win | route, regime)
Expected R | route, regime
```

It uses hierarchical shrinkage:

```text
global history
   -> route posterior
      -> route + regime posterior (only when enough samples)
```

This prevents a tiny route sample from being treated as a proven edge.

The initial regime buckets are deliberately coarse:

- hot,
- neutral,
- weak.

They use Momentum, 1h direction and short-window net-buyer participation.

## 7. Quality Layer v1

Quality is now separated conceptually from Safety and Edge. It returns a 0-100 score from available market/flow/audit evidence while also reporting data quality.

Missing evidence is `null`, not silently converted to zero.

Quality does not reject catastrophic contracts; Contract Safety owns that decision.

## 8. Research-first promotion policy

New probability models enter the system as evidence first.

When samples are insufficient:

```text
probability estimate -> LOW quality / not decision-eligible
                         |
                         +-> no hard veto
```

Once minimum evidence is reached, they may influence Research/Shadow ranking. Promotion into live position sizing should happen only through the versioned configuration-control process and human approval.

## 9. Current simulator foundation

Research remains:

- real capital = 0 SOL,
- positive virtual Jupiter probe notional,
- no signer,
- no broadcast,
- executable entry/exit quotes when available,
- latency re-quote / deterioration,
- round-trip friction,
- dynamic priority-fee estimate,
- optional Jito-tip estimate,
- R / MFE / MAE / time-to-excursion tracking.

This data is the source for Runner and Route Edge learning.

## 10. Next phase after this PR

After Runner/Route Edge evidence is collecting reliably:

1. build immutable `config-vN` registry,
2. version Candidate / Strategy / Config-review prompts,
3. weekly Strategy Analyst report,
4. Telegram APPROVE / REJECT / EXTEND TEST workflow,
5. Shadow challenger versus active control,
6. evidence-based promotion,
7. automatic performance rollback with minimum samples,
8. immediate deterministic safety rollback for safety invariant violations.

Live Safety Kernel remains unchanged throughout.
