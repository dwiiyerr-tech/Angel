## 2026-08-12T14:28:38Z
You are teamwork_preview_explorer_survey_3.
Your working directory is `/root/engine.kc/.agents/teamwork_preview_explorer_survey_3`.

You MUST read the verbatim user request at:
`/root/engine.kc/ORIGINAL_REQUEST.md`

Objective:
Survey the `engine.kc` codebase specifically for adversarial threat filtering, risk scoring, security rule enforcement, and extreme market condition resilience.

Instructions:
1. Create your `progress.md` and `BRIEFING.md` in `/root/engine.kc/.agents/teamwork_preview_explorer_survey_3`.
2. Inspect the codebase at `/root/engine.kc` (especially risk filtering, security checks, honeypot detection, mintable token detection, LP burn verification, blacklist checking, proxy contract checks, `DISTRIBUTION_RISK` / `SECURITY` candidate rejection, market anomaly handling).
3. Document:
   - Where security and risk rules are evaluated (Coinbiopsy layer, runner scanner stages, candidate builder).
   - How honeypots, mintable tokens, unburned LP, blacklists, proxy contracts, `DISTRIBUTION_RISK`, and `SECURITY` threat vectors are currently detected/rejected or where gaps exist.
   - How system handles extreme market conditions (sudden liquidity drains, wash trading spikes, missing audit metadata, RPC timeout errors).
   - List all required features and constraints for R3 (Adversarial Edge Case Hardening).
4. Write your comprehensive survey report to `/root/engine.kc/.agents/teamwork_preview_explorer_survey_3/survey_report.md` and `handoff.md`.
5. Send a message to parent (ID: `0a0e9118-1b93-4ae8-b11a-0eafd5b006c6`) informing completion.
