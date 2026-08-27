export const SOLANA_TRENCHING_WORKFLOW_VERSION = 'solana-trenching-workflow-v2';

export const SOLANA_TRENCHING_WORKFLOW_STAGES = Object.freeze([
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
]);

export const SOLANA_TRENCHING_WORKFLOW = SOLANA_TRENCHING_WORKFLOW_STAGES.join(' → ');

export function attachPipelineContract(candidate = {}, reachedStage = '9D Needle Score') {
  candidate.pipeline = {
    version: SOLANA_TRENCHING_WORKFLOW_VERSION,
    workflow: SOLANA_TRENCHING_WORKFLOW,
    reachedStage,
  };
  candidate.filters = candidate.filters || {};
  candidate.filters.pipelineWorkflowVersion = SOLANA_TRENCHING_WORKFLOW_VERSION;
  candidate.filters.pipelineReachedStage = reachedStage;
  return candidate.pipeline;
}
