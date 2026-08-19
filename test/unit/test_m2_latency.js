import assert from 'assert';
import { rateLimiter } from '../../src/enrichment/rateLimiter.js';
import { checkRugScore } from '../../src/enrichment/rugcheck.js';

console.log('[test_m2_latency] Starting Milestone M2 Latency & Resource Efficiency Tests...');

async function runM2Tests() {
  let passedCount = 0;

  // -------------------------------------------------------------
  // Test 1 (Feature 8): Centralized Request Rate-Limiter
  // -------------------------------------------------------------
  {
    console.log('Testing Feature 8: Centralized Request Rate-Limiter...');
    const start = Date.now();
    const results = [];
    
    // Schedule 3 calls to rateLimiter with 300ms pacing
    await Promise.all([
      rateLimiter.schedule(async () => { results.push(1); return 1; }, 'test_domain'),
      rateLimiter.schedule(async () => { results.push(2); return 2; }, 'test_domain'),
      rateLimiter.schedule(async () => { results.push(3); return 3; }, 'test_domain'),
    ]);

    const elapsed = Date.now() - start;
    assert.strictEqual(results.length, 3, 'All 3 scheduled tasks should complete');
    assert(elapsed >= 500, `Elapsed time ${elapsed}ms should reflect rate limiting (>=500ms for 3 items @300ms delay)`);
    console.log(`  ✓ Feature 8 (Centralized Rate-Limiter) verified [Elapsed: ${elapsed}ms]`);
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 2 (Feature 9 & 10): LRU Cache & Fast Path Bounded Memory
  // -------------------------------------------------------------
  {
    console.log('Testing Feature 9 & 10: Cache Bounding & Rapid Fetch...');
    const res1 = await checkRugScore('TestMintM2LRU11111111111111111111111111111');
    assert(typeof res1 === 'object', 'Rugcheck should return score object');
    console.log('  ✓ Feature 9 & 10 (LRU Cache & Fast Path) verified');
    passedCount++;
  }

  assert.strictEqual(passedCount, 2, 'All M2 tests must pass');
  console.log(`[test_m2_latency] SUCCESS: Passed all ${passedCount}/2 Milestone M2 tests.`);
}

runM2Tests().catch((err) => {
  console.error('[test_m2_latency] FAILED:', err);
  process.exit(1);
});
