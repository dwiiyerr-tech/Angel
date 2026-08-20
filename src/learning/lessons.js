import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, json, stripThinking, strictJsonFromText } from '../utils.js';
import { fmtPct } from '../format.js';
import { db } from '../db/connection.js';

function fallbackLessons(summary) {
  const lessons = [];
  const bestRoute = summary.positions.byRoute?.[0];
  const worstRoute = [...(summary.positions.byRoute || [])].sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
  if (bestRoute && bestRoute.count >= 2 && bestRoute.pnlPercent > 0) {
    lessons.push({
      scope: bestRoute.route,
      lesson: `Route ${bestRoute.route} outperformed in this evidence window.`,
      instruction: `Prefer ${bestRoute.route} only when the candidate also passes liquidity, concentration, and fresh-entry checks.`,
      confidence: bestRoute.count >= 30 ? 'medium' : 'low',
      evidence: { ...bestRoute, recommended_actions: [] },
    });
  }
  if (worstRoute && worstRoute.count >= 2 && worstRoute.pnlPercent < 0) {
    lessons.push({
      scope: worstRoute.route,
      lesson: `Route ${worstRoute.route} underperformed in this evidence window.`,
      instruction: `Require corroborating liquidity, buyer-flow, and concentration evidence before BUY on ${worstRoute.route}; otherwise downgrade to WATCH.`,
      confidence: worstRoute.count >= 30 ? 'medium' : 'low',
      evidence: { ...worstRoute, recommended_actions: [] },
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      scope: 'global',
      lesson: 'Recent worst exits clustered around stop-loss exits.',
      instruction: 'Require stronger fresh liquidity and entry-quality confirmation when several independent risk signals indicate a late entry.',
      confidence: slCount >= 5 ? 'medium' : 'low',
      evidence: { slWorstCount: slCount, worst: summary.positions.worst, recommended_actions: [] },
    });
  }
  // Performance-based auto-adjustments
  const winRate = (summary.positions.closed > 0) ? (summary.positions.wins / summary.positions.closed) * 100 : 0;
  const avgPnl = summary.positions.avgPnlPercent || 0;
  if (winRate < 35 && summary.positions.closed >= 10) {
    lessons.push({
      scope: 'global',
      lesson: `Observed win rate was ${winRate.toFixed(1)}% across ${summary.positions.closed} version-compatible trades.`,
      instruction: 'Do not treat LLM confidence alone as BUY evidence; require independent liquidity, holder-quality, and buyer-flow confirmation.',
      confidence: summary.positions.closed >= 50 ? 'medium' : 'low',
      evidence: { winRate, avgPnl, closed: summary.positions.closed, recommended_actions: [] },
    });
  }
  if (avgPnl < -5 && summary.positions.closed >= 10) {
    lessons.push({
      scope: 'global',
      lesson: `Observed average PnL was ${avgPnl.toFixed(1)}% across ${summary.positions.closed} version-compatible trades.`,
      instruction: 'Downgrade marginal setups to WATCH when downside evidence is stronger than the independent upside signals.',
      confidence: summary.positions.closed >= 50 ? 'medium' : 'low',
      evidence: { avgPnl, closed: summary.positions.closed, recommended_actions: [] },
    });
  }
  if (!lessons.length) {
    lessons.push({
      scope: 'global',
      lesson: 'There is not enough version-compatible evidence to infer a reliable trading pattern.',
      instruction: 'Do not alter selection behavior from this lesson; continue collecting outcomes.',
      confidence: 'low',
      evidence: { closed: summary.positions.closed, recommended_actions: [] },
    });
  }
  return lessons.slice(0, 6);
}

export async function generateLessons(summary) {
  const fallback = fallbackLessons(summary);
  if (!ENABLE_LLM || !LLM_API_KEY) return { lessons: fallback, raw: { fallback: true } };
  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You are Angel, a quantitative trading analyst reviewing dry-run evidence.',
            'Return strict JSON only.',
            'Do not invent trades or outcomes. Base everything on the provided JSON summary.',
            'Perform microscopic analysis. Do not just state "Win rate is low". Answer WHY: Was the entry MCap too high? Did bot concentration cause rug pulls? Did high momentum tokens slip due to low liquidity?',
            'Only describe patterns supported by adequate samples; explicitly call out weak or missing evidence.',
            'Create highly detailed, nuanced, and deeply analytical operational lessons.',
            'This is advisory learning only. Do not request code, setting, strategy, or model changes.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Perform a deep dive analysis on this trading window. Produce up to 6 detailed lessons uncovering hidden patterns.',
            output_schema: {
              lessons: [{
                scope: 'global or exact signal route',
                lesson: 'Factual pattern supported by the supplied statistics',
                instruction: 'Specific prompt guidance: when it applies and when to BUY/WATCH/PASS',
                evidence: 'Specific supplied sample counts, win rate, PnL, and feature comparison',
                confidence: 'low | medium | high'
              }],
            },
            summary,
          }),
        },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const parsed = strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
    const allowedScopes = new Set(['global', ...(summary.positions?.byRoute || []).map(row => String(row.route))]);
    const evidenceTrades = Number(summary.positions?.closed || 0);
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.filter(item => item && typeof item === 'object').map(item => ({
          scope: allowedScopes.has(String(item.scope)) ? String(item.scope) : 'global',
          lesson: String(item.lesson || '').slice(0, 500),
          instruction: String(item.instruction || item.lesson || '').slice(0, 700),
          confidence: evidenceTrades < 50 ? 'low'
            : evidenceTrades < 100 && item.confidence === 'high' ? 'medium'
              : ['low', 'medium', 'high'].includes(String(item.confidence)) ? String(item.confidence) : 'low',
          evidence: { data: item.evidence, recommended_actions: Array.isArray(item.recommended_actions) ? item.recommended_actions : [] },
        })).filter(item => item.lesson)
      : [];
    return { lessons: lessons.length ? lessons.slice(0, 6) : fallback, raw: parsed };
  } catch (err) {
    console.log(`[learn] LLM failed: ${err.message}`);
    return { lessons: fallback, raw: { error: err.message, fallback: true } };
  }
}

export function storeLearningRun(windowMs, summary, lessons, raw) {
  const result = db.prepare(`
    INSERT INTO learning_runs (created_at_ms, window_ms, summary_json, lessons_json, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), windowMs, json(summary), json(lessons), json(raw));
  const runId = Number(result.lastInsertRowid);
  const eligible = windowMs >= 7 * 24 * 60 * 60 * 1000
    && Number(summary?.positions?.closed || 0) >= 50
    && summary?.dataQuality?.learningEligible === true;
  const lessonStatus = eligible ? 'candidate' : 'insufficient';
  const insert = db.prepare(`
    INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json, scope, instruction, confidence, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of lessons) insert.run(
    runId, now(), lessonStatus, item.lesson, json(item.evidence || {}),
    item.scope || 'global', item.instruction || item.lesson, item.confidence || 'low', null,
  );
  return runId;
}
