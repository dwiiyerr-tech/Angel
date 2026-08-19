import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, json, stripThinking, strictJsonFromText } from '../utils.js';
import { fmtPct } from '../format.js';
import { db } from '../db/connection.js';

export function fallbackLessons(summary) {
  const lessons = [];
  const bestRoute = summary.positions.byRoute?.[0];
  const worstRoute = [...(summary.positions.byRoute || [])].sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
  if (bestRoute && bestRoute.count >= 2 && bestRoute.pnlPercent > 0) {
    lessons.push({
      lesson: `Prefer ${bestRoute.route} when other filters are clean; it led the window with ${fmtPct(bestRoute.avgPnlPercent)} avg PnL across ${bestRoute.count} closed dry-runs.`,
      evidence: { ...bestRoute, recommended_actions: [] },
    });
  }
  if (worstRoute && worstRoute.count >= 2 && worstRoute.pnlPercent < 0) {
    lessons.push({
      lesson: `Be stricter on ${worstRoute.route}; it underperformed with ${fmtPct(worstRoute.avgPnlPercent)} avg PnL across ${worstRoute.count} closed dry-runs.`,
      evidence: { ...worstRoute, recommended_actions: [] },
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      lesson: `Recent worst exits clustered around SL; require stronger fresh pre-entry mcap/liquidity confirmation before accepting late entries.`,
      evidence: { slWorstCount: slCount, worst: summary.positions.worst, recommended_actions: [
        { target: 'settings', key: 'min_liquidity_usd', new_value: '8000' },
      ] },
    });
  }
  // Performance-based auto-adjustments
  const winRate = (summary.positions.closed > 0) ? (summary.positions.wins / summary.positions.closed) * 100 : 0;
  const avgPnl = summary.positions.avgPnlPercent || 0;
  if (winRate < 35 && summary.positions.closed >= 10) {
    lessons.push({
      lesson: `Win rate ${winRate.toFixed(1)}% is below target 35%; tighten LLM confidence threshold and widen stop loss to reduce false entries and premature exits.`,
      evidence: { winRate, avgPnl, closed: summary.positions.closed, recommended_actions: [
        { target: 'settings', key: 'llm_min_confidence', new_value: '35' },
        { target: 'settings', key: 'default_sl_percent', new_value: '-15' },
      ] },
    });
  }
  if (avgPnl < -5 && summary.positions.closed >= 10) {
    lessons.push({
      lesson: `Average PnL ${avgPnl.toFixed(1)}% is deeply negative; increase minimum liquidity filter and tighten entry criteria.`,
      evidence: { avgPnl, closed: summary.positions.closed, recommended_actions: [
        { target: 'settings', key: 'min_liquidity_usd', new_value: '10000' },
      ] },
    });
  }
  if (!lessons.length) {
    lessons.push({
      lesson: 'Not enough closed dry-run evidence yet; keep collecting decisions before changing filters aggressively.',
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
                lesson: 'Detailed, nuanced, and deeply analytical rule explaining WHY a pattern exists', 
                evidence: 'Specific statistical supporting data and correlation metrics',
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
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.filter(item => item && typeof item === 'object').map(item => ({
          lesson: String(item.lesson || '').slice(0, 500),
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
  const eligible = windowMs >= 7 * 24 * 60 * 60 * 1000 && Number(summary?.positions?.closed || 0) >= 50;
  const lessonStatus = eligible ? 'candidate' : 'insufficient';
  const insert = db.prepare(`
    INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const item of lessons) insert.run(runId, now(), lessonStatus, item.lesson, json(item.evidence || {}));
  return runId;
}
