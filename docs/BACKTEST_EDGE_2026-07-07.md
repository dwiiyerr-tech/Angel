# Charon Entry-Filter Backtest & Audit — 2026-07-07

Scope: 1146 CLOSED dry-run positions (`dry_run_positions`, pnl_percent NOT NULL).
Method: real snapshot_json features joined to pnl_sol/win. Every number below is
produced by `backtest_features.cjs` stdout or a direct readonly DB query — nothing
is hand-estimated. Consistency = time split at the median `opened_at_ms`
(boundary 2026-06-25T20:05:19Z): HALF-1 = earliest 573 trades, HALF-2 = latest 573.

Success metric = total `pnl_sol` (real bottom line), with win rate (pnl_sol>0) and
avg pnl_percent as supporting stats.

---

## 0. The single most important fact: the regime decayed

    SEGMENT   n     win%    total pnl_sol   avg pnl%
    FULL      1146  33.0%   +1.182          -5.9
    HALF-1    573   40.3%   +5.111          +1.8    (early: 06-04 .. 06-25)
    HALF-2    573   25.7%   -3.929          -13.6   (late:  06-25 .. 07-07)

The bot was profitable early and bleeding late. Win rate fell 40.3% -> 25.7% and
total pnl went from +5.1 to -3.9 SOL with NO filter change. This dominates
everything. Any filter that looks great "overall" is mostly riding HALF-1. The
honest bar for a real edge is: **does it also lift HALF-2 out of the red?**

---

## 1. Baseline (the number to beat)

FULL: **n=1146, win 33.0%, total pnl +1.182 SOL, avg -5.9%**.
Exit mix: TRAILING_TP 262 (+55.8% avg), MANUAL 55 (+45.7%), MAX_HOLD 334 (+1.1%),
SL 495 (-49.1%). Losers outnumber winners; the whole edge is a thin +1.18 SOL.

---

## 2. Individual feature edges (full / half-1 / half-2 + verdict)

Consistency rule (strict): a finalist PASSES only if its subset beats the
*respective* baseline on BOTH pnl_sol AND win rate in FULL, HALF-1 and HALF-2,
with >=30 trades in each half. This is deliberately harsh to kill overfit.

### 2.1 liquidityUsd — the real edge (PASS, every threshold)

    threshold      FULL                       HALF-1              HALF-2
    >= $5,121      n=1032 wr35.4% pnl+8.08     wr41.9% pnl+9.60    wr28.4% pnl-1.52
    >= $6,136      n=917  wr36.2% pnl+7.24     wr43.1% pnl+8.01    wr29.7% pnl-0.77
    >= $7,727      n=688  wr36.3% pnl+6.63     wr44.4% pnl+7.14    wr30.8% pnl-0.51
    >= $9,703      n=459  wr34.9% pnl+6.05     wr46.0% pnl+7.12    wr26.1% pnl-1.07
    >= $13,170     n=344  wr37.5% pnl+8.66     wr48.7% pnl+8.81    wr28.4% pnl-0.15
    >= $17,180     n=230  wr36.5% pnl+6.37     wr51.1% pnl+6.55    wr27.1% pnl-0.18

VERDICT: PASS. Every liquidity floor beats baseline pnl and win rate in FULL and
HALF-1, and beats the (negative) HALF-2 baseline. It is monotonic and stable —
the hallmark of a real signal, not a lucky bucket. Note HALF-2 pnl stays slightly
negative even here: liquidity does not *make* money in the bad regime, it stops
the bleeding (base H2 -3.93 -> ~-0.2 to -1.5). That is still a large improvement.

### 2.2 holderCount — weaker but same direction (PASS at the top)

    >= 168   n=689 wr35.7% pnl-5.32   (FULL pnl worse than base — mid buckets noisy)
    >= 324   n=346 wr37.0% pnl+1.13
    >= 440   n=230 wr39.6% pnl+1.35   H1 better, H2 better
    >= 735   n=115 wr40.9% pnl+3.68   strongest, but n thins out

Direction is right (more holders -> higher win rate, 34% -> 41%) and it holds in
both halves at the top end, but the pnl signal is muddier than liquidity because
mid-range holder counts (100-300) carry a lot of losers. Useful as a secondary
floor, not a primary gate.

### 2.3 Categorical routes

    route                    n     win%    total pnl_sol
    pumpportal_graduated     468   41.2%   +1.868      best-volume good route
    trenches_completed       163   40.5%   +4.854      best pnl route
    fee_trending             81    34.6%   +2.168
    dual_source              175   21.1%   -1.914      LOSER
    graduated_trending       156   20.5%   -3.237      LOSER
    trending                 70    22.9%   -0.725      LOSER
    fee_graduated_trending   16    25.0%   -0.457      low-n
    pumpfun_pregrad          17    11.8%   -1.375      LOSER, low-n

pumpportal_graduated and trenches_completed are the two routes that actually make
money. graduated_trending / dual_source / plain trending are structurally bad.

### 2.4 hasTrending flag — NEGATIVE signal

    hasTrending=true    n=661  wr27.7%  pnl+0.689  avg -13.3%
    hasTrending=false   n=485  wr40.2%  pnl+0.493  avg  +4.1%

Trending presence CORRELATES WITH LOSING (27.7% vs 40.2% win rate). This matters
for Part B.

---

## 3. Recommended CONSISTENT filter

The combo search evaluated 7,670 two/three-feature AND combos at n>=150; 1,062
passed the both-halves gate. The top ones all reduce to the same core:

    RECOMMENDED:  liquidityUsd >= $13,000  AND  holderCount >= 168

    SEGMENT   n     win%    total pnl_sol   vs baseline
    FULL      318   39.3%   +8.971          +7.79 SOL, +6.3pp win
    HALF-1    153   49.0%   +8.843          +3.73 SOL (base H1 +5.11)
    HALF-2    165   30.3%   +0.128          +4.06 SOL (base H2 -3.93 -> POSITIVE)

This is the recommendation because it is the ONLY class of filter that flips
HALF-2 from negative to (barely) positive while also being monotonic and backed
by 300+ trades. It is not a lucky bucket — every neighboring liquidity threshold
behaves the same way (section 2.1).

IMPORTANT caveat on `hasTrending`: the raw top combo the script printed was
"liq>=13170 AND holderCount>=168 AND hasTrending=true" (FULL pnl +9.23). Do NOT
read that as "require trending." Adding hasTrending=true barely changes the result
(+9.23 vs +8.97 for the 2-feature version) and it drops pumpportal_graduated
entirely — a route that itself makes money. The hasTrending term is a near-no-op
here that only survives because liquidity+holders already did the work. Ship the
clean 2-feature filter; do not add a trending requirement.

Route composition of the recommended subset (for sanity): trenches_completed 93,
fee_trending 62, graduated_trending 57, dual_source 51, trending 42, fee_grad 7.
pumpportal_graduated is absent only because those rows carry hasTrending=false
AND mostly report liquidity below the floor — worth a follow-up, not a blocker.

Projected effect vs baseline: cut trade volume ~72% (1146 -> 318), lift win rate
+6.3pp, and turn +1.18 SOL into +8.97 SOL — with the gain present in BOTH halves.

Concrete thresholds to encode: `min liquidityUsd = 13000`, `min holderCount = 168`.
A looser variant (`liquidityUsd >= 6000`, keeps ~917 trades, FULL +7.24, both
halves positive-delta) is the higher-volume option if slot starvation is a concern.

---

## 4. PART B — static filter audit (current live config = strategy `sniper`,
enabled=1; filter reads ONLY `activeStrategy()`.config_json, NOT the settings
table numbers — those are decoys)

Active thresholds actually in force (from strategies.config_json, sniper):
min_holders=100, min_mcap=0, max_mcap=0, min_gmgn_total_fee_sol=0,
trending_min_volume_usd=5000, trending_min_swaps=0, max_top20=100,
token_age_max_ms=0 (age check OFF), require_fee_claim=false, sl=-35, tp=75,
trailing=15, max_hold_ms=1,800,000 (30min), max_open_positions=5, use_llm=false.
All the v40/audit hard rejects are commented out ("AUDIT MODE 2026-07-05"). So the
only gates that fire today are: fresh-grad data sanity, min_holders=100 (non-fresh),
trending_min_volume_usd=5000 (when trending present), wash-trade flag, DEX
liquidity<$2000, negative-momentum, and the v45 soft score.

Findings ranked by pnl_sol impact:

### B-1 (BIGGEST BUG): `trending_min_volume_usd = 5000` is INVERTED
Among rows that carry trending volume:
    trendingVol <  5000  (REJECTED by gate): n=403  wr28.3%  pnl -3.41
    trendingVol >= 5000  (ADMITTED by gate): n=397  wr27.5%  pnl -13.87
The gate keeps the WORSE half. Higher trending volume = MORE loss here
(the whole trendingVolumeUsd sweep in section 2 is monotonically negative:
>=$1,754 -> pnl -18.1, wr 25.5%). This gate is actively selecting losers.
Impact: it is admitting ~-14 SOL of trades and rejecting a less-bad set.
Recommendation: this threshold should be removed or inverted to a CAP, not a floor.
(Analysis only — no change made.)

### B-2: `hasTrending`/trending routes admitted despite being the losing side
Section 2.3/2.4: graduated_trending (-3.24), dual_source (-1.91), plain trending
(-0.73) are all net negative, and hasTrending=true wins 27.7% vs 40.2% for false.
Nothing in the current filter demotes these routes. The soft score has no
route-level penalty for graduated_trending/dual_source. These three routes
together are ~-5.9 SOL of drag that the recommended liquidity+holder filter only
partially cleans up.

### B-3: v45 soft score is running on mostly-missing data
computeSoftScore leans on jupiterAsset.audit (botHolders, top10, devMigrations),
trending.organic_score and trending.smart_degen_count. Coverage in the closed set:
    jupiterAsset.audit populated: 949/1146 (83%)  — ok
    trending.smart_degen_count:    65/1146 (6%)   — mostly absent
    trending.organic_score:         0/1146 (0%)   — NEVER present
So the +20 "organic score" bonus can never fire, and the smart-degen bonus fires
on 6% of candidates. The positive side of the score is largely dead weight; the
score is driven almost entirely by the liquidity/bot/top10 penalties.

### B-4 (LOGIC BUG): soft-score dynamic threshold is broken in ESM
`globalOpenPositionCount()` does `require('./positions.js')` inside a try/catch.
This project is `"type":"module"` (the backtest itself failed on require until I
renamed it .cjs). `require` is not defined in ESM, so this ALWAYS throws and
returns 0. Result: `softScoreThreshold()` always takes the openCount===0 branch
and returns baseThreshold-10 = **20** — the loosest possible threshold, forever,
regardless of how many positions are open. The intended "tighten to 40 when full"
logic is dead. Effectively the soft gate is pinned at 20/100, so almost everything
passes. (This is a real bug; flagging only, not patching.)

### B-5: min_holders=100 gate — correct direction, keep it
    holders <100 (rejected, non-fresh): n=89  wr 4.5%  pnl -2.79
    holders>=100 (admitted, non-fresh): n=572 wr31.3%  pnl +3.48
This gate is doing real work — the rejected bucket wins 4.5%. Backtest supports
raising it toward ~168 (section 2.2) for further lift, but 100 is already net-right.
This is the one current gate that agrees with the data.

### B-6: the known prior finding (fresh-grad bot% > 50 rejecting winners)
Cannot reproduce as a live inversion: the bot-dominance hard reject
(`botHolders>=50 && route==pumpportal_graduated`) is COMMENTED OUT (audit mode),
and in the soft score fresh grads are exempt from most penalties and even get
+10 momentum. So the old false-negative is not active today. pumpportal_graduated
in the data wins 41.2% (+1.87 SOL) — it is NOT being suppressed now. Prior finding
= already neutralized; no action needed, but do not re-enable that hard reject.

---

## 5. What NOT to do (overfit traps that FAILED the split)

These looked great overall and collapsed in HALF-2 — classic regime-riders:

- bot_degen_count >= 97  (FULL wr46.1% pnl+5.37) — FAIL. HALF-2 had only 17 of
  these trades (wr 23.5%, pnl -0.12). The feature only exists on 163 rows
  (trenches route) and 98 of them are in HALF-1. Pure early-regime artifact.
- gmgnTotalFeesSol >= 13.18 (FULL pnl+5.30) — FAIL. H1 +6.34 vs H2 -1.04. High
  GMGN fees just marked the early winners; no forward edge.
- trendingSmartDegenCount >= 9 (FULL wr44.0% pnl+4.92) — FAIL. H1 wr52% pnl+5.05,
  H2 wr30% pnl-0.13. And it only fires on 116 rows. Seductive, not robust.
- route == pumpportal_graduated as a standalone rule — FAIL the strict test: it is
  net-positive but its win-rate edge is uneven across halves and it does not beat
  the H1 baseline pnl. Good route, not a good *sole* filter.
- Any marketCapUsd / entry_mcap floor — FAIL. The mcap sweeps are noisy and mostly
  NEGATIVE-pnl in the mid buckets (e.g. >=$20.6k -> pnl -12.4). Market cap is not
  a usable entry gate here.
- trendingVolumeUsd / trendingSwaps floors — FAIL and BACKWARDS (see B-1). More
  trending activity = more loss. Never gate on a minimum of these.

Rule of thumb this dataset teaches: single-feature "high win rate" buckets with
<150 trades or lopsided half-coverage are almost all HALF-1 echoes. Only
liquidity (and to a lesser degree holderCount) survived an honest time split.

---

## 6. STATISTICAL HONESTY

The edge is real but modest. Even the recommended filter only makes HALF-2
break-even (+0.13 SOL over 165 trades) — it stops losses, it does not print money
in the bad regime. Total FULL pnl of +8.97 SOL over 318 trades is ~0.028 SOL/trade
on a 0.1 SOL position size; that is a thin margin sensitive to fees/slippage.
The 40.3% -> 25.7% win-rate decay across the split is the real story: the market
got harder, and no feature in this dataset fully compensates. Treat liquidity>=13k
& holders>=168 as risk reduction with proven cross-regime consistency, not as an
alpha generator. Re-run this split monthly — if HALF-2-style regimes persist, the
right move may be to trade smaller/less, not to hunt for a magic threshold.

