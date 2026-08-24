# Angel Rebuild — 2026-08-25

This document is the durable design record for the Angel rebuild following the `feat: unify simulation mode with shadow-live verification` upgrade.

## 1. Why this rebuild exists

Angel evolved from the Charon/Kaiser lineage into a much stronger execution-safety system: contract safety, transaction simulation, effect validation, execution-operation reconciliation, circuit breakers, Telegram authorization, live-config approval, hard wallet/exposure limits, improved testing, a long-running ML service, and advisory learning.

The downside was strategy drift toward excessive rejection. Several independent risk layers could reject or shrink the same opportunity, and the August simulation upgrade introduced a concrete mode-semantics gap.

The target philosophy is:

> Protect against catastrophic loss; aggressively pursue asymmetric opportunity.

Or operationally:

> Hunter alpha engine + paranoid safety kernel.

The safety kernel is never weakened to make the alpha engine more aggressive.

## 2. Root cause found after the simulation upgrade

Before this rebuild, `tradingMode()` converted both `dry_run` and `simulation` into `shadow_live`.

At the same time, the orchestrator still contained checks such as:

```text
if (mode === 'dry_run')
```

and safety decisions such as:

```text
tradingMode() !== 'dry_run'
```

This produced two problems:

1. The old dry-run entry branch became effectively unreachable.
2. A user-configured dry-run/simulation was frequently treated as money-grade `shadow_live`, including wallet-grade evidence and ML availability requirements.

Research simulation and pre-live verification had become conceptually merged even though they have different jobs.

## 3. Rebuilt mode model

Angel now treats mode semantics explicitly.

### Research

Aliases: `dry_run`, `dry-run`, `simulation`, `research`.

Purpose: collect real-market execution evidence without risking capital.

Properties:

- real capital used: **0 SOL**
- no private key required
- no wallet balance required
- no signing
- no transaction broadcast
- real Jupiter position-sized quotes
- virtual notional used only to probe liquidity and price impact
- R, MFE, MAE and timing tracked
- adaptive route blocks are evidence, not automatic research suppression
- LLM is advisory; deterministic Hunter policy may sample an otherwise valid setup

### Shadow live

Purpose: pre-live verification.

Properties:

- wallet-aware
- live transaction construction/simulation
- no broadcast
- money-grade contract evidence
- live-style risk budgets
- verifies the exact execution stack before capital is enabled

### Confirm

Purpose: create an approved trade intent and wait for explicit confirmation.

### Live

Purpose: real execution.

All existing money-safety controls remain authoritative.

## 4. Zero-capital research semantics

A zero-capital simulation cannot request a meaningful executable quote for `0 SOL`. Therefore Angel separates capital from quote notional:

```text
real_capital_sol = 0
sim_notional_sol = 0.05  # default research probe
```

`size_sol` is temporarily retained as a legacy virtual-accounting notional because the mature position/exit engine uses it to calculate partial exits and virtual PnL. It MUST NOT be interpreted as real capital for `execution_mode='research'`.

User-facing output must always show:

```text
Capital: 0 SOL
Probe:   <sim_notional_sol> SOL
```

### Quote ladder

Default probe ladder:

```text
0.01, 0.025, 0.05, 0.1 SOL
```

The ladder measures how the same opportunity degrades with size due to liquidity and price impact. It can later support capacity curves such as:

```text
0.01 SOL -> +4.9R
0.05 SOL -> +4.2R
0.10 SOL -> +2.8R
0.25 SOL -> +0.7R
```

No order is submitted for any ladder point.

## 5. R-based research model

Planned R:R is a hypothesis, not an outcome.

For a virtual notional and initial stop:

```text
initial_risk_sol = notional * abs(stop_pct) + expected entry fee + expected exit fee
```

Then:

```text
R multiple = virtual PnL SOL / initial_risk_sol
```

Research records:

- `initial_risk_percent`
- `initial_risk_sol`
- `planned_rr`
- `realized_r`
- `mfe_percent`
- `mae_percent`
- `mfe_r`
- `mae_r`
- `time_to_mfe_ms`
- `time_to_mae_ms`
- low-water price/mcap
- data-quality label

### MFE

Maximum Favorable Excursion: the best virtual outcome available while the trade was open.

### MAE

Maximum Adverse Excursion: the worst drawdown experienced while the trade was open.

These metrics allow future stop/exit decisions to be learned from distributions rather than arbitrary percentages.

## 6. Research report

Run:

```bash
npm run research:report
```

The report includes:

- closed research trades
- real capital used (always 0)
- win rate
- expectancy R
- median R
- average winner R
- average loser R
- profit factor in R
- median MFE R
- median MAE R
- capture efficiency
- median time to MFE
- data-quality counts

The primary optimization target should be **expectancy R**, not win rate.

## 7. Hunter policy

Soft uncertainty should usually change size, not veto the opportunity.

Default confidence sizing bands:

| Confidence | Multiplier |
| --- | ---: |
| 90–100 | 1.00x |
| 70–89 | 0.85x |
| 50–69 | 0.60x |
| 30–49 | 0.30x |
| <30 | skip |

Soft-risk severity then reduces that multiplier.

The rule is:

```text
soft risk        -> YES, but smaller
catastrophic risk -> NO
```

Research uses this policy aggressively because real capital is zero. Promotion of Hunter sizing into live capital must be evidence-gated by research/shadow results and must not remove any Safety Kernel invariant.

## 8. Hard Safety Kernel invariants

These are not alpha knobs and must not be bypassed by an LLM, ML model, Hunter mode, research lesson or market regime:

1. Telegram/chat authorization.
2. Live config snapshot approval/checksum.
3. Execution-operation claim/deduplication.
4. Transaction simulation before live broadcast.
5. Swap-effect validation.
6. Expected fee-payer/wallet validation.
7. Jupiter slippage configuration.
8. Ambiguous transaction reconciliation.
9. Hard wallet reserve.
10. Hard maximum position/exposure/daily entries/daily loss.
11. Catastrophic contract-safety checks.
12. Circuit breaker and unresolved-operation protection.
13. Live confirmation/receipt validation.

AI may rank opportunities and advise size. AI may not override this list.

## 9. Mixed-mode monitoring invariant

Positions are monitored according to the `execution_mode` stored on each position, not according to the current global mode setting.

This prevents an important failure case:

```text
research position open
-> global mode changed
-> research position accidentally orphaned or treated as live
```

The mixed-mode monitor separately handles research positions and execution positions. Only live monitoring failures propagate to the live circuit-breaker escalation path.

## 10. Upgrade strategy to minimize regression gaps

Every substantial strategy/execution change should follow this order:

1. Write/extend a design invariant.
2. Add a unit/integration test that would fail under the previous bug.
3. Implement on a feature branch.
4. Run `npm run check` in CI.
5. Run research simulation first.
6. Compare R-distribution and data quality, not only PnL/win rate.
7. Promote to shadow-live verification.
8. Review money-safety behavior.
9. Only then consider live promotion.

Do not patch `main` directly for large strategy changes.

## 11. Regression tests added by this rebuild

The rebuild locks the following behaviors:

- `dry_run` and `simulation` normalize to Research, not shadow-live.
- Research never requires money-grade evidence.
- Shadow/live modes retain wallet/money-grade semantics.
- Research real capital remains exactly 0.
- Virtual notional remains positive so Jupiter can return executable quotes.
- Planned R:R calculation is stable.
- MFE/MAE and R calculations are stable.
- Soft risk can reduce a Hunter sample instead of automatically rejecting it.
- Catastrophic safety always returns zero size/reject.
- Research lifecycle creates observations without converting virtual notional into real capital.

GitHub Actions now runs lint and tests for PRs and feature/fix branches.

## 12. What this rebuild intentionally does NOT do

This rebuild does not claim that Angel has a proven profitable edge.

It also does not immediately push aggressive Hunter sizing into live money. That would recreate the exact anti-pattern this rebuild is designed to remove: changing execution risk before obtaining clean evidence.

Research is the aggressive laboratory. Shadow-live is the execution verification layer. Live is the protected capital layer.

## 13. Next research layer

Once enough clean observations exist, add a strategy replay engine that replays the same recorded path against multiple counterfactual policies:

```text
SL10 / TP30
SL15 / TP60
SL15 / trailing15
SL20 / trailing20
ATR stop / dynamic trail
runner / no fixed TP
partial TP variants
```

One real market path can then evaluate many exit policies without generating separate trades.

The promotion metric should include:

- expectancy R
- profit factor R
- drawdown in R
- MFE/MAE distribution
- capture efficiency
- result stability across time/regime/route/liquidity buckets
- executable-quote data quality

## 14. Target architecture

```text
SIGNALS
  |
  v
CANDIDATE / HARD CATASTROPHIC SCREEN
  |
  v
ALPHA ENGINE (Hunter)
  |-- pre-score
  |-- momentum
  |-- LLM advisory/context
  |-- narrative/smart-money evidence
  |-- opportunity tier
  |
  +------------------------+
  |                        |
  v                        v
RESEARCH                  MONEY-GRADE PATH
0 SOL                     shadow / confirm / live
real quotes                    |
R / MFE / MAE                  v
  |                       SAFETY KERNEL
  v                            |
EVIDENCE                       v
  |                       EXECUTION
  +-------------> controlled promotion
```

The long-term decision loop is:

```text
regime detector
-> opportunity ranking
-> portfolio/risk allocator
-> deterministic safety/execution kernel
-> outcome attribution
-> controlled learning
```

The core rule for all future upgrades is simple:

> Never make the safety kernel smarter by making mode semantics ambiguous, and never make the alpha engine safer by silently turning every uncertainty into a veto.
