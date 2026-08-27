import { initDb } from '../src/db/connection.js';
import { compareReplayPolicies } from '../src/learning/counterfactualReplay.js';
import { executableDecisionPaths } from '../src/decisionIntelligence/learning.js';

initDb();
const windowMs = 14 * 24 * 60 * 60 * 1000;
const paths = executableDecisionPaths({ sinceMs: Date.now() - windowMs, limit: 10000 });
const results = paths
  .map(path => ({ path, comparison: compareReplayPolicies(path.observations) }))
  .filter(item => item.comparison.deltaR != null);
const sum = key => results.reduce((total, item) => total + Number(item.comparison[key].exitR), 0);
const average = key => results.length ? sum(key) / results.length : null;
console.log(JSON.stringify({
  version: 'v32-v33-executable-counterfactual-v2', windowDays: 14, sample: results.length,
  methodology: 'decision-time Jupiter entry plus net executable exit quotes; discrete and gap-aware',
  verdictCoverage: Object.fromEntries(['BUY', 'WATCH', 'PASS'].map(verdict => [
    verdict, paths.filter(path => path.receipt.verdict === verdict).length,
  ])),
  v32ExpectancyR: average('v32'), v33ExpectancyR: average('v33'),
  deltaExpectancyR: results.length ? average('v33') - average('v32') : null,
  paths: results.map(item => ({
    receiptId: item.path.receipt.id,
    candidateId: item.path.receipt.candidate_id,
    mint: item.path.receipt.mint,
    verdict: item.path.receipt.verdict,
    ...item.comparison,
  })),
}, null, 2));
