# Handoff Report — Adversarial Threat Filtering & R3 Edge Case Hardening Survey

## 1. Observation

Direct code observations from codebase inspection of `/root/engine.kc`:

- **Candidate Builder (`src/pipeline/candidateBuilder.js`)**:
  - Line 57: Invokes `scanBnbRunnerCandidate(candidate)` and appends any failures from Stage 01-10.
  - Line 66: Invokes `detectSmartMoneyReaccumulation(candidate)`. Line 68: If `reacc.phase === 'DISTRIBUTION_RISK'`, appends failure `SMART_MONEY: Distribution Risk / Trap...`.
  - Lines 170–180: Checks `mcap < $50k` with `liquidityUsd < $3,000` or `isLpBurned === false`.
  - Lines 183, 188, 193: Enforces hard filters for `botHoldersPercentage >= 25%`, `holderCount` in deadzone `[100, 400]`, and `devMigrations >= 20`.
  - Lines 328–342: Flow filter hard rejects `stats1h.priceChange < 0%` or `netBuyerRatio < 0.2`.
  - Line 579: Enforces rate-limit delay `await sleep(300)` before candidate enrichment.

- **Universal Multi-Chain Runner Scanner (`src/pipeline/bnbRunnerScanner.js`)**:
  - Lines 36–65: **Stage 01 (UNIVERSE)** filters chain-specific Mcap ($50k–$2M BNB, $15k–$1.5M SOL), Liquidity ($25k BNB, $5k SOL), age, volume.
  - Lines 68–91: **Stage 02 (SECURITY GATE)** checks `isHoneypot`, tax > 5%, `isMintable` / `mintAuthorityRevoked === false`, `hasBlacklist` / `freezeAuthorityRevoked === false`, `canPause`, `isFeeMutable`, `isProxy`, `lpLocked`/`lpBurned`, `devMigrations >= 20`. Returns `NO_TRADE` immediately on any failure.
  - Lines 124–134: **Stage 04 (FLOW QUALITY)** checks `flow.is_wash_trading === true` and Sybil cluster patterns, returning `NO_TRADE`.

- **Coinbiopsy Re-Accumulation & Multi-Agent Layer (`src/pipeline/smartMoneyReaccumulation.js`)**:
  - Lines 106–126: Contrarian Agent evaluates Distribution Trap (`priceChange1h < -12%` & `volRatio5m < 0.7`), Vertical extension, Bot dominance >= 25%, Dev migrations >= 20.
  - Lines 137–139: If `riskScore >= 40`, phase set to `'DISTRIBUTION_RISK'`.

- **Pre-Scorer (`src/pipeline/preScorer.js`)**:
  - Lines 53–66: Detects wash trading / fake gas fee. If `volumeUsd > 20,000` & `feesSol < 0.1 SOL` -> **-100 penalty** (Instant Reject).
  - Lines 68–97: Measures state transition (`ABSORPTION` vs `DISTRIBUTION`).

- **Rugcheck Enrichment (`src/enrichment/rugcheck.js`)**:
  - Exists with `checkRugScore` and `isRugRisk`, but is **NOT** invoked inside `candidateBuilder.js`.

---

## 2. Logic Chain

1. **Rule Evaluation Flow**: Signal Ingestion -> Candidate Builder (`candidateBuilder.js`) -> Runner Scanner Stage 01-10 (`bnbRunnerScanner.js`) -> Coinbiopsy Multi-Agent Layer (`smartMoneyReaccumulation.js`) -> Pre-Scorer (`preScorer.js`) -> ML Momentum (`momentumFilter.js`) -> Pre-LLM Guard -> LLM Decision (`llm.js`).
2. **Security Filtering Mechanism**:
   - `bnbRunnerScanner.js` Stage 02 acts as a hard security gate for honeypots, mintable tokens, unburned LP, blacklists, proxy contracts, pausable contracts, and mutable fees.
   - `smartMoneyReaccumulation.js` identifies distribution traps and sets phase `'DISTRIBUTION_RISK'`, which `candidateBuilder.js` rejects immediately.
   - `preScorer.js` penalizes volume inflated without corresponding on-chain fee burn (-100 penalty).
3. **Resilience to Market Anomalies**:
   - Rate limiting enforced via `sleep(300)` in `candidateBuilder.js`, 2500ms pacing in `gmgn.js`, and 429 backoff handlers in `jupiter.js` & `gmgn.js`.
   - Disconnection handling in `pumpportal.js` alerts via Telegram when offline > 5 mins.
4. **Gap Reasoning**:
   - Security checks rely primarily on `candidate.security` or `jupiterAsset.audit`. If these fields are missing or undefined, checks like `sec.isHoneypot === true` evaluate to `false`, creating a potential vulnerability unless fallback checks (e.g. `rugcheck.js`) are integrated.
   - In-memory caches in `jupiter.js`, `rugcheck.js`, `orchestrator.js`, and `pumpportal.js` are currently standard `Map` instances without bound caps, presenting a risk of memory leaks under high-volume signal streams.

---

## 3. Caveats

- **No Live Execution Testing**: Investigation was strictly read-only analysis. Actual live network RPC latency under extreme mainnet congestions was not directly benchmarked via live RPC calls.
- **Rugcheck Integration Unused**: `src/enrichment/rugcheck.js` exists in the repo but is currently unlinked in `buildCandidate`.
- **Strategy Overrides**: Strategy configurations in `db/settings.js` can alter thresholds (e.g., `min_mcap_usd`, `min_liquidity_usd`).

---

## 4. Conclusion

The `engine.kc` codebase possesses a robust multi-layered security architecture (Pre-Scorer, 10-Stage Runner Scanner, Coinbiopsy Decision Layer) capable of detecting honeypots, mintable tokens, unburned LP, blacklists, proxy contracts, wash trading, and distribution traps. 

To achieve full **R3 (Adversarial Edge Case Hardening)** compliance:
1. Wire `rugcheck.js` directly into `buildCandidate` as a fallback security check when `jupiterAsset.audit` is missing or null.
2. Enforce strict hard rejection when audit metadata is completely unavailable on non-graduated candidates.
3. Replace unbounded JS `Map` caches with LRU/TTL bounded maps across `jupiter.js`, `rugcheck.js`, and `pumpportal.js`.
4. Preserve the 300ms pacing delay and rate-limit backoffs across all signal ingestion pathways.

---

## 5. Verification Method

To verify codebase integrity and findings:

1. **Lint Check**:
   ```bash
   node lint.cjs
   ```
2. **Ingestion Unit Tests**:
   ```bash
   node test/unit/test_candidate_ingestion.js
   ```
3. **File Inspection**:
   - View `src/pipeline/bnbRunnerScanner.js` (lines 68–91) for Stage 02 Security Gate checks.
   - View `src/pipeline/smartMoneyReaccumulation.js` (lines 106–139) for `DISTRIBUTION_RISK` detection.
   - View `src/pipeline/candidateBuilder.js` (lines 56–71 & 170–198) for candidate filter rules.
