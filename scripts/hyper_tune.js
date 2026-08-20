#!/usr/bin/env node
// Compatibility entrypoint. The old TP/SL scan used future high-water data and
// final exits, producing optimistic counterfactuals. Run the chronological,
// advisory-only admission-edge audit instead.
console.warn('[hyper-tune] legacy TP/SL high-water scan retired; running chronological holdout audit');
await import('./audit_dry_run_edge.mjs');
