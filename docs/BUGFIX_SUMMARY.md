# Charon LLM Layer Bug Fixes — Implementation Summary

**Date:** 2026-06-30  
**Scope:** 4 critical efficiency + visibility bugs  
**Estimated Impact:** -64% LLM cost, +35% trade visibility, eliminate rate limit errors

---

## 🐛 Bugs Fixed

### BUG #1: 91% Wasted LLM Calls (19,559 / 21,413)
**Problem:** Same tokens evaluated 200+ times with WATCH/PASS verdict, no caching.  
**Root Cause:** No decision cache → repeated LLM calls for tokens that haven't changed.

**Fix:** Decision cache with smart invalidation
- **Location:** `src/db/decisions.js` + `src/pipeline/orchestrator.js`
- **Implementation:**
  - New table `decision_cache` (mint, verdict, expires_at_ms, mcap/holders snapshots)
  - Cache WATCH (10min TTL) and PASS (60min TTL) decisions
  - Invalidate if mcap changes >20% OR holders change >30%
  - Check cache BEFORE `buildCandidate()` (line 88) to skip API calls
- **Impact:** Cuts ~60-70% LLM calls, eliminates rate limit 412/429/402 errors

---

### BUG #2: 488 Post-LLM Filter Rejections
**Problem:** LLM called, verdict BUY, then `entry_rejected_fresh_filters` blocks it.  
**Root Cause:** Fresh filter check happens AFTER LLM call (line 235), wasting tokens.

**Fix:** Pre-LLM filter guard
- **Location:** `src/pipeline/orchestrator.js` line 129-135
- **Implementation:**
  - Re-run `filterCandidate()` after preScore, before LLM batch
  - Skip LLM call if filters fail (stale data / condition changed)
- **Impact:** Saves 488 wasted LLM calls per 30 days

---

### BUG #3: 340 Missing Positions (35% Execution Failures)
**Problem:** 981 `dry_run_entry` logged, only 641 positions created → 340 lost.  
**Root Cause:** `createDryRunPosition()` failures not caught, no error logging.

**Fix:** Execution failure logging
- **Location:** `src/pipeline/orchestrator.js` line 270-303
- **Implementation:**
  - Wrap `createDryRunPosition()` in try-catch
  - New action `dry_run_position_create_failed` with error stack
  - Send Telegram alert on failure
- **Impact:** Full visibility into 340 lost trades, can debug root cause

---

### BUG #4: 277 Past-Win Blocks Without Context
**Problem:** `dry_run_blocked_past_win` logs exist but missing audit trail:
- Was the past trade profitable because of luck or skill?
- Would re-entry have been profitable?
- What was exit reason / hold duration?

**Fix:** Enhanced past-win audit logging
- **Location:** `src/pipeline/orchestrator.js` line 306-331
- **Implementation:**
  - Fetch past position details (exit_reason, hold_duration, entry_mcap, pnl_percent)
  - Add `wouldHaveBeenProfit` flag (current mcap > past entry mcap)
  - Store in `guardrails` field of decision_logs
- **Impact:** Can audit whether past-win guard is blocking opportunities

---

## 📁 Files Modified

```
migrations/001_decision_cache.sql         (new)
src/db/decisions.js                       (+58 lines)
src/pipeline/orchestrator.js              (+87 lines)
```

### Migration Applied
```bash
cd /home/ubuntu/projects/charon
sqlite3 charon.sqlite < migrations/001_decision_cache.sql
```

✅ Table `decision_cache` created with indexes on `expires_at_ms` and `(mint, expires_at_ms)`.

---

## 🎯 Expected Outcomes (Next 30 Days)

| Metric | Before | After (Est.) | Improvement |
|---|---:|---:|---|
| LLM calls / day | ~700 | ~250 | **-64%** |
| LLM cost / day | $X | ~$0.36X | **-64%** |
| Rate limit errors | frequent | near zero | **eliminated** |
| Lost trades | 340 (35%) | 0 with logs | **full visibility** |
| Wasted BUY verdicts | 488 | <50 | **-90%** |

---

## 🔍 Verification Steps

1. **Check cache is working:**
   ```bash
   sqlite3 charon.sqlite "SELECT COUNT(*), verdict FROM decision_cache GROUP BY verdict"
   ```
   Expect to see WATCH/PASS entries accumulating.

2. **Monitor logs for cache hits:**
   ```bash
   tail -f charon.log | grep cache-hit
   ```
   Expect: `[cache-hit] <mint> — verdict WATCH (cached 3.2m ago...)`

3. **Check execution failure logging:**
   ```bash
   sqlite3 charon.sqlite "SELECT COUNT(*) FROM decision_logs WHERE action='dry_run_position_create_failed'"
   ```
   If >0, investigate error messages.

4. **Audit past-win blocks:**
   ```bash
   sqlite3 charon.sqlite "
   SELECT json_extract(guardrails_json, '$.wouldHaveBeenProfit') as profit_opp, COUNT(*) 
   FROM decision_logs 
   WHERE action='dry_run_blocked_past_win' 
   GROUP BY profit_opp
   "
   ```
   This shows how many blocked re-entries would have been profitable.

---

## ⚠️ Known Limitations

1. **Cache doesn't handle multi-route spam perfectly** — if token arrives via 3 different routes within 1 second, all 3 might buildCandidate() before first one caches. This is acceptable (rare edge case, still better than 200x eval).

2. **Pre-LLM guard may over-block in high-volatility conditions** — if mcap swings 30% in 10 seconds, candidate might pass first filter, fail pre-LLM guard. This is DESIRED behavior (stale data should be skipped).

3. **Execution failure logging doesn't FIX the failures** — it only makes them visible. Next step: analyze `dry_run_position_create_failed` logs to find actual bug (swap simulation? DB constraint?).

4. **Past-win guard still blocks re-entry** — this fix only adds audit trail. To CHANGE behavior (allow re-entry after X hours), modify `createDryRunPosition()` logic separately.

---

## 🚀 Next Steps (Optional Enhancements)

1. **Add cache prune cron job** (call `pruneExpiredCache()` every 1 hour)
2. **Add cache hit/miss metrics** to daily report
3. **Tune cache TTL** based on observed hit rate (10min may be too short for slow-moving tokens)
4. **Implement "block worst hours" filter** from Task #5 (jam 11-14, 20, 22 UTC)
5. **Add soft-flag composite filter** (bot ≥25%, holders 100-400, dev_mig ≥20)

---

## 📞 Support

If any of these fixes cause unexpected behavior:
1. Check `charon.log` for new error patterns
2. Query `decision_logs` for action distribution
3. Verify `decision_cache` table exists and has indexes
4. Rollback by commenting out cache check (line 88-94 in orchestrator.js)
