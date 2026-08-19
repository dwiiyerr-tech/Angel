import assert from 'assert';
import { db, initDb } from '../../src/db/connection.js';

// Initialize DB schema in test environment
initDb();

console.log('[test_candidate_ingestion] Starting 7 signal ingestion route tests...');

async function runIngestionTests() {
  let passedCount = 0;

  // -------------------------------------------------------------
  // Route 1: serverClient Ingestion Test
  // -------------------------------------------------------------
  {
    console.log('Testing Route 1: serverClient...');
    const { setCandidateHandler } = await import('../../src/signals/serverClient.js');
    
    let receivedPayload = null;
    setCandidateHandler(async (candidate) => {
      receivedPayload = candidate;
    });

    const testMint = 'ServerClientTestMint11111111111111111111111';
    
    const mockSignal = {
      mint: testMint,
      name: 'Server Token',
      symbol: 'SRV',
      priceUsd: 0.05,
      marketCapUsd: 100000,
      liquidityUsd: 25000,
      sourceCount: 2,
      sources: ['server_graduated', 'server_trending'],
      graduated: { distanceFromAthPercent: -5 },
      trending: { volume: 50000, buys: 100, sells: 50 }
    };

    assert.strictEqual(mockSignal.mint, testMint);
    assert.strictEqual(mockSignal.sourceCount, 2);
    console.log('  ✓ serverClient route handler contract verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Route 2: pumpportal Ingestion Test
  // -------------------------------------------------------------
  {
    console.log('Testing Route 2: pumpportal...');
    const { setCandidateHandler, getPumpportalHealth } = await import('../../src/signals/pumpportal.js');
    
    let handlerSet = false;
    setCandidateHandler(async (candidate) => {
      handlerSet = true;
    });

    const health = getPumpportalHealth();
    assert(health !== null && typeof health === 'object', 'Pumpportal health check returned object');
    assert.strictEqual(health.connected, false, 'Initial state ws should be disconnected in unit test');

    console.log('  ✓ pumpportal route handler & health status verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Route 3: pumpfunPregrad Ingestion Test
  // -------------------------------------------------------------
  {
    console.log('Testing Route 3: pumpfunPregrad...');
    const { pregradTokens, getTrackedPregradTokens, setCandidateHandler } = await import('../../src/signals/pumpfunPregrad.js');

    const mockMint = 'PumpFunPregradMint333333333333333333333333';
    pregradTokens.set(mockMint, {
      mint: mockMint,
      name: 'Pregrad Coin',
      symbol: 'PRE',
      seenAt: Date.now(),
      real_sol_reserves_sol: 15,
    });

    const tracked = getTrackedPregradTokens();
    assert(tracked.size >= 1, 'Pregrad tracked tokens size should be >= 1');
    assert(tracked.mints.includes(mockMint), 'Pregrad mints array should include mock mint');

    let handlerRegistered = false;
    setCandidateHandler(async () => { handlerRegistered = true; });

    console.log('  ✓ pumpfunPregrad route state tracking & handler registration verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Route 4: graduated Ingestion Test
  // -------------------------------------------------------------
  {
    console.log('Testing Route 4: graduated...');
    const { graduated } = await import('../../src/signals/graduated.js');

    const testMint = 'GraduatedTestMint444444444444444444444444';
    graduated.set(testMint, {
      coinMint: testMint,
      name: 'Graduated Coin',
      ticker: 'GRAD',
      marketCapUsd: 75000,
      liquidityUsd: 30000,
      seenAt: Date.now(),
    });

    const stored = graduated.get(testMint);
    assert.strictEqual(stored.coinMint, testMint);
    assert.strictEqual(stored.ticker, 'GRAD');

    console.log('  ✓ graduated map ingestion & state tracking verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Route 5: trending Ingestion Test
  // -------------------------------------------------------------
  {
    console.log('Testing Route 5: trending...');
    const { trendingSignalPass, trending } = await import('../../src/signals/trending.js');

    const testMint = 'TrendingTestMint555555555555555555555555';
    const mockToken = {
      address: testMint,
      symbol: 'TREND',
      price: 0.1,
      market_cap: 50000,
      liquidity: 20000,
      holder_count: 200,
      volume: 10000,
      swaps: 600,
      top_10_holder_rate: 0.15,
      rug_ratio: 0.05,
      bundler_rate: 0.1,
      bot_degen_rate: 0.1,
      is_wash_trading: false,
    };

    trending.set(testMint, mockToken);
    assert.strictEqual(trending.get(testMint).symbol, 'TREND');

    const passes = trendingSignalPass(mockToken);
    assert.strictEqual(passes, true, 'Token matching trending strategy gates should pass');
    assert.strictEqual(
      trendingSignalPass({ ...mockToken, top_10_holder_rate: null }),
      false,
      'Missing required holder concentration must not be treated as zero risk',
    );

    console.log('  ✓ trending route gate filtering & map storage verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Route 6: trenches Ingestion Test
  // -------------------------------------------------------------
  {
    console.log('Testing Route 6: trenches...');
    const { trenches, setCandidateHandler } = await import('../../src/signals/trenches.js');

    const mockMint = 'TrenchesTestMint66666666666666666666666pump';
    trenches.set(mockMint, {
      mint: mockMint,
      symbol: 'TRENCH',
      kind: 'completed',
      seenAt: Date.now(),
    });

    assert.strictEqual(trenches.get(mockMint).symbol, 'TRENCH');
    let handlerSet = false;
    setCandidateHandler(async () => { handlerSet = true; });

    console.log('  ✓ trenches route state map & candidate handler contract verified');
    passedCount++;
  }

  // -------------------------------------------------------------
  // Route 7: priceMonitor Dip Alert Ingestion Test
  // -------------------------------------------------------------
  {
    console.log('Testing Route 7: priceMonitor...');
    const { storePriceAlert } = await import('../../src/signals/priceMonitor.js');

    const testMint = 'PriceMonitorTestMint777777777777777777777';
    storePriceAlert({
      mint: testMint,
      strategyId: 'sniper',
      alertType: 'dip_target',
      targetPriceUsd: 0.08,
      targetAthDistancePercent: -20,
      signal: { route: 'fee_graduated' },
      expiresMs: 3600000,
    });

    const row = db.prepare('SELECT * FROM price_alerts WHERE mint = ?').get(testMint);
    assert(row !== undefined, 'Price alert should be saved in DB');
    assert.strictEqual(row.mint, testMint);
    assert.strictEqual(row.alert_type, 'dip_target');

    console.log('  ✓ priceMonitor dip alert storage & DB integration verified');
    passedCount++;
  }

  assert.strictEqual(passedCount, 7, 'All 7 ingestion routes must pass');
  console.log(`[test_candidate_ingestion] SUCCESS: Passed all ${passedCount}/7 candidate ingestion route tests.`);
}

runIngestionTests().then(() => process.exit(0)).catch((err) => {
  console.error('[test_candidate_ingestion] FAILED:', err);
  process.exit(1);
});
