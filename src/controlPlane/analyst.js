import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { db } from '../db/connection.js';
import { strictJsonFromText } from '../utils.js';
import { buildStrategyEvidence } from './evidence.js';
import {
  activeConfigVersion,
  assertRegistryAligned,
  bootstrapConfigRegistry,
  canonicalJson,
  createStrategyProposal,
  openStrategyProposal,
  validateProposalChanges,
} from './registry.js';
import { ensureControlPlaneSchema } from './schema.js';

function parseBlockedRoutes(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function deterministicStrategyAnalysis(evidence, active) {
  if (!evidence.proposalEligible) {
    return {
      decision: 'HOLD',
      rationale: `Insufficient version-compatible evidence: ${evidence.totalClosed}/${evidence.minimumProposalTrades} closed observations.`,
      changes: [],
      mode: 'deterministic',
    };
  }

  const settings = active?.config?.settings || {};
  const blocked = new Set(parseBlockedRoutes(settings.blocked_routes));
  const routeRows = (evidence.research?.byRoute || []).filter(row => Number(row.count) >= 20);
  const changes = [];
  const best = routeRows[0];
  const worst = [...routeRows].sort((a, b) => Number(a.expectancyR || 0) - Number(b.expectancyR || 0))[0];

  if (worst && Number(worst.expectancyR) <= -0.25 && !blocked.has(worst.route)) {
    blocked.add(worst.route);
    changes.push({
      key: 'blocked_routes', value: [...blocked],
      rationale: `Route ${worst.route} has ${worst.count} Research outcomes with expectancy ${Number(worst.expectancyR).toFixed(2)}R.`,
      evidence: worst,
    });
  } else if (best && Number(best.expectancyR) >= 0.30 && Number(best.count) >= 30 && blocked.has(best.route)) {
    blocked.delete(best.route);
    changes.push({
      key: 'blocked_routes', value: [...blocked],
      rationale: `Route ${best.route} has ${best.count} Research outcomes with expectancy ${Number(best.expectancyR).toFixed(2)}R and may deserve Shadow re-admission.`,
      evidence: best,
    });
  }

  const expectancyR = Number(evidence.research?.expectancyR);
  const winRate = Number(evidence.research?.winRate);
  const sample = Number(evidence.research?.closed || 0);
  const currentConfidence = Number(settings.llm_min_confidence ?? 65);
  if (Number.isFinite(expectancyR) && sample >= 50) {
    if (expectancyR <= -0.20 && currentConfidence < 85) {
      changes.push({
        key: 'llm_min_confidence', value: Math.min(85, currentConfidence + 5),
        rationale: `Research expectancy is ${expectancyR.toFixed(2)}R across ${sample} trades; test a modest confidence increase.`,
        evidence: { expectancyR, winRate, sample },
      });
    } else if (expectancyR >= 0.30 && winRate >= 0.50 && currentConfidence > 45) {
      changes.push({
        key: 'llm_min_confidence', value: Math.max(45, currentConfidence - 5),
        rationale: `Research expectancy is ${expectancyR.toFixed(2)}R with ${(winRate * 100).toFixed(1)}% win rate; test slightly broader admission.`,
        evidence: { expectancyR, winRate, sample },
      });
    }
  }

  const currentFloor = Number(settings.min_opportunity_size_multiplier ?? 0.35);
  if (Number.isFinite(expectancyR) && sample >= 50) {
    if (expectancyR <= -0.30 && currentFloor < 0.60) {
      changes.push({
        key: 'min_opportunity_size_multiplier', value: Number(Math.min(0.60, currentFloor + 0.05).toFixed(2)),
        rationale: 'Negative Research expectancy supports testing a slightly stricter opportunity floor.',
        evidence: { expectancyR, sample },
      });
    } else if (expectancyR >= 0.40 && winRate >= 0.52 && currentFloor > 0.30) {
      changes.push({
        key: 'min_opportunity_size_multiplier', value: Number(Math.max(0.30, currentFloor - 0.05).toFixed(2)),
        rationale: 'Positive Research expectancy supports testing a slightly more permissive opportunity floor.',
        evidence: { expectancyR, winRate, sample },
      });
    }
  }

  let validated = [];
  try { validated = validateProposalChanges(changes.slice(0, 3)); } catch { validated = []; }
  return {
    decision: validated.length ? 'PROPOSE' : 'HOLD',
    rationale: validated.length
      ? 'Bounded evidence rules found a soft-policy challenger worth testing.'
      : 'No bounded soft-policy change is sufficiently supported by current evidence.',
    changes: validated,
    mode: 'deterministic',
  };
}

async function llmAnalysis(evidence, active, fallback) {
  if (!ENABLE_LLM || !LLM_API_KEY || !evidence.proposalEligible) return fallback;
  try {
    const response = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.05,
      messages: [
        {
          role: 'system',
          content: [
            'You are Angel Strategy Analyst. Return strict JSON only.',
            'You review supplied Research/Shadow evidence and may PROPOSE a bounded challenger or HOLD.',
            'Allowed keys only: llm_min_confidence, blocked_routes, min_opportunity_size_multiplier, min_liquidity_usd, flow_hard_price_change_pct, flow_hard_net_buyer_ratio, edge_min_quality_score, edge_min_survival_probability, edge_min_runner_probability, edge_min_expected_r, probe_entry_fraction, runner_weakening_buyer_ratio.',
            'Safety Kernel, wallet, exposure, slippage, contract-safety, circuit-breaker and position-size keys are protected.',
            'Never invent evidence. Prefer one or two small changes. Optimize expectancy and robustness, not win rate alone.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Produce a Shadow challenger only if the evidence justifies it.',
            active_config: { version: active.version, label: active.label, settings: active.config?.settings || {} },
            evidence,
            output_schema: {
              decision: 'PROPOSE | HOLD',
              rationale: 'evidence-grounded explanation',
              changes: [{ key: 'allowed key', value: 'new value', rationale: 'why', evidence: 'exact supplied evidence' }],
            },
          }),
        },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const parsed = strictJsonFromText(response.data?.choices?.[0]?.message?.content || '');
    if (String(parsed?.decision || '').toUpperCase() !== 'PROPOSE') {
      return { decision: 'HOLD', rationale: String(parsed?.rationale || 'LLM analyst recommended HOLD.').slice(0, 1000), changes: [], mode: 'llm', raw: parsed };
    }
    const validated = validateProposalChanges(Array.isArray(parsed?.changes) ? parsed.changes : []);
    if (!validated.length) return fallback;
    return { decision: 'PROPOSE', rationale: String(parsed?.rationale || '').slice(0, 1000), changes: validated.slice(0, 3), mode: 'llm', raw: parsed };
  } catch (error) {
    return { ...fallback, llmError: error.message };
  }
}

export async function runStrategyReview({ windowMs = 14 * 24 * 60 * 60 * 1000, source = 'manual', actor = 'strategy_analyst' } = {}) {
  ensureControlPlaneSchema();
  bootstrapConfigRegistry();
  const active = assertRegistryAligned();
  const evidence = buildStrategyEvidence(windowMs);
  const open = openStrategyProposal();
  if (open) return { status: 'open_proposal_exists', active, evidence, proposal: open };

  const fallback = deterministicStrategyAnalysis(evidence, active);
  const analysis = await llmAnalysis(evidence, active, fallback);
  let proposal = null;
  let status = evidence.proposalEligible ? 'hold' : 'insufficient';
  if (evidence.proposalEligible && analysis.decision === 'PROPOSE' && analysis.changes.length) {
    proposal = createStrategyProposal({
      changes: analysis.changes,
      evidence,
      analysis: { rationale: analysis.rationale, mode: analysis.mode },
      source,
      analystMode: analysis.mode,
      actor,
    });
    status = 'proposal_created';
  }

  const result = db.prepare(`
    INSERT INTO strategy_review_runs (
      created_at_ms, window_ms, status, active_config_version, evidence_json, analyst_json, proposal_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Date.now(), Number(windowMs), status, active.version, canonicalJson(evidence), canonicalJson(analysis), proposal?.proposalId ?? null);

  return {
    reviewRunId: Number(result.lastInsertRowid),
    status,
    active: activeConfigVersion(),
    evidence,
    analysis,
    proposal,
  };
}

export function latestStrategyReview() {
  ensureControlPlaneSchema();
  const row = db.prepare('SELECT * FROM strategy_review_runs ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  return { ...row, evidence: JSON.parse(row.evidence_json), analyst: JSON.parse(row.analyst_json) };
}
