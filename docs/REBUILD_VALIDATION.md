# Rebuild Validation Checklist

PR: #6

Before merge:

- [ ] Node lint passes
- [ ] Existing unit tests pass
- [ ] Research mode/policy tests pass
- [ ] Zero-capital research lifecycle integration test passes
- [ ] Python syntax checks pass
- [ ] No live Safety Kernel invariant is removed
- [ ] Research Telegram/card shows Capital = 0 SOL and Probe separately
- [ ] Research and live/shadow positions remain independently monitorable
- [ ] `main` remains unchanged until review/validation completes

If GitHub Actions is unavailable, this checklist must remain incomplete and the PR must stay draft until the same checks are run in a compatible Node 22 environment.
