# Charon Audit — Execution, Signals, Enrichment, Learning, DB

Auditor: Claude Opus 4.8
Date: 2026-07-07
Scope: src/execution/router.js, src/liveExecutor.js, src/signals/*, src/enrichment/*, src/learning/autoApply.js, src/db/connection.js, src/db/positions.js, src/db/settings.js
Method: static read-through + call-graph tracing. No source modified. No code executed against live wallet.

---

## Summary of findings by severity

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| HIGH     | 4 |
| MEDIUM   | 6 |
| LOW      | 4 |

Headline: two of the CRITICALs let **real SOL leave the wallet without a corresponding tracked position**, and one lets Jupiter pick its own slippage on illiquid memecoins because the configured cap is never sent. The `autoApply` learning module is a loaded gun with the safety on — it silently rewrites strategy config, but currently has no live caller.

---

## CRITICAL

### C1 — Configured slippage cap is never sent to Jupiter (real-money exposure)
File: src/liveExecutor.js:6, :65-81, :106-126 ; src/config.js:24

`JUPITER_SLIPPAGE_BPS` (default 300 = 3%) is imported at liveExecutor.js:6 and defined at config.js:24, but it is **never referenced** in `jupiterOrder()` or anywhere the order URL is built. The `/order` request (lines 67-75) sets only inputMint/outputMint/amount/taker. No `slippageBps`, no `dynamicSlippage`, no max-slippage guard.

Why it matters: on the low-liquidity, high-volatility memecoins this bot targets, letting the aggregator apply its own default slippage means fills can execute far worse than intended with zero protection. The owner set a 3% cap and it is silently ignored on every live buy and sell. This is the single most dangerous gap for live trading.

Fix: pass `url.searchParams.set('slippageBps', String(JUPITER_SLIPPAGE_BPS))` (or the endpoint's documented slippage/dynamic-slippage param — verify against the Jupiter order API contract before wiring) on both the buy order and the sell path. Fail the swap if the quoted price impact exceeds the cap.

---

### C2 — Real swap executes BEFORE the dedup/guard check; on a dedup hit the purchased tokens are untracked (fund leak)
File: src/execution/router.js:32-98 ; src/db/positions.js:126-158

Order of operations in `executeLiveBuy`:
1. line 32 — `executeJupiterSwap(...)` actually spends SOL on-chain.
2. line 86 — only *then* `createLivePosition(...)` runs, and that function's transaction (positions.js:136-158) checks for an existing open position (`existing`), a recent-closed within 24h (`recentClosed`), or any past winning trade (`pastWin`). If any match, it returns `{ isNew: false }` **without inserting a new position row**.

Consequence: the buy already went through and tokens are in the wallet, but no new position is recorded. Line 98 (`if (isNew) await sendPositionOpen`) simply skips notification. The tokens are now orphaned — never monitored for TP/SL, never sold by `monitorPositions`. Real capital silently stuck.

The same pattern exists in `executeConfirmedIntent` (router.js:140-161) and the live path returns from orchestrator.js:384.

Why it matters: the dedup guards (24h re-entry block, past-win block) are the exact conditions most likely to fire on tokens the bot re-sees, and they fire *after* money is spent. Every dedup collision on the live path is a potential loss of the full position size.

Fix: run the dedup/guard check (an early read-only version of the `existing/recentClosed/pastWin` logic) **before** calling `executeJupiterSwap`. If it would be blocked, abort without swapping. Keep the in-transaction re-check as a backstop, but if it hits post-swap, treat it as an error state: record the orphaned tokens explicitly and alert, do not silently drop.

---

### C3 — `autoApply.js` rewrites strategy trading config with no approval gate (dormant but wired-capable)
File: src/learning/autoApply.js:199-286 (write at :263)

`autoApplyLessons()` parses free-text LLM "lessons" with regexes (extractRules, lines 9-197) and, for any rule above `minConfidence`, executes:
`db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(...)` at line 263 — directly mutating `sl_percent`, `min_mcap_usd`, `min_holders`, `llm_min_confidence`, etc. on the **active** strategy (strategyId resolved at line 183-184).

The owner's standing rule is: NO auto-modification of trading/filter/strategy config. This function violates that by design.

Current mitigation (why it's CRITICAL-dormant, not CRITICAL-live): the only reference to `autoApplyLessons` in the entire tree is its own definition. The former caller (`bin/charon-learn.sh`, still present in a stale search index) no longer exists on disk, and nothing in app.js, telegram/commands.js, learning/commands.js, package.json, or crontab invokes it. So today it does not run.

Why it still matters: it is one `import { autoApplyLessons }` + one cron line away from silently retuning live strategy parameters based on regex-scraped LLM prose. The parsing is fragile (e.g. the `tighten_sl` rule at :47 clamps to `min:-15, max:-12`, an inverted/odd band; mcap parsing at :68-89 averages arbitrary dollar figures found anywhere in the text). If ever re-enabled it will make real config changes off unreliable input.

Fix: gate every mutation behind explicit human confirmation (write a "proposed change" record + Telegram approve/reject button; only apply on approve). Until then, keep it unwired and add a guard comment. Do not delete quietly — flag to owner.

---

## HIGH

### H1 — TOCTOU race: concurrent triggers can exceed max_open_positions with real money
File: src/pipeline/orchestrator.js:29,189,384 ; src/execution/router.js:114 ; src/telegram/callbacks.js:97-105 ; src/db/positions.js:20-25

`canOpenMorePositions()` (positions.js:20) is a plain read of `openPositionCount()`. On the live path it is checked, then an `await executeJupiterSwap` happens, then the position is inserted. Signals arrive concurrently from multiple sources (pumpportal WS, trenches 60s, trending, graduated, priceMonitor 10s — all in app.js). Two different mints can both pass `canOpenMorePositions()` before either inserts its row, so both fire real swaps and both open — exceeding the configured cap. The per-mint dedup in `createLivePosition` does not catch this because the mints differ.

Why it matters: position count / total exposure limits are a core risk control; they are not enforced atomically on the money-spending path.

Fix: serialize live entries through a single in-process mutex/queue, and/or enforce the cap inside the same transaction that inserts the position (re-count within the `db.transaction` and abort if over limit) — but note the swap already happened, so the real fix is the mutex around check→swap→insert.

### H2 — Partial/ambiguous swap outcome is treated as total failure or total success, never reconciled
File: src/liveExecutor.js:106-126 ; src/execution/router.js:32-48, :140-147

`executeJupiterSwap` throws if it can't parse a signature (liveExecutor.js:116-118). If the transaction was actually submitted and landed but the execute response was malformed/timed out (30s axios timeout at :100), the code throws → router.js records `FAILED_ENTRY` (router.js:52-58) while tokens may in fact be in the wallet. Mirror problem to C2: no on-chain reconciliation (`fetchLiveTokenBalance`) is done on the failure branch, only on the success branch (router.js:38). `executeConfirmedIntent` (router.js:162-165) has the same blind catch.

Why it matters: network hiccups on execute confirmation produce "failed" records that don't match wallet reality — untracked tokens again, plus misleading audit trail.

Fix: on any swap error where a tx may have been submitted, query the token balance / signature status before deciding failed vs. filled, and record accordingly.

### H3 — Unbounded enrichment caches → memory growth in the long-running process
File: src/enrichment/gmgn.js:6,162,173,180 ; src/enrichment/jupiter.js:5,60,71

`gmgnCache` and `jupiterAssetCache` are `Map`s that only ever `.set()`, never evict (`grep` confirms no `.delete`/`.clear` on either). Every distinct mint the bot ever touches adds a permanent entry (gmgn stores even null results at :164/:180/:181). Over days/weeks of continuous operation on a firehose of new mints this grows without bound.

Why it matters: this process is meant to run 24/7. Steady unbounded Map growth is a slow leak that ends in an OOM/GC-thrash and a blind bot.

Fix: add TTL-based eviction (a periodic sweep like `pruneSeen`, or an LRU cap). The TTL is already tracked (`.at`), so a sweep dropping entries older than a few minutes is trivial.

### H4 — Backoff serves stale price to the dip-trigger logic
File: src/enrichment/jupiter.js:58-77 ; src/signals/priceMonitor.js:65-102

During a 429 backoff, `fetchJupiterAsset` returns `cached?.data` (jupiter.js:61) regardless of age (the TTL check is bypassed once in backoff). `monitorPriceAlerts` (priceMonitor.js:66-76) feeds that possibly-minutes-old price straight into the dip trigger comparison (`currentPrice <= alert.target_price_usd`). A stale low print can fire a buy that no longer reflects the market.

Why it matters: trades triggered on stale data during rate-limit windows — exactly when data is least trustworthy.

Fix: while in backoff, either skip the alert cycle or reject cache entries older than a hard freshness bound before using them for a trade decision.

---

## MEDIUM

### M1 — SQLite has WAL but no busy_timeout / no synchronous pragma
File: src/db/connection.js:6-7

Only `journal_mode = WAL` is set. No `busy_timeout`, no explicit `synchronous`. Within the single better-sqlite3 process writes are serialized, so intra-process contention is fine — but any external writer (e.g. a separate daily-report/learning script hitting the same file) can cause `SQLITE_BUSY` throws with no wait. WAL also benefits from `synchronous = NORMAL` for the durability/throughput tradeoff you likely want here.

Fix: `db.pragma('busy_timeout = 5000'); db.pragma('synchronous = NORMAL');` in initDb.

### M2 — Duplicate migrate events re-fire graduation (dedup not applied to migrate)
File: src/signals/pumpportal.js:307-348

The `migrate` branch sets `seenTokens` at :314 but never checks it, and comments (:312) explicitly rely on the orchestrator's downstream dedup. WS can redeliver the same migrate; each redelivery re-runs `graduateToken` → duplicate `storeSignalEvent` (:214) rows and a duplicate `candidateHandler` invocation. It leans entirely on a dedup layer outside this file.

Why it matters: signal_events double-counting skews the learning/PNL attribution, and duplicate candidate triggers add avoidable work.

Fix: add a short-window dedup on the migrate path (e.g. skip if this mint was graduated in the last N minutes via the `graduated` map or a `graduatedRecently` set).

### M3 — `executeLiveSell` has no retry and no slippage guard
File: src/execution/router.js:101-109

Buys get 3 attempts with backoff (router.js:30-49); the sell path is a single `executeJupiterSwap` call. A transient failure on exit leaves the position open past its intended TP/SL until the next monitor pass re-tries (behavior depends on positions.js, out of scope) — and it inherits C1 (no slippage cap) on the exit fill too.

Fix: mirror the retry loop for exits, and apply the slippage cap.

### M4 — `target_mcap_usd` alert path is dead
File: src/signals/priceMonitor.js:80-82 vs :17-31

`monitorPriceAlerts` checks `alert.target_mcap_usd` (:80), but `storePriceAlert` never inserts that column (the INSERT at :17-31 sets only target_price_usd and target_ath_distance_percent). So the mcap trigger branch can never fire. Either dead code or a missing feature.

Fix: either populate target_mcap_usd on insert or remove the dead branch to avoid false confidence that mcap triggers work.

### M5 — LLM-driven config band in autoApply is inverted/suspect
File: src/learning/autoApply.js:47

`tighten_sl` suggestion is `{ increaseBy: 3, min: -15, max: -12 }`. Combined with the increaseBy clamping at :253-254 this constrains sl to the narrow [-15,-12] band regardless of the current value. Given C3 keeps this dormant it's not live-harmful today, but if re-enabled the semantics are confusing and likely not what was intended.

Fix: revisit the band and document intended direction before any re-enable.

### M6 — Empty/loosely-swallowed catches hide DB failures on the trade path
File: src/signals/trenches.js:105 (`catch { /* proceed anyway */ }`) ; src/execution/router.js:162-165

trenches.js:91-105 swallows a DB error and then *proceeds to trigger a candidate anyway* — meaning the "already open / recently closed" guard silently no-ops on DB trouble, allowing a re-trigger. router.js:162 catches all intent-execution errors into a user message only, with the C2/H2 fund-tracking caveat.

Fix: on the trenches guard, fail closed (skip the trigger) if the guard query errors, rather than proceeding.

---

## LOW

### L1 — Variable shadowing of `cutoff`
File: src/signals/pumpportal.js:134 vs :143

Inner `const cutoff` at :143 shadows the outer at :134 inside `handleNewToken`. Harmless today but a readability/foot-gun.

### L2 — `outputAmount` can be an empty string stored as-is
File: src/liveExecutor.js:124 ; src/execution/router.js:37

`String(... || '')` yields `''` when all sources are missing; router.js:37 catches the falsy case and falls back to on-chain balance, so it self-heals — but an empty-string `token_amount_raw` can still land in the DB if the fallback also returns null. Minor data-quality issue.

### L3 — pumpportal `error` handler does not itself schedule reconnect
File: src/signals/pumpportal.js:382-396

Reconnect is scheduled only from the `close` handler. In normal `ws` behavior `error` is followed by `close`, so this is fine in practice, but relying on that ordering is fragile.

### L4 — Debug logging left on the hot WS path
File: src/signals/pumpportal.js:296-299

The `DEBUG txType=...` log fires for every non-create message. On a busy feed this is log spam and minor overhead; looks like leftover diagnostics.

---

## Notes / non-issues verified
- pumpportal WS: backoff, health alerts (once-per-outage), tracked-token cap (50) and TTL pruning are implemented correctly (pumpportal.js:45-52, 84-118, 151-166, 230-237).
- gmgn 429/403 handling with retry-after and per-kind backoff is sound (gmgn.js:93-136); the request queue (`enqueueGmgn`) correctly serializes and paces calls, matching the "Jupiter/GMGN share rate limit" reality.
- Position-monitor re-entrancy is guarded with `positionMonitorRunning` (app.js:91-100).
- Dry-run vs live divergence: both go through the same `createLivePosition`/`createDryRunPosition` dedup logic; the live-specific risk is the swap-before-guard ordering (C2/H1), not a logic fork in TP/SL.

## Top 3 to fix first
1. C1 — send the slippage cap on every live order (buy and sell).
2. C2/H1/H2 — restructure the live entry to guard→lock→swap→reconcile so money is never spent without a tracked position or an explicit orphan/alert record.
3. C3 — confirm `autoApply` stays unwired and add an approval gate before it can ever run again.
