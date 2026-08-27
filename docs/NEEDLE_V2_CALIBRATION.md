# Needle v2 — Empirical Calibration Challenger

## Canonical Solana microcap workflow

`Signals → Enrichment → Contract Safety → PreScore/CoS → Momentum ML → Runner Probability → Route P(win)/Expected R → 9D Needle Score → Candidate Ranking → LLM Best-Candidate Selection → Market Allocator → Fresh Execution Recheck → PAPER/LIVE`

This sequence is the canonical decision pipeline. Contract Safety remains authoritative and non-compensable. Needle is an opportunity-ranking layer after Safety/edge evidence, not a standalone LIVE authorization gate.

## Why calibrate Needle

Needle v1 begins with fixed expert priors. Needle v2 measures whether the dimensions observed at decision time actually predict asymmetric outcomes in PAPER history.

The calibration objective is intentionally not win rate. It combines:

- realized R;
- MFE/right-tail opportunity;
- 3R runner recall;
- 5R runner recall;
- 10R runner recall;
- MAE/downside awareness.

## Point-in-time invariant

Training samples are built only from the `candidate.needle` evidence stored in the entry snapshot. Outcomes are joined only after the PAPER position is closed. The model never recomputes historical entry features using newer market history.

Rows without a point-in-time Needle snapshot are excluded instead of guessed.

## Walk-forward split

Samples are sorted chronologically by entry time. The default split is:

- first 70%: training;
- final 30%: holdout.

Future holdout outcomes are not used to fit weights. This is a deliberate leakage guard.

## Immutable Safety

Safety remains fixed at 20/100 and keeps the existing hard-reject semantics. The adaptive learner can only redistribute the other 80 points:

- Dev Quality;
- Holder Distribution;
- Organic Flow;
- Liquidity Structure;
- Narrative;
- Early Asymmetry;
- Runner Probability;
- Expected R.

Low-sample dimensions are shrunk toward their v1 prior instead of being allowed to dominate.

## Challenger evaluation

The challenger is evaluated on the untouched holdout window against Needle v1. The report compares:

- rank correlation with screening utility;
- top-quartile expectancy R;
- top-quartile loss rate;
- 3R recall;
- 5R recall;
- 10R recall.

Default evidence gates require at least 60 total samples, including 40 train and 20 holdout samples. A challenger is marked promotion-ready only when top-quartile expectancy improves by at least 0.05R while rank quality and 5R/10R recall do not materially degrade.

`promotionReady` is evidence only. It never changes LIVE behavior automatically. Human/control-plane approval remains required before any future active-weight integration.

## Operator command

Run:

```bash
npm run needle:calibrate
```

The command prints the canonical workflow, sample sufficiency, fixed control weights, learned challenger weights, holdout performance, and promotion-readiness evidence.

## Current authority boundary

Needle v2 calibration is a research/challenger layer. The production decision sequence remains:

1. Safety and hard risk vetoes.
2. Edge/Needle opportunity ranking.
3. LLM best-candidate selection.
4. Market allocation.
5. Fresh execution-time recheck.
6. PAPER or explicitly approved LIVE execution.

No learned weight may bypass Contract Safety, Market Allocator, execution risk checks, LIVE config approval, or fresh quote/market-state validation.
