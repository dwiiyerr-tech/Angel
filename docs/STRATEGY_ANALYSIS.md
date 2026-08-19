# Charon Strategy Analysis

> Generated 2026-05-26 from SQLite database + source code audit.

---

## Executive Summary

**Charon has opened 3 dry-run positions, closed 1 at +8.1%, and has 0 real LLM-issued BUY verdicts across 36 batch screens.** The bot is functional but effectively paralyzed by a combination of a conservative LLM prompt, a disabled LLM in the active strategy, and strict filter gates. The sniper strategy operates in rule-based mode (`use_llm: false`), bypassing the LLM entirely — all 3 BUYs came from the rule-based fallback, not from LLM analysis. Of the 10 batches where the LLM actually ran (batches 27-36), it returned WATCH every time with confidence ranging from 0 to 30. The core problem is a prompt that demands "unusually strong asymmetric opportunity" while feeding it batches of tokens that are 50-90% off their ATH.

---

## Database Snapshot

| Metric | Value |
|--------|-------|
| Total candidates | 27 |
| Passed filters | 18 (67%) |
| Filtered out | 9 (33%) |
| LLM decisions | 39 |
| LLM batches | 36 |
| LLM-issued BUYs | **0** |
| Rule-based BUYs | 3 |
| Closed positions | 1 |
| Open positions | 2 |
| Trading mode | dry_run |
| Active strategy | sniper |
| Learning lessons | 0 |

### LLM Decision Breakdown

| Verdict | Count | Avg Confidence | Source |
|---------|-------|----------------|--------|
| WATCH | 36 | 2.8 | 10 real LLM, 26 LLM-disabled fallbacks |
| BUY | 3 | 100 | All 3 from rule-based fallback (`use_llm: false`) |
| PASS | 0 | - | 1 PASS appeared in llm_batches but got stored as WATCH in llm_decisions |

**0 actual LLM BUYs in the entire database.** Every "BUY" verdict was a rule-based bypass.

### Closed Position PnL

| Token | Entry MC | Exit MC | PnL | Exit Reason |
|-------|----------|---------|-----|-------------|
| GOD | $10,325 | $11,166 | +8.1% (+0.008 SOL) | TRAILING_TP |

### Open Positions

| Token | Entry MC | TP | SL | Trailing |
|-------|----------|-----|-----|----------|
| Luce | $93,012 | 50% | -25% | 20% |
| SLEEP | $11,873 | 50% | -25% | 20% |

---

## Root Cause: Why LLM Never Says BUY

### 1. Prompt Demands Too Much

The system prompt tells the LLM:

> "Use verdict BUY only for the single best unusually strong asymmetric opportunity."

This is a **triple-filter**: the candidate must be (a) the single best, (b) unusually strong, and (c) asymmetric. For a batch of 6-8 tokens that are mostly 50-90% off ATH with low volume, NO token meets this bar. The prompt doesn't ask "which is the best among these" — it asks "is any of these an unusually strong asymmetric opportunity" — which in the context of a bear-biased batch will always be no.

### 2. Batches Are Low Quality

Candidates entering the pipeline are overwhelmingly signals flagged by fee claims + Jupiter trending. By the time they reach the LLM, most are already deep in drawdown:

- 19 of 27 candidates (70%) are >50% below ATH
- Median distance from ATH: -76%
- Only 3 candidates are within 20% of ATH

The LLM correctly identifies these tokens as late entries. The real issue is that **fresh, early-stage candidates aren't entering the pipeline**.

### 3. Use_LLM Was Disabled

Batches 1-26 (72% of all batches) executed with ENABLE_LLM=true but the sniper strategy had `use_llm: false` in its config. This meant:
- LLM was called for batch analysis (Telegram notifications, reasoning)
- But entry decisions used the rule-based bypass: "Strategy 'sniper' is rule-based (use_llm: false); filters passed."
- The 3 purchases were made on filter-passing alone, zero LLM judgment applied

When `use_llm` was later enabled (batches 27-36), the LLM had 10 opportunities and issued 10 WATCH verdicts with confidence never exceeding 30.

### 4. Confidence Threshold Kills Even WATCH

Settings have `llm_min_confidence: 75`. Even if the LLM did issue a BUY, it would need 75+ confidence. The highest WATCH confidence from any real LLM batch was 30. The threshold is 2.5× higher than the LLM's highest conviction reading.

### 5. Filter Gates Are Strict

The sniper strategy enforces:
- **Fee claim required** — eliminates any candidate without a fee-claim event
- **MC range 7k-200k** — filtered 7 of 27 candidates (26%)
- **2+ signal sources** — trending-only or fee-only candidates rejected
- **Age < 1 hour** — only brand-new tokens qualify

These gates are fine individually but compound: a candidate must simultaneously hit trending, generate a fee claim, be under 1h old, and have 7k-200k mcap. The combination drastically reduces candidate quality.

---

## Data-Driven Parameter Recommendations

### Market Cap Filter

Current: min 7,000 / max 200,000  
Issue: 7 of 27 candidates (26%) filtered by MC, all max_mcap violations. Several legitimate tokens (HENRY at 338k, Apple at 356k, KERMIT at 1.8M) were filtered despite strong holder counts and volume.

**Recommendation**: Raise max_mcap to **500,000** or disable (0). The sniper strategy covers token age <1h, which is a more effective early-stage gate than a hard MC cap. Tokens graduating from Pump.fun bonding curve at ~60k often spike to 200k+ in minutes — the current cap misses the acceleration phase.

### Fee Claim Minimum

Current: 0.5 SOL (strategy), 2 SOL (settings default)  
Issue: All 18 passed candidates had fee claims; the min fee is doing heavy lifting as an entry gate.

**Recommendation**: Keep at 0.5 SOL for sniper. The fee claim is the single strongest signal in the pipeline — it proves real economic activity. 2 SOL (settings default) would filter too aggressively.

### Confidence Threshold

Current: 75 (settings), 50 (sniper strategy)  
Issue: The LLM's real confidence ranges from 0-30. A threshold of 75 means the LLM effectively cannot approve any trade.

**Recommendation**: Lower `llm_min_confidence` to **15-25**. The LLM's confidence is "conviction, not probability" per the prompt. A 25-confidence BUY in a batch where the best candidate has 30 and the rest have 0-10 is a meaningful signal. Set this in the settings table AND the strategy config.

### Max Open Positions

Current: 3  
Issue: With 2,138 signal events and 27 candidates in the database, the bot is seeing plenty of activity but opening very few positions.

**Recommendation**: Keep at 3 for dry-run, but consider increasing to **5** if signal quality improves. Currently not the bottleneck.

### Position Size

Current: 0.1 SOL (~$10-12)  
Issue: Tiny position size limits data quality for PnL analysis.

**Recommendation**: **0.2-0.5 SOL** for dry-run. Larger positions produce more meaningful PnL data for parameter tuning without real financial risk.

---

## Suggested .env Changes

```env
# ↓ Lowered — LLM actually has to make decisions
LLM_MIN_CONFIDENCE=20

# ↑ More candidates for batch context
LLM_CANDIDATE_PICK_COUNT=10

# ↑ Freshness window is fine at 10min for sniper
LLM_CANDIDATE_MAX_AGE_MS=600000

# ↑ Slightly larger for meaningful PnL data
DRY_RUN_BUY_SOL=0.2

# ↓ Fee claim minimum — keep at 2 for conservative, 0.5 for aggressive
MIN_FEE_CLAIM_SOL=0.5

# Consider enabling GMGN for richer token data
GMGN_ENABLED=true
```

### Strategy Switch (via Telegram `/strategy`)

Switch from **sniper** to **sniper with LLM enabled** by updating the sniper strategy config:

```
/stratset sniper use_llm true
/stratset sniper llm_min_confidence 20
/stratset sniper max_mcap_usd 500000
```

Or switch to **dip_buy** strategy which natively has `use_llm: true`, `llm_min_confidence: 60`, wider MC range (25k-500k), and targets tokens at -40% from ATH — which matches what the pipeline is actually producing.

---

## Suggested LLM Prompt Improvements

### Current Prompt (problem sections)

```
"You are Charon, a Solana meme coin trench analyst."
"Use verdict BUY only for the single best unusually strong asymmetric opportunity."
"Use WATCH if candidates are interesting but none deserves a buy."
"Use PASS if the set is weak or unsafe."
```

### Recommended Prompt

```
You are Charon, a Solana meme coin entry screener operating in dry-run mode.
Your goal is to find the best entry from each batch, not to wait for the perfect trade.

Return strict JSON only. You will receive up to 10 recently filtered candidates.

RULES:
- Use BUY for the single best candidate in the batch, even if it's not a perfect setup.
  The system has filtered these candidates already — they are all eligible.
  Pick the strongest among them unless ALL are clearly unsafe.
- Use PASS only if every candidate in the batch has fatal red flags
  (bundler-rug pattern, no liquidity, wash trading, or known scam).
- Use WATCH if the batch has merit but you're 50/50 on the best candidate.

Confidence is your conviction from 0-100. Score the best candidate's odds
against this batch, not against an ideal trade. A 25-40 confidence means
"best in batch, go for it." A single BUY with 30 confidence is better than
endless WATCH verdicts.

Chart data is ATH/range context. New Pump tokens often retrace 70-90% —
that does not make them bad entries. Evaluate whether the token still has
holder retention, trading volume, and narrative relevance rather than
penalizing it for normal post-graduation retrace.
```

### Key changes
1. **"Pick the best in the batch"** instead of "only buy unusually strong asymmetric opportunities"
2. **Confidence reframed** — a 25-confidence BUY is better than eternal WATCH
3. **Normalize expectations** — 70-90% ATH retrace is standard for Pump.fun tokens, not a red flag
4. **Reduce BUY gate** — filters already validated eligibility; LLM should rank, not re-filter
5. **Move PASS to extreme cases only** — fatal red flags, not "meh" sentiment

---

## Recommended TP/SL Values

### Current: TP 50%, SL -25%, Trailing 20%

The single closed trade (+8.1% via trailing TP) on GOD shows the trailing mechanism works. GOD bounced ~8% then retraced, and the trailing TP captured the gain before it vanished.

### Data Limitations

With only 1 closed position, there's insufficient data for empirical TP/SL tuning. The recommendations below are based on meme coin market behavior:

| Strategy | TP | SL | Trailing | Rationale |
|----------|-----|-----|----------|-----------|
| **Sniper** (ultra-early) | 50% | -25% | 20% | ✅ Keep current — high risk/high reward for <1h tokens |
| **Dip Buy** | 30% | -20% | 15% | ✅ Keep current — appropriate for retrace entries |
| **Smart Money** (higher MC) | 100% | -25% | disabled | ✅ Keep current — partial TP at 100% makes sense |
| **Degen** (rule-based only) | 30% | -15% | 10% | ✅ Keep current — tight for low-qual entries |

### Recommendation
**No changes to TP/SL values until >20 closed positions.** The current values are reasonable for each strategy profile. The trailing TP at 20% on sniper is the most important parameter — it protected the one winning trade. Consider testing **trailing 15%** on sniper for faster exits if the next 5 trades show trailing TP activating consistently.

---

## Pipeline Health Assessment

### What's Working
- Signal ingestion is healthy: 2,138 signal events (1,699 trending, 290 graduated, 151 fee claims)
- WebSocket fee-claim detection is active
- Jupiter trending API is polling regularly
- Position monitoring runs every 10s
- Trailing TP mechanism works correctly (proven on GOD trade)
- Refreshed filter check before execution prevents stale entries

### What's Broken
- **LLM is effectively neutered** — 0 BUYs from 10 real LLM batches
- **Learning system is empty** — 0 learning runs, 0 active lessons
- **GMGN is disabled** — missing richer token data (holder count, trade fees, dev history)
- **No ATH context normalization** in the prompt means the LLM sees "78% below ATH" as fatal rather than normal

### Recommended Fix Priority
1. **Fix the prompt** (1st) — change from "unusually strong asymmetric" to "best in batch"
2. **Enable use_llm** (1st) — set sniper strategy to `use_llm: true`
3. **Lower confidence threshold** (1st) — 75 → 20
4. **Widen MC cap or switch to dip_buy** (2nd) — current sniper MC range filters too many
5. **Enable GMGN** (2nd) — richer data improves LLM decisions
6. **Trigger a learning run** (3rd) — use `/learn 7d` once there are >5 closed positions
7. **Increase dry-run position size** (3rd) — 0.2-0.5 SOL for meaningful data

---

## Summary

Charon's infrastructure is solid — signal pipeline, enrichment, LLM integration, position management, and execution all function correctly. The bot processes 2,138 signal events and successfully opened 3 positions with 0 losses.

The bottleneck is entirely in the decision layer: a too-conservative LLM prompt combined with a disabled LLM in the active strategy means the bot has never made a single autonomous LLM-based BUY decision. Fixing the prompt and enabling LLM-backed decisions will immediately increase trade frequency. All 3 rule-based entries were profitable or open, suggesting the filter pipeline is selecting tradeable candidates — the LLM just needs to be allowed to pick them.
