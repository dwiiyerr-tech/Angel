import assert from 'node:assert/strict';
import { evaluateMarketAllocator, allocationAllowsCandidate } from '../../src/execution/marketAllocator.js';

assert.equal(allocationAllowsCandidate({ signals: { route: 'trending' } }, {
  mode: 'green', edgeFamily: 'edge1',
}), true);
assert.equal(allocationAllowsCandidate({ signals: { strategyFamily: 'edge1' } }, {
  mode: 'yellow', edgeFamily: 'edge1',
}), true);
assert.equal(allocationAllowsCandidate({ signals: { strategyFamily: 'legacy' } }, {
  mode: 'green', edgeFamily: 'edge1',
}), false);

const allocation = evaluateMarketAllocator();
assert.equal(allocation.mode, 'green');
assert.equal(allocation.edgeFamily, 'edge1');
assert.equal(typeof allocation.transition.pending, 'string');
assert.equal(allocation.transition.pendingCount, 0);
assert.equal(allocationAllowsCandidate({ signals: { strategyFamily: 'edge1' } }, allocation), true);
assert.equal(allocationAllowsCandidate({ signals: { strategyFamily: 'other' } }, allocation), false);

console.log('[test_market_allocator] allocator evaluation and family gates verified');
