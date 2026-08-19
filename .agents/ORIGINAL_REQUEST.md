# Original User Request

## 2026-08-09T08:13:54Z

Project Description: Audit the Charon codebase pipelines (prioritizing the new Edge filters and Tuning logic) for bugs, gaps, or logical errors. Fix any identified issues. Once stabilized, generate a Markdown report containing the core code for these features and send it via Telegram so the user can brainstorm with Claude.

Working directory: /root/Kaiser.charon
Integrity mode: development

## Requirements

### R1. Audit and Fix Code Pipelines
Perform static analysis on `src/pipeline/candidateBuilder.js` and `scripts/hyper_tune.js`. Identify any logical bugs, edge cases, or syntax errors specifically in the newly added Edge features (Twitter Sentiment, Smart Money Wallet Tracking, Sniper Protection) and the Hyper Parameter Tuning script. Apply fixes directly to the files.

### R2. Compile Logic into Markdown
Extract the final, fixed core logic of these Edge and Tuning features into a single Markdown file named `edge_tuning_logic.md`. The file should contain clear code blocks and brief explanations of what each block does.

### R3. Send via Telegram
Write a short script to send the contents of `edge_tuning_logic.md` to the user via the existing `src/telegram/send.js` utility. Ensure the script accounts for Telegram's maximum message length (4096 characters) by splitting the message into multiple parts if necessary.

## Acceptance Criteria

### Code Integrity
- [ ] Running `npm run check` in the workspace exits with code 0 (no syntax errors).

### Artifact Generation
- [ ] A file named `edge_tuning_logic.md` is successfully created in the workspace containing at least one JavaScript code block.

### Telegram Delivery
- [ ] A script `scripts/send_logic_to_tg.js` is created and can be executed without crashing.
- [ ] The script successfully splits strings larger than 4000 characters before calling `sendTelegram`.

## Follow-up — 2026-08-12T06:26:41Z

<USER_REQUEST>
Comprehensive E2E test verification, performance optimization, and adversarial edge hardening for the `engine.kc` Solana/BNB trading engine featuring the 10-stage Runner Scanner and Coinbiopsy Multi-Agent Decision Layer.

Working directory: `/root/engine.kc`
Integrity mode: development

## Requirements

### R1. Full E2E & Unit Verification Coverage
Execute and expand the test suite to verify 100% path coverage for candidate ingestion, signal deduplication, candidate builder enrichment, BNB/Solana runner scanning, and Coinbiopsy decision scoring without unhandled promise rejections or memory leaks.

### R2. Latency Optimization & Resource Efficiency
Ensure that the candidate decision pipeline processes candidate tokens under 300ms while strictly enforcing rate-limiting delays (`sleep(300ms)`) to prevent HTTP 429 errors on RPC, Jupiter, GMGN, and Rugcheck APIs. Convert unbounded in-memory caches to LRU/TTL bounded maps. Add concurrency control guards to all asynchronous polling loops in `src/app.js` and `src/signals/pumpportal.js`.

### R3. Adversarial Edge Case Hardening
Validate system behavior under extreme market conditions (sudden liquidity drains, wash trading spikes, missing audit metadata, and RPC timeout errors). Enforce 100% hard rejection of honeypots, mintable tokens, unburned LP, blacklists, proxy contracts, and `DISTRIBUTION_RISK` candidates.

## Acceptance Criteria

### Reliability & Test Coverage
- [ ] 100% of E2E and unit test cases pass cleanly (`node lint.cjs` and automated test suites execution).
- [ ] Zero unhandled promise rejections, memory leaks, or unhandled socket errors during execution.

### Performance & Security
- [ ] Candidate evaluation pipeline execution time remains under 300ms (hard max 500ms per token).
- [ ] Zero HTTP 429 rate limit errors triggered under high-volume signal ingestion bursts.
- [ ] Correct classification and hard rejection of all simulated `DISTRIBUTION_RISK` and `SECURITY` threat vectors.
</USER_REQUEST>
