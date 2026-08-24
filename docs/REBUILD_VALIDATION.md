# Rebuild Validation Checklist

PR: #6

Validated release code and tests before merge.

- [x] Node 22 lint passes
- [x] Existing unit tests pass
- [x] Research mode/policy tests pass
- [x] Zero-capital research lifecycle integration test passes
- [x] Research report smoke test passes
- [x] Python syntax checks pass
- [x] Clean install from committed lockfile passes
- [x] Dependency audit passes
- [x] Registry signature verification passes
- [x] No live Safety Kernel invariant is removed
- [x] Research Telegram/card shows Capital = 0 SOL and Probe separately
- [x] Research and live/shadow positions remain independently monitorable
- [x] Research capacity is isolated from execution capacity and async reservations are race-safe
- [x] SQLite enforces Research zero-capital / positive-probe / unsigned invariants
- [x] Manual Research buy cannot fall through to Shadow/Live executor
- [x] Manual Research refresh records R/MFE/MAE/realized-R
- [x] `main` remained unchanged throughout feature development and validation

CI evidence:

- Angel CI run `32766371257`: Node 22 lint + unit tests + Research report smoke test = success; Python syntax = success.
- Dependency Security CI run `32766371281`: clean lockfile install + lint/unit tests + dependency audit + registry signature verification = success.

Release rule remains unchanged: Research evidence does not automatically promote strategy changes into Live capital. Live promotion remains behind Shadow verification and the deterministic Safety Kernel.
