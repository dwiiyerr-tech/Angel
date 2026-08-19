# Orchestrator Execution Plan — engine.kc

## Mission
Comprehensive E2E test verification, performance optimization, and adversarial edge hardening for the `engine.kc` Solana/BNB trading engine featuring the 10-stage Runner Scanner and Coinbiopsy Multi-Agent Decision Layer.

## Phase 0: Survey & Assessment
- [ ] Dispatch 3 Explorers in parallel to analyze:
  - Explorer 1: Pipeline & Test Infrastructure (Candidate ingestion, signal deduplication, candidate builder enrichment, runner scanner, coinbiopsy scoring, `lint.cjs`, existing test coverage)
  - Explorer 2: Latency, Caching & Concurrency Bottlenecks (Evaluation pipeline timing, API rate-limiting sleep, unbounded in-memory caches, async polling loops in `src/app.js` and `src/signals/pumpportal.js`)
  - Explorer 3: Adversarial Risk Filtering & Security Hardening (Honeypot, mintable token, LP burn, blacklist, proxy contract, `DISTRIBUTION_RISK` and `SECURITY` threat rejection logic)
- [ ] Aggregate Explorer findings and synthesize `/root/engine.kc/PROJECT.md` containing Feature Inventory, Architecture, Milestones, Interface Contracts, and Code Layout.

## Phase 1: Dual Track Setup & Milestone Decomposition
- [ ] E2E Testing Track: Dispatch E2E Testing Orchestrator / Test Writer to construct/expand test harness (Tiers 1-4 coverage) and publish `TEST_READY.md`.
- [ ] Implementation Track: Finalize milestone decomposition in `PROJECT.md`:
  - Milestone 1: Core Pipeline & Test Suite Coverage Stabilization
  - Milestone 2: Latency Optimization, API Rate Limiting & LRU Bounded Caches
  - Milestone 3: Async Concurrency Control Guards & Exception/Resource Hardening
  - Milestone 4: Adversarial Threat Hardening & Coinbiopsy Security Rule Hardening
  - Milestone 5 (Final Milestone): Phase 1 (100% E2E test pass Tiers 1-4) & Phase 2 (Adversarial Coverage Hardening Tier 5)

## Phase 2: Milestone Execution & Verification Loop
For each milestone:
- [ ] Explorer strategy analysis & fix plan
- [ ] Worker implementation & test verification
- [ ] Dual Reviewer inspection (APPROVE check)
- [ ] Dual Challenger empirical verification
- [ ] Forensic Auditor (`teamwork_preview_auditor`) integrity check (Binary Veto)
- [ ] Gate status evaluation in `GATE_STATUS.md`

## Phase 3: Final Verification & Reporting
- [ ] Verify 100% E2E test pass across all tiers
- [ ] Verify clean execution of `node lint.cjs`
- [ ] Verify zero unhandled promise rejections / memory leaks
- [ ] Deliver final summary report to human user
