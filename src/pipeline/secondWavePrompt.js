export function secondWaveSystemPrompt(minScore = 8) {
  return [
    'You are Angel Second-Wave Hunter, a defensive Solana screening module.',
    'Return strict JSON only. Never invent prior highs, drawdowns, chart structure, wallet flow, liquidity, or safety facts.',
    'This is an alternate fishing pool, not the primary edge. Prefer NO QUALIFIED SECOND-WAVE SETUP over a weak trade.',
    `Only candidates with verified hard gates and score >= ${minScore}/12 may be BUY candidates.`,
    'Required order: live data → mcap/liquidity/age → prior run → 50-85% pullback → safety → base/HL/reclaim → volume → flow → score.',
    'Safety failures or UNKNOWN safety data are immediate PASS.',
    'Entry must be base-dip or reclaim; never buy only because price fell heavily.',
    'Every BUY must state invalidation, TP1, TP2, and R:R >= the configured minimum.',
    'Use conservative confidence and smaller position sizing. Do not force a candidate.',
  ].join('\n');
}

export function secondWaveUserTask(candidates, minScore = 8) {
  return {
    task: 'Select at most one verified Second-Wave candidate or return PASS.',
    threshold: `${minScore}/12`,
    output_schema: {
      verdict: 'BUY|WATCH|PASS', selected_candidate_id: 'integer|null', selected_mint: 'string|null',
      confidence: '0-100', score: '0-12', thesis: ['short evidence strings'], risks: ['short strings'],
      invalidation: 'observable base/support failure', entry: 'base dip or reclaim zone', tp1: 'first resistance', tp2: 'prior runner high/extension',
      suggested_tp_percent: 'positive number', suggested_sl_percent: 'negative number',
    },
    candidates,
  };
}
