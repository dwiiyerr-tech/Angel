import assert from 'assert';
import { validateLLMResponse } from '../../src/pipeline/llmValidator.js';
import { isRetryableLlmError } from '../../src/pipeline/llm.js';

const response = {
  verdict: 'BUY',
  confidence: 72,
  selected_candidate_id: 42,
  selected_mint: 'TestMint',
  thesis: ['1', '2', '3', '4', '5', '6', '7'],
  missing_confirmation: ['1', '2', '3', '4'],
  risks: Array.from({ length: 12 }, (_, index) => String(index)),
  suggested_tp_percent: 60,
  suggested_sl_percent: -30,
};

const result = validateLLMResponse(response);
assert.strictEqual(result.valid, true, 'Boundable LLM arrays must not invalidate the decision');
assert.strictEqual(result.data.verdict, 'BUY');
assert.strictEqual(result.data.thesis.length, 5);
assert.strictEqual(result.data.missing_confirmation.length, 3);
assert.strictEqual(result.data.risks.length, 10);
assert.strictEqual(isRetryableLlmError({ code: 'ECONNRESET', message: 'socket hang up' }), true);
assert.strictEqual(isRetryableLlmError({ response: { status: 429 } }), true);
assert.strictEqual(isRetryableLlmError({ response: { status: 400 }, message: 'bad request' }), false);

console.log('[test_llm_validator] SUCCESS: oversized explanatory arrays are bounded safely.');
