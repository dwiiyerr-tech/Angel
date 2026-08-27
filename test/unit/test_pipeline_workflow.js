import assert from 'node:assert/strict';
import {
  SOLANA_TRENCHING_WORKFLOW,
  SOLANA_TRENCHING_WORKFLOW_STAGES,
  SOLANA_TRENCHING_WORKFLOW_VERSION,
  attachPipelineContract,
} from '../../src/pipeline/workflow.js';

const expected = [
  'Signals',
  'Enrichment',
  'Contract Safety',
  'PreScore/CoS',
  'Momentum ML',
  'Runner Probability',
  'Route P(win)/Expected R',
  '9D Needle Score',
  'Candidate Ranking',
  'LLM Best-Candidate Selection',
  'Market Allocator',
  'Fresh Execution Recheck',
  'PAPER/LIVE',
];

assert.deepEqual([...SOLANA_TRENCHING_WORKFLOW_STAGES], expected);
assert.equal(SOLANA_TRENCHING_WORKFLOW, expected.join(' → '));
assert.equal(SOLANA_TRENCHING_WORKFLOW_VERSION, 'solana-trenching-workflow-v2');

const candidate = { token: { mint: 'Workflow111111111111111111111111111111111' } };
const contract = attachPipelineContract(candidate, '9D Needle Score');
assert.equal(contract.version, SOLANA_TRENCHING_WORKFLOW_VERSION);
assert.equal(contract.workflow, SOLANA_TRENCHING_WORKFLOW);
assert.equal(contract.reachedStage, '9D Needle Score');
assert.equal(candidate.filters.pipelineWorkflowVersion, SOLANA_TRENCHING_WORKFLOW_VERSION);
assert.equal(candidate.filters.pipelineReachedStage, '9D Needle Score');

console.log(`[pipeline-workflow] ${SOLANA_TRENCHING_WORKFLOW}`);
