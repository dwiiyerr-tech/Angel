#!/usr/bin/env node
/**
 * Angel Auto-Learn Manager (headless)
 * Run advisory learning: summarize dry-runs → LLM lessons → store. Never mutates configuration.
 * Usage: node scripts/auto_learn.mjs [window]  (default 24h)
 */
import { parseWindowMs } from '../src/utils.js';

const windowArg = process.argv[2] || '24h';

const { summarizeLearningWindow } = await import('../src/learning/summary.js');
const { generateLessons, storeLearningRun } = await import('../src/learning/lessons.js');

const windowMs = parseWindowMs(windowArg);

const summary = summarizeLearningWindow(windowMs);
const { lessons, raw } = await generateLessons(summary);

const runId = storeLearningRun(windowMs, summary, lessons, raw);
console.log(`lesson run #${runId} stored — ${lessons.length} lessons`);

console.log('advisory-only: no settings, strategies, code, or models changed');
