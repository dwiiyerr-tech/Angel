import assert from 'assert';
import { filterCandidate } from '../../src/pipeline/candidateBuilder.js';

console.log('[test_m3_adversarial] Starting Milestone M3 Adversarial Edge Case Hardening Tests...');

async function runM3Tests() {
  let passedCount = 0;

  // -------------------------------------------------------------
  // Test 1 (Feature 12): Security Threat Vector Hard Rejection
  // -------------------------------------------------------------
  {
    console.log('Testing Feature 12: Security Threat Vector Hard Rejection...');
    
    // Threat A: Extreme serial rugger (moderate history is size-reduced)
    const serialRuggerCandidate = {
      token: { mint: 'SerialRuggerMint1111111111111111111111111' },
      metrics: { marketCapUsd: 60000, holderCount: 50 },
      jupiterAsset: { audit: { devMigrations: 120, botHoldersPercentage: 10 } },
      holders: { maxHolderPercent: 5 },
      savedWalletExposure: { holderCount: 0 }
    };
    const resA = filterCandidate(serialRuggerCandidate);
    assert.strictEqual(resA.passed, false, 'Serial rugger must be hard rejected');
    assert(resA.failures.some(f => f.includes('serial rugger extreme')), 'Failure reason should specify extreme serial rugger');

    // Threat B: Unburned Liquidity Drain (isLpBurned === false for low mcap)
    const unburnedCandidate = {
      token: { mint: 'UnburnedLpMint2222222222222222222222222222' },
      metrics: { marketCapUsd: 30000, holderCount: 50 },
      jupiterAsset: { liquidityUsd: 2000, audit: { lpBurned: false } },
      holders: { maxHolderPercent: 5 },
      savedWalletExposure: { holderCount: 0 }
    };
    const resB = filterCandidate(unburnedCandidate);
    assert.strictEqual(resB.passed, false, 'Unburned LP must be hard rejected');
    assert(resB.failures.some(f => f.includes('unburned') || f.includes('liquidity')), 'Failure reason should specify liquidity risk');

    console.log('  ✓ Feature 12 (Security Threat Vector Rejection) verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 2 (Feature 13): Trending top-tick remains ranking context
  // -------------------------------------------------------------
  {
    console.log('Testing Feature 13: Trending Top-Tick Risk Context...');
    
    const trapCandidate = {
      token: { mint: 'DistributionTrapMint3333333333333333333333' },
      metrics: { marketCapUsd: 80000, liquidityUsd: 15000, holderCount: 300 },
      signals: { route: 'trending' },
      trending: { volume: 10000, swaps: 20, rug_ratio: 0, bundler_rate: 0 },
      jupiterAsset: { stats1h: { priceChange: 150 }, audit: {} },
      holders: { maxHolderPercent: 5 },
      savedWalletExposure: { holderCount: 0 },
    };
    const result = filterCandidate(trapCandidate);
    assert(result.opportunityWarnings.some(warning => warning.includes('trending top-tick')));
    assert(!result.failures.some(failure => failure.includes('top-tick')));
    console.log('  ✓ Feature 13 (Trending Top-Tick Risk Context) verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 3 (Feature 14): Extreme Market Conditions & Audit Missing Handling
  // -------------------------------------------------------------
  {
    console.log('Testing Feature 14: Extreme Market Conditions & Missing Audit Data...');
    
    const freshGradNoAudit = {
      token: { mint: 'FreshGradNoAudit4444444444444444444444444' },
      metrics: { marketCapUsd: 40000, liquidityUsd: 8000, holderCount: 20 },
      signals: { route: 'pumpportal_graduated' },
      jupiterAsset: { audit: null },
      holders: { maxHolderPercent: 5 },
      savedWalletExposure: { holderCount: 0 }
    };

    const resAudit = filterCandidate(freshGradNoAudit);
    assert((freshGradNoAudit.riskFlags || []).some(r => r.type === 'missing_audit_data') || resAudit.failures.length > 0, 'Missing audit data should append soft risk flag or fail candidate');
    console.log('  ✓ Feature 14 (Extreme Conditions & Missing Audit Metadata) verified');
    passedCount++;
  }

  assert.strictEqual(passedCount, 3, 'All M3 tests must pass');
  console.log(`[test_m3_adversarial] SUCCESS: Passed all ${passedCount}/3 Milestone M3 tests.`);
}

runM3Tests().then(() => process.exit(0)).catch((err) => {
  console.error('[test_m3_adversarial] FAILED:', err);
  process.exit(1);
});
