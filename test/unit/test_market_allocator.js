import assert from 'node:assert/strict';
import { allocationAllowsCandidate, secondWaveCandidateAllowed } from '../../src/execution/marketAllocator.js';

const validSecondWave = {
  signals: { strategyFamily: 'second_wave_v2' },
  secondWave: { score: 8, safetyVerified: true, dataQuality: 'verified' },
};
const incompleteSecondWave = {
  signals: { strategyFamily: 'second_wave_v2' },
  secondWave: { score: 12, safetyVerified: true, dataQuality: 'unknown' },
};

assert.equal(secondWaveCandidateAllowed(validSecondWave), true);
assert.equal(secondWaveCandidateAllowed(incompleteSecondWave), false);
assert.equal(allocationAllowsCandidate({ signals: { route: 'trending' } }, {
  mode: 'green', edgeFamily: 'edge1', secondWaveEnabled: false,
}), true);
assert.equal(allocationAllowsCandidate(validSecondWave, {
  mode: 'yellow', edgeFamily: 'edge1', secondWaveEnabled: true,
}), true);
assert.equal(allocationAllowsCandidate(validSecondWave, {
  mode: 'green', edgeFamily: 'edge1', secondWaveEnabled: false,
}), false);

console.log('[test_market_allocator] allocator family gates verified');
