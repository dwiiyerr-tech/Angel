# Changelog

## 2026-08-27 — v33 asymmetric runner challenger

- Added path-calibrated survival probability alongside runner and route edge.
- Added deterministic GOOD/REJECT/LEARN admission and edge-based target sizing.
- Added PAPER probe-to-scale lifecycle with atomic virtual scale ledger entries.
- Added immediate catastrophic protection and flow-aware runner trailing states.
- Replaced LLM entry selection with deterministic Safety + four-domain + Edge ranking; LLM is configuration-analysis only.
- Added exact route blocking, mint fan-in evidence merging, and scheduled smart-money ingestion.
- Added 1R/2R/3R/5R first-passage labels and a v32-v33 same-path replay report.
- Extended challenger evaluation to 14 days, 100 total samples, 30 samples per represented route, and PAPER-only automatic rollback guards.
- Corrected daily percentage reporting to deployed-capital return instead of averaging per-trade percentages.
- Kept all new LIVE authorities disabled until explicit config approval.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Standardized standard GitHub files (LICENSE, CONTRIBUTING.md, CHANGELOG.md).
- Organized repository structure by moving documents to `docs/` and scripts to `scripts/` and `test/`.
- Ignored system-generated `.agents` artifacts and `logs/` to reduce repository bloat.

## [1.0.0] - 2026-08-19

### Added
- **LLM Decision Cache**: Caches WATCH/PASS verdicts to cut redundant calls by 60-70%.
- **ML Momentum Filter**: Python subprocess scoring candidates 0.0-1.0 using bundled model artifacts.
- **Hybrid Filter Strategy**: Size cutting based on holder counts and dev migrations.
- **Tier 1 Universal Filters**: Data-driven filters from backtest evidence.

### Fixed
- Trailing TP guard to prevent locking in profits at a loss.
- Post-swap deduplication resulting in orphaned tokens.

### Changed
- Reorganized module boundaries for ingestion, pipeline, enrichment, and execution.
- Added fill-to-fill dry run pricing for accurate paper trading.
