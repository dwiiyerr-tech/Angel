import assert from 'assert';
import { preScoreCandidate } from '../../src/pipeline/preScorer.js';
import { detectStateTransition } from '../../src/pipeline/stateTransition.js';

console.log('[test_hybrid_cos] Starting Hybrid (Baseline + CoS State Transition) Unit Tests...');

async function runHybridTests() {
  let passedCount = 0;

  // -------------------------------------------------------------
  // Test 1: Baseline Static Filter + CoS ABSORPTION Trigger
  // -------------------------------------------------------------
  {
    console.log('Testing Test 1: Baseline Quality + CoS ABSORPTION Boost...');
    
    const candidate = {
      token: { mint: 'HybridTestMint111111111111111111111111111' },
      metrics: {
        marketCapUsd: 80000,
        liquidityUsd: 25000,
        volumeUsd: 15000,
        holderCount: 450,
        priceUsd: 0.05
      },
      trending: {
        smart_degen_count: 8,
        organic_score: 75,
        bundler_rate: 0.05,
        net_buyers: 60
      },
      signals: { route: 'trending' }
    };

    const result = preScoreCandidate(candidate);
    assert(typeof result === 'object', 'PreScore result should be an object');
    assert(result.score >= 45, 'Strong Baseline + CoS ABSORPTION should yield high score >= 45');
    console.log(`  ✓ Test 1 Passed [Score: ${result.score}, Reasons: ${result.reasons.slice(0, 3).join('; ')}]`);
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 2: Baseline Quality BUT CoS DISTRIBUTION Penalty
  // -------------------------------------------------------------
  {
    console.log('Testing Test 2: Baseline Quality Penalty on CoS DISTRIBUTION...');

    const prevState = {
      liquidity: 30000,
      volume: 5000,
      net_buy: 100,
      wallet_quality: 5,
      price: 0.10,
      _observedAt: Date.now() - 120000,
    };

    const currentState = {
      liquidity: 20000, // Liquidity dropping (-10k)
      volume: 20000,    // Volume spiking
      net_buy: 20,      // Net buyers dropping (-80)
      wallet_quality: 2,
      price: 0.08
    };

    const cosResult = detectStateTransition(currentState, prevState);
    assert.strictEqual(cosResult.signal, 'DISTRIBUTION', 'Dropping net buyers & liquidity should trigger DISTRIBUTION');
    const tooRecent = detectStateTransition(currentState, { ...prevState, _observedAt: Date.now() });
    assert.strictEqual(tooRecent.signal, 'NO_STATE_CHANGE', 'Snapshots from the same instant must not create a transition');
    assert.strictEqual(tooRecent.ignored, true, 'Too-recent snapshots should report that they were ignored');
    console.log(`  ✓ Test 2 Passed [CoS Signal: ${cosResult.signal}, LADS Score: ${cosResult.lads_score}]`);
    passedCount++;
  }

  assert.strictEqual(passedCount, 2, 'All Hybrid tests must pass');
  console.log(`[test_hybrid_cos] SUCCESS: Passed all ${passedCount}/2 Hybrid Model tests.`);
}

runHybridTests().catch((err) => {
  console.error('[test_hybrid_cos] FAILED:', err);
  process.exit(1);
});
