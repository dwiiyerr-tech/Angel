# Needle Score v2 — Evidence-Gated Self-Calibration

Needle v2 turns the v1 composite score into a learning ranking system without allowing PAPER outcomes to silently rewrite LIVE behavior.

## Safety invariants

- Contract Safety remains binary authority. A failed contract-safety assessment still forces `0 / HARD_REJECT` regardless of Needle weights.
- The Safety dimension is fixed at **20/100** and cannot be self-calibrated lower or higher.
- Adaptive weights are bounded and always rebalanced to a total of 100.
- Calibration reads only the Needle dimension scores captured in the candidate snapshot at entry time. Post-entry market data is never used as an input feature.
- Calibrated weights are a challenger until they pass historical out-of-sample validation, a PAPER shadow test, and the existing human-gated Strategy Control Plane promotion flow.
- `needle_weights_json` is part of the LIVE configuration checksum. Promoting new weights invalidates any stale LIVE approval and requires a fresh approved LIVE snapshot.

## What it learns

Closed PAPER positions are labeled by their observed path rather than win rate alone. The calibrator measures how each entry-time Needle dimension separates tokens that later reach:

- **3R** — meaningful runner
- **5R** — strong runner
- **10R** — exceptional runner

The thresholds contribute 35%, 35%, and 30% of dimension skill respectively. Runner utility is reduced when a token only achieves the move after an excessive adverse excursion, so a messy 10R path is not treated as equal to a clean 10R path.

The adaptive dimensions are Dev Quality, Holder Distribution, Organic Flow, Liquidity Structure, Narrative, Early Asymmetry, Runner Probability, and Expected R. Safety never participates in adaptive reweighting.

## Anti-overfit design

The history is ordered chronologically and split into an older training partition and a newer validation partition. Training data proposes target weights; the newer partition decides whether those weights rank future runners better than the active weights.

The learned change is shrunk toward the active/prior weights according to sample reliability, capped by a maximum blend, and constrained by per-dimension bounds. Small samples therefore return the active weights unchanged rather than manufacturing confidence.

Default evidence gates are intentionally conservative:

- minimum usable PAPER sample: 80
- minimum out-of-sample validation sample: 20
- default training fraction: 70%
- prior strength: 60
- maximum adaptive blend: 45%

These are operational settings for the calibrator, not permission to weaken Safety.

## Two-stage challenger lifecycle

1. **Historical learning** — Needle evaluates closed PAPER entry snapshots and proposes bounded challenger weights.
2. **Historical OOS gate** — challenger must improve runner-ranking utility on the later validation partition without material degradation in 3R capture or realized expectancy.
3. **Proposal creation** — only an OOS-ready challenger can create a `needle_weights_json` Strategy Control Plane proposal.
4. **Human test approval** — the existing control plane must explicitly approve the proposal for PAPER testing.
5. **Forward PAPER shadow test** — every observed candidate is scored with both active and challenger weights using the exact same entry-time dimensions. Later MFE/MAE/realized-R outcomes are compared.
6. **Promotion readiness** — only enough aged forward PAPER evidence with improved runner ranking can mark the proposal `promotion_ready`.
7. **Human promotion** — existing promotion rules still apply and promotion is only allowed while configured in PAPER mode.
8. **Fresh LIVE approval** — because the weights are part of the LIVE config checksum, any promoted weight set requires a new LIVE config approval before LIVE execution.
9. **Rollback** — control-plane rollback restores the exact parent configuration, including deleting a child-only Needle setting when the parent predates Needle v2.

## Operator report

Run:

```bash
npm run needle:report
```

The JSON report includes active weights, training/validation sample sizes, per-dimension 3R/5R/10R lift and reliability, target weights, shrunk challenger weights, active-vs-challenger runner ranking metrics, and readiness flags.

To request creation of a Strategy Control Plane proposal only when the historical OOS gate is already satisfied:

```bash
npm run needle:report -- --propose
```

This command does **not** approve, promote, or enable LIVE trading. If evidence is insufficient or another proposal is open, it reports the reason and leaves configuration unchanged.
