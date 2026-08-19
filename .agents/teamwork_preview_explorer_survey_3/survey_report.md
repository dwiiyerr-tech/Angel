# Comprehensive Survey Report: Adversarial Threat Filtering, Risk Scoring & Edge Case Hardening (R3 Audit)

## Executive Summary
This report presents a comprehensive security and risk audit of the `engine.kc` Solana & BNB Chain algorithmic trading engine, focusing on **R3: Adversarial Edge Case Hardening**. The audit evaluated rule evaluation architectures, multi-chain threat vector detectors, market anomaly handling mechanisms, rate-limiting safeguards, and identified architectural gaps.

Key Evaluation Outcome:
- **Architecture Integrity**: The engine implements a tri-layer security defence comprising (1) Rule-based Pre-Scorer, (2) BNB & Solana 10-Stage Sequential Runner Scanner, and (3) Coinbiopsy Multi-Agent Decision Layer.
- **Threat Vector Enforcement**: Zero-tolerance rejection is active in Stage 02 (`bnbRunnerScanner.js`) and Coinbiopsy `DISTRIBUTION_RISK` (`smartMoneyReaccumulation.js` + `candidateBuilder.js`).
- **Critical Gaps Identified**: `rugcheck.js` module exists but is not invoked during `buildCandidate()`; audit missing fallback logic on fresh Solana tokens relies on soft flags rather than hard verification gates; unbounded Maps in enrichment modules pose memory leak risks.

---

## 1. Security & Risk Rule Evaluation Architecture

Security and risk rules are evaluated across three primary layers in `src/pipeline/`:

```
Incoming Signal (pumpfun, pumpportal, trending, fee_claim, etc.)
  │
  ▼
[1. Candidate Builder] (`src/pipeline/candidateBuilder.js`)
  ├─ Enforces rate-limit delay (300ms throttle)
  ├─ Invokes Stage 01-10 Runner Scanner (`bnbRunnerScanner.js`)
  ├─ Invokes Coinbiopsy Multi-Agent Layer (`smartMoneyReaccumulation.js`)
  ├─ Evaluates Hard Filters (Liquidity floor, LP burn, Bot % < 25%, Dev Migrations < 20, Holder Deadzone [100,400])
  └─ Evaluates Flow Filters & Route-Specific Thresholds
  │
  ▼
[2. Rule-Based Pre-Scorer] (`src/pipeline/preScorer.js`)
  ├─ Wash Trading & Fake Gas Fee Detector (Volume vs Fees ratio)
  └─ On-Chain Change of State (CoS) State Transition (ABSORPTION vs DISTRIBUTION)
  │
  ▼
[3. ML Momentum & LLM Decision Layer] (`src/pipeline/momentumFilter.js` & `src/pipeline/llm.js`)
  ├─ Pre-LLM Guard re-check
  └─ LLM CIO Evaluation with Insider Flow Defense rules
```

### Layer Details:

#### A. Candidate Builder (`src/pipeline/candidateBuilder.js`)
- **File & Line**: `src/pipeline/candidateBuilder.js`, lines 40–350 & 574–683.
- **Role**: Primary ingestion and orchestration filter. Aggregates data from Jupiter, GMGN, Twitter, and Wallet exposure, then runs static and dynamic risk rules.
- **Key Executions**:
  - `scanBnbRunnerCandidate(candidate)` (Line 57)
  - `detectSmartMoneyReaccumulation(candidate)` (Line 66)
  - Liquidity & LP Burn check for low mcap (< $50k) (Lines 170–180)
  - Tier 1 Hard Filters: Bot Holders >= 25% (Line 183), Holder Deadzone [100, 400] (Line 188), Dev Migrations >= 20 (Line 193).

#### B. Universal 10-Stage Runner Scanner (`src/pipeline/bnbRunnerScanner.js`)
- **File & Line**: `src/pipeline/bnbRunnerScanner.js`, lines 1–218.
- **Role**: Multi-chain (BNB & Solana) zero-tolerance filtering engine based on @magersih framework.
- **Stages Overview**:
  - **Stage 01 (UNIVERSE)**: MCap ($50k-$2M BNB, $15k-$1.5M SOL), Liquidity ($25k BNB, $5k SOL), Age, Volume.
  - **Stage 02 (SECURITY GATE)**: Zero-tolerance hard filters (Honeypot, Tax > 5%, Mintable, Blacklist/Freeze, Pause, Mutable Fee, Proxy, Unlocked LP, Serial Rugger).
  - **Stage 03 (HOLDER STRUCTURE)**: Top 10 > 45%, Single holder > 12%, Bot dominance >= 25% (NO_TRADE), Cluster score > 0.15.
  - **Stage 04 (FLOW QUALITY)**: Wash trading / Sybil / Jito bundler spam detection (`NO_TRADE`).
  - **Stage 05-07 (STRUCTURE, TECH, NARRATIVE)**: Chart pattern, VWAP/EMA alignment, vertical extension penalty.
  - **Stage 08-10 (DECISION & TRADE PLAN)**: Status (`TRADE`, `WATCHLIST`, `NO_TRADE`), R:R trade parameters.

#### C. Coinbiopsy Multi-Agent Layer (`src/pipeline/smartMoneyReaccumulation.js`)
- **File & Line**: `src/pipeline/smartMoneyReaccumulation.js`, lines 1–152.
- **Role**: Evaluates smart money accumulation vs distribution traps through 3 virtual agents:
  1. **Analyst Agent**: Net buyer ratio, volume absorption during consolidation, supply compression, Change of State (CoS).
  2. **Contextual Agent**: Social virality, trending rank placement.
  3. **Contrarian Agent (Devil's Advocate)**: Traps & fakeout flags (Distribution trap: `price1h < -12%` & `volRatio5m < 0.7`; Extension trap: `price1h > 60%`; Bot dominance >= 25%; Serial rugger devMigrations >= 20).
- **Synthesis Phase Output**: If `riskScore >= 40`, sets phase = `'DISTRIBUTION_RISK'`. In `candidateBuilder.js` (Line 68), `DISTRIBUTION_RISK` triggers an immediate candidate rejection.

#### D. Pre-Scorer (`src/pipeline/preScorer.js`)
- **File & Line**: `src/pipeline/preScorer.js`, lines 11–112.
- **Role**: Lightweight computation filter applied before ML / LLM stages.
- **Risk Scoring**: Evaluates fake gas fee / wash trading:
  - If `volumeUsd > 20,000` & `feesSol < 0.1 SOL` -> **-100 penalty** (Instant Reject).
  - If `volumeUsd > 50,000` & `volumeUsd / mcap > 10x` & `feesSol < 0.5 SOL` -> **-50 penalty**.

---

## 2. Threat Vector Detection & Rejection Matrix

| Threat Vector | Detection Source & Function | Rejection Logic & Threshold | Current Status & Gaps |
|---|---|---|---|
| **Honeypot (Sell Failure)** | `bnbRunnerScanner.js:72` (`sec.isHoneypot === true`) | `STAGE 02 (SECURITY)` failure -> `NO_TRADE` (Score = 0) | **Active in Scanner**. *Gap*: Relies on `candidate.security` / `jupiterAsset.audit`. `rugcheck.js` has independent check but is unlinked in `candidateBuilder.js`. |
| **Mintable Supply / Active Mint Auth** | `bnbRunnerScanner.js:74` (`sec.isMintable === true \|\| sec.mintAuthorityRevoked === false`) | `STAGE 02 (SECURITY)` failure -> `NO_TRADE` | **Active in Scanner**. |
| **Unburned LP / Removable Liquidity** | `candidateBuilder.js:177` & `bnbRunnerScanner.js:79` | `mcap < $50k` with `isLpBurned === false` -> Hard failure; Scanner Stage 02 `lpLocked === false && lpBurned === false` -> `NO_TRADE` | **Active in both Builder & Scanner**. |
| **Blacklist / Freeze Authority Active** | `bnbRunnerScanner.js:75` (`sec.hasBlacklist === true \|\| sec.freezeAuthorityRevoked === false`) | `STAGE 02 (SECURITY)` failure -> `NO_TRADE` | **Active in Scanner**. |
| **Proxy Contracts (Upgradable)** | `bnbRunnerScanner.js:78` (`sec.isProxy === true`) | `STAGE 02 (SECURITY)` failure -> `NO_TRADE` | **Active in Scanner**. |
| **`DISTRIBUTION_RISK` Trap** | `smartMoneyReaccumulation.js:138` & `candidateBuilder.js:68` | Coinbiopsy risk score >= 40 -> Phase `DISTRIBUTION_RISK` -> Builder failure added | **Active**. Rejects tokens dumped into high volume or with bot/serial-rugger traps. |
| **Wash Trading / Sybil / Jito Bundler** | `preScorer.js:58-66`, `candidateBuilder.js:278`, `bnbRunnerScanner.js:129` | Volume > $20k with <0.1 SOL fee -> -100 pre-score penalty; `trending.is_wash_trading` -> Failure; Scanner Stage 04 `isWash` -> `NO_TRADE` | **Active across multiple layers**. |
| **Bot Dominance Death Zone** | `candidateBuilder.js:183` & `bnbRunnerScanner.js:110` | `botHoldersPercentage >= 25%` -> Hard rejection | **Active**. |
| **Serial Rugger (Dev Migrations)** | `candidateBuilder.js:193` & `bnbRunnerScanner.js:82` | `devMigrations >= 20` -> Hard rejection | **Active**. |
| **Pausable / Mutable Fee Contracts** | `bnbRunnerScanner.js:76-77` (`canPause === true`, `isFeeMutable === true`) | `STAGE 02 (SECURITY)` failure -> `NO_TRADE` | **Active in Scanner**. |

---

## 3. Resilience Under Extreme Market Conditions

### A. Sudden Liquidity Drains & Dump Traps
- **Detection**:
  - `candidateBuilder.js` enforces a strict minimum liquidity floor of $5,000 (`min_liquidity_usd` setting) for all routes, and $3,000 hard floor for market caps under $50,000.
  - `bnbRunnerScanner.js` Stage 01 sets hard liquidity floors ($25,000 for BNB, $5,000 for Solana).
  - `smartMoneyReaccumulation.js` Contrarian Agent flags Distribution Traps (`priceChange1h < -12%` while selling volume dominates), driving phase to `DISTRIBUTION_RISK`.
  - `candidateBuilder.js` Flow Filter (Line 328) hard-rejects tokens where `stats1h.priceChange < 0%` or `netBuyerRatio < 0.2`.

### B. Wash Trading & Volume Manipulation Spikes
- **Detection**:
  - `preScorer.js` computes the ratio between reported volume and total fees collected on-chain. Fake volume inflated via wash trading without paying protocol gas/trade fees triggers a -100 score penalty.
  - `bnbRunnerScanner.js` Stage 04 explicitly checks `flow.is_wash_trading` and Sybil cluster patterns, returning `NO_TRADE` immediately.
  - `signals/trending.js` filters out wash trading tokens prior to signal dispatch.

### C. Missing Audit Metadata & Cold-Start Tokens
- **Current Behavior**:
  - For freshly graduated tokens (`pumpportal_graduated`), `candidateBuilder.js` checks if `jupiterAsset` is null or liquidity/holders are zero (Line 75). If so, it fails ingestion with `fresh grad insufficient data`.
  - When audit fields (`botHoldersPercentage` or `devMigrations`) are null on a fresh grad, `candidateBuilder.js` appends a soft risk flag (`missing_audit_data`, severity 2).
  - In `rugcheck.js`, if Rugcheck API returns an error or empty score data, `isRugRisk()` returns `true` (defensive default).
- **Identified Gap**: Missing audit metadata on non-fresh grad tokens could fall through if `jupiterAsset.audit` is undefined, defaulting boolean flags like `isHoneypot` to `undefined` (which evaluates `=== true` to `false`).

### D. RPC Timeout & API Rate Limit (HTTP 429) Handling
- **Protections Implemented**:
  - **Candidate Ingestion Pacing**: `candidateBuilder.js` executes `await sleep(300)` before fetching data to prevent overwhelming endpoints.
  - **GMGN Pacing & Backoff**: `src/enrichment/gmgn.js` includes `paceGmgnRequest()` (2500ms delay), single-promise queue, exponential backoff on HTTP 429 / Cloudflare challenges, and an 8000ms AbortController timeout.
  - **Jupiter Backoff**: `src/enrichment/jupiter.js` monitors `x-ratelimit-reset` headers and activates 30-second backoff periods upon HTTP 429.
  - **Rugcheck Isolation**: `src/enrichment/rugcheck.js` uses a 5000ms timeout and a 15-second cache. Errors return structured payload `{ error: true }` without crashing processes.
  - **WebSocket Health Monitor**: `src/signals/pumpportal.js` tracks connection uptime and last event timestamp. If disconnected for >5 minutes, it sends a Telegram alert and retries with exponential backoff (5s to 60s).

---

## 4. R3 Requirements & Constraints Summary

To satisfy **R3 (Adversarial Edge Case Hardening)** in full compliance with project acceptance criteria, the following mandatory features and technical constraints are defined:

1. **100% Zero-Tolerance Security Vector Rejection**:
   - Explicit verification that all Honeypots, Mintable tokens (active mint authority), Unburned LP / removable liquidity, Blacklisted / frozen accounts, Proxy (upgradable) contracts, Pausable contracts, and Mutable fee contracts are hard-rejected with zero bypass capability across ALL routes (Solana & BNB).
   - Ensure Rugcheck security verification is directly wired into `candidateBuilder.js` as an explicit guard alongside `jupiterAsset.audit`.

2. **Strict `DISTRIBUTION_RISK` and `SECURITY` Classification**:
   - Guarantee that Coinbiopsy `DISTRIBUTION_RISK` phase output and Runner Scanner Stage 02 `SECURITY` failures result in immediate candidate rejection prior to any LLM execution.

3. **Extreme Market Condition Handling**:
   - **Liquidity Drain Guard**: Hard reject any token suffering >30% liquidity removal in under 15 minutes or falling below minimum liquidity threshold ($5,000 SOL / $25,000 BNB).
   - **Wash Trading Guard**: Maintain multi-stage verification (fee-to-volume ratio penalty, `is_wash_trading` check).
   - **Missing Audit Metadata Safe-Fail**: If security audit data cannot be retrieved from either Jupiter or Rugcheck, treat security status as UNVERIFIED and apply safe-fail hard rejection or strict delayed re-check rather than proceeding to trade.
   - **RPC Timeout / Rate-Limit (429) Zero-Crash Guarantee**: Ensure all API calls use timeout controllers and rate-limit delays (`sleep(300ms)`), keeping candidate decision pipeline execution under 300ms (hard max 500ms per token) while preventing HTTP 429 errors.

4. **Resource & Memory Management**:
   - Convert unbounded Maps (`jupiterAssetCache`, `rugcheckCache`, `seenSignalCandidates`, `seenTokens`, `tokenCreatedAt`) into bounded LRU/TTL structures to prevent memory leaks during multi-day continuous runs.

---

## 5. Verification Method & Test Command

To independently verify R3 adversarial edge case hardening and code integrity:

1. **Syntax & Lint Verification**:
   ```bash
   node lint.cjs
   ```
   *Expected Output*: Exit code 0 with zero syntax errors.

2. **Unit Test Verification**:
   ```bash
   node test/unit/test_candidate_ingestion.js
   ```
   *Expected Output*: PASS on all ingestion routes without unhandled promise rejections.

3. **Security Threat Vector Test Harness Verification**:
   - Run candidate builder against test vectors with `isHoneypot: true`, `isMintable: true`, `lpBurned: false`, `isProxy: true`, `hasBlacklist: true`, and `reaccumulationResult.phase = 'DISTRIBUTION_RISK'`.
   - Verify `filterCandidate(candidate).passed === false` for 100% of threat vectors.

---
*Report compiled by teamwork_preview_explorer_survey_3 on 2026-08-12.*
