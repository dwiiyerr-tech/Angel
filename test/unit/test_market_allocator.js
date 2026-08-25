import assert from 'node:assert/strict';
import { allocationAllowsCandidate } from '../../src/execution/marketAllocator.js';

assert.equal(allocationAllowsCandidate({ signals: { route: 'trending' } }, {
  mode: 'green', edgeFamily: 'edge1',
}), true);
assert.equal(allocationAllowsCandidate({ signals: { strategyFamily: 'edge1' } }, {
  mode: 'yellow', edgeFamily: 'edge1',
}), true);
assert.equal(allocationAllowsCandidate({ signals: { strategyFamily: 'legacy' } }, {
  mode: 'green', edgeFamily: 'edge1',
}), false);

console.log('[test_market_allocator] allocator family gates verified');
