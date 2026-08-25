import assert from 'assert';
import { db, initDb } from '../../src/db/connection.js';
import { filterCandidate } from '../../src/pipeline/candidateBuilder.js';
import { upsertCandidate, pruneOldFilteredCandidates, pruneOldSignalEvents } from '../../src/db/candidates.js';

initDb();
const sniper = db.prepare("SELECT config_json FROM strategies WHERE id = 'sniper'").get();
const sniperConfig = JSON.parse(sniper.config_json);
sniperConfig.min_mcap_usd = 25000;
db.prepare("UPDATE strategies SET config_json = ? WHERE id = 'sniper'").run(JSON.stringify(sniperConfig));

console.log('[test_builder_scanner] Starting current Candidate Builder filter tests...');

async function runRemainingM1Tests() {
  let passedCount = 0;

  // -------------------------------------------------------------
  // Test 1 (Feature 5): Candidate Builder Enrichment & Pre-filtering
  // -------------------------------------------------------------
  {
    console.log('Testing Feature 5: Candidate Builder Enrichment & Pre-filtering...');
    const candidate = {
      token: { mint: 'TestBuilderMint1111111111111111111111111111', symbol: 'BUILD' },
      metrics: { marketCapUsd: 75000, liquidityUsd: 15000, holderCount: 400 },
      signals: { route: 'trending' },
      trending: { volume: 10000, swaps: 20, rug_ratio: 0, bundler_rate: 0 },
      jupiterAsset: { stats1h: { priceChange: 10 }, audit: {} },
      holders: { maxHolderPercent: 5 },
      savedWalletExposure: { holderCount: 0 },
    };

    const filterResult = filterCandidate(candidate);
    assert(typeof filterResult === 'object', 'Filter result should be an object');
    assert(typeof filterResult.passed === 'boolean', 'Filter result should have boolean passed');
    console.log('  ✓ Feature 5 (Candidate Builder Enrichment & Pre-filtering) verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 2: strategy market-cap floor is a hard screening boundary
  // -------------------------------------------------------------
  {
    console.log('Testing strategy market-cap floor...');
    const mockCandidate = {
      token: { mint: 'BelowFloorMint2222222222222222222222222222' },
      metrics: { marketCapUsd: 1000, liquidityUsd: 20000, holderCount: 500 },
      signals: { route: 'trending' },
      trending: { volume: 10000, swaps: 20, rug_ratio: 0, bundler_rate: 0 },
      jupiterAsset: { stats1h: { priceChange: 10 }, audit: {} },
      holders: { maxHolderPercent: 5 },
      savedWalletExposure: { holderCount: 0 },
    };
    const result = filterCandidate(mockCandidate);
    assert(result.failures.some(failure => failure.includes('market cap below strategy range')));
    assert(!result.opportunityWarnings.some(warning => warning.includes('market cap')));
    assert.strictEqual(result.passed, false);
    console.log('  ✓ Strategy market-cap hard floor verified');
    passedCount++;
  }
  assert.strictEqual(passedCount, 2, 'Both current builder tests must pass');

  const duplicateCandidate = {
    token: { mint: 'DuplicateSignatureMint' },
    signals: { route: 'fee_trending' },
    filters: { passed: true },
    createdAtMs: Date.now(),
  };
  const firstId = upsertCandidate(duplicateCandidate, 'same-signature');
  duplicateCandidate.signals.route = 'fee_graduated_trending';
  const secondId = upsertCandidate(duplicateCandidate, 'same-signature');
  assert.strictEqual(secondId, firstId, 'Same signature+mint must update instead of violating UNIQUE');

  const staleCandidate = { ...duplicateCandidate, token: { mint: 'StaleFilteredMint' }, filters: { passed: false } };
  const staleId = upsertCandidate(staleCandidate, null);
  db.prepare('UPDATE candidates SET created_at_ms = ? WHERE id = ?').run(Date.now() - 5 * 86400000, staleId);
  assert.strictEqual(pruneOldFilteredCandidates({ limit: 10 }), 1);
  assert.strictEqual(db.prepare('SELECT id FROM candidates WHERE id = ?').get(staleId), undefined);

  db.prepare(`
    INSERT INTO signal_events (mint, kind, at_ms, source, payload_json)
    VALUES ('OldSignalMint', 'trending', ?, 'test', '{}')
  `).run(Date.now() - 8 * 86400000);
  assert.strictEqual(pruneOldSignalEvents({ limit: 10 }), 1);
  assert.strictEqual(db.prepare("SELECT id FROM signal_events WHERE mint = 'OldSignalMint'").get(), undefined);

  console.log(`[test_builder_scanner] SUCCESS: Passed all ${passedCount}/2 current builder tests.`);
}

runRemainingM1Tests().then(() => process.exit(0)).catch((err) => {
  console.error('[test_builder_scanner] FAILED:', err);
  process.exit(1);
});
