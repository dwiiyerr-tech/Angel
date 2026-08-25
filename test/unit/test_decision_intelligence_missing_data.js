import assert from 'node:assert/strict';
import { classifyDecisionOutcome } from '../../src/decisionIntelligence/runtime.js';

console.log('[test_decision_intelligence_missing_data] starting...');
assert.equal(classifyDecisionOutcome('PASS', { finalR: null, sampledMfeR: null }), 'INCOMPLETE');
assert.equal(classifyDecisionOutcome('WATCH', { finalR: undefined, sampledMfeR: 1 }), 'INCOMPLETE');
assert.equal(classifyDecisionOutcome('BUY', { finalR: '', sampledMfeR: 0 }), 'INCOMPLETE');
assert.equal(classifyDecisionOutcome('PASS', { finalR: 0, sampledMfeR: 0 }), 'TRUE_NEGATIVE');
console.log('[test_decision_intelligence_missing_data] SUCCESS');
