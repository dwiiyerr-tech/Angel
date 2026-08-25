import fs from 'node:fs';

const SIMULATION_STATUSES = new Set(['confirmed', 'pending', 'timeout', 'failed']);
const SIMULATION_FAILURE_STAGES = new Set(['order', 'sign', 'rpc', 'confirmation', 'all']);

let tickCache = { file: null, mtimeMs: 0, ticks: [], replayStartedAtMs: 0 };
let tickLoadErrorLogged = false;

function envNumber(env, key, fallback = 0) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function configuredFailureStages(env = process.env) {
  const raw = String(env.SIMULATION_RPC_FAILURE_STAGE || env.SIMULATION_FAULT_STAGE || '').trim();
  return new Set(raw.split(',').map(value => value.trim().toLowerCase()).filter(value => SIMULATION_FAILURE_STAGES.has(value)));
}

export function injectSimulationFailure(stage, env = process.env, random = Math.random) {
  const normalizedStage = String(stage || '').trim().toLowerCase();
  const stages = configuredFailureStages(env);
  const rate = Math.max(0, Math.min(1, envNumber(env, 'SIMULATION_RPC_FAILURE_RATE', 0)));
  const shouldFail = stages.has(normalizedStage) || stages.has('all') || (rate > 0 && random() < rate);
  if (!shouldFail) return false;

  const error = new Error(`Injected simulation failure at ${normalizedStage || 'unknown'} stage.`);
  error.simulationFailure = true;
  error.simulationStage = normalizedStage;
  error.simulationOutcomeUnknown = normalizedStage === 'confirmation';
  throw error;
}

export async function simulateConfirmation({ signature = null, env = process.env, sleepFn = sleep } = {}) {
  injectSimulationFailure('confirmation', env);
  const delayMs = Math.max(0, envNumber(env, 'SIMULATION_CONFIRMATION_DELAY_MS', 0));
  if (delayMs > 0) await sleepFn(delayMs);

  const status = String(env.SIMULATION_CONFIRMATION_STATUS || 'confirmed').trim().toLowerCase();
  const normalizedStatus = SIMULATION_STATUSES.has(status) ? status : 'failed';
  const lifecycle = ['built', 'signed', 'rpc_simulated', normalizedStatus];
  const result = { status: normalizedStatus, signature, broadcast: false, lifecycle, delayMs };
  if (normalizedStatus === 'confirmed') return result;

  const error = new Error(`Simulated confirmation ${normalizedStatus}.`);
  error.simulationFailure = true;
  error.simulationStage = 'confirmation';
  error.simulationStatus = normalizedStatus;
  error.simulationOutcomeUnknown = normalizedStatus === 'pending' || normalizedStatus === 'timeout';
  throw error;
}

function normalizeTick(row, index) {
  const mint = String(row?.mint || row?.address || '').trim();
  const atMs = Number(row?.at_ms ?? row?.atMs ?? row?.timestamp_ms ?? row?.timestamp ?? 0);
  const priceUsd = Number(row?.price_usd ?? row?.priceUsd ?? row?.price ?? 0);
  const mcapUsd = Number(row?.mcap_usd ?? row?.mcapUsd ?? row?.market_cap_usd ?? row?.marketCapUsd ?? row?.mcap ?? 0);
  if (!mint || !Number.isFinite(atMs) || atMs <= 0 || (priceUsd <= 0 && mcapUsd <= 0)) return null;
  return {
    mint,
    atMs,
    priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
    mcapUsd: Number.isFinite(mcapUsd) && mcapUsd > 0 ? mcapUsd : null,
    sequence: index,
  };
}

function readTickFile(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  let rows;
  try {
    rows = JSON.parse(text);
    if (!Array.isArray(rows)) rows = rows?.ticks || [];
  } catch {
    rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }
  return rows.map(normalizeTick).filter(Boolean).sort((a, b) => a.atMs - b.atMs || a.sequence - b.sequence);
}

function loadTicks(file, nowMs = Date.now()) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (!tickLoadErrorLogged) {
      console.warn(`[simulation] tick file unavailable: ${file} (${error.message})`);
      tickLoadErrorLogged = true;
    }
    return [];
  }
  if (tickCache.file === file && tickCache.mtimeMs === stat.mtimeMs) return tickCache.ticks;
  try {
    const ticks = readTickFile(file);
    tickCache = { file, mtimeMs: stat.mtimeMs, ticks, replayStartedAtMs: nowMs };
    tickLoadErrorLogged = false;
    return ticks;
  } catch (error) {
    if (!tickLoadErrorLogged) {
      console.warn(`[simulation] tick file parse failed: ${file} (${error.message})`);
      tickLoadErrorLogged = true;
    }
    return [];
  }
}

export function resetSimulationTicks() {
  tickCache = { file: null, mtimeMs: 0, ticks: [], replayStartedAtMs: 0 };
  tickLoadErrorLogged = false;
}

export function simulationReplayEnabled(env = process.env) {
  return Boolean(String(env.SIMULATION_TICK_FILE || '').trim());
}

export function simulationTickFor(mint, nowMs = Date.now(), env = process.env) {
  const file = String(env.SIMULATION_TICK_FILE || '').trim();
  if (!file) return null;
  const ticks = loadTicks(file, nowMs);
  if (!ticks.length) return null;

  const speed = Math.max(0, envNumber(env, 'SIMULATION_REPLAY_SPEED', 1));
  const firstAtMs = ticks[0].atMs;
  const replayNowMs = speed === 0
    ? firstAtMs
    : firstAtMs + Math.max(0, nowMs - tickCache.replayStartedAtMs) * speed;
  let selected = null;
  for (const tick of ticks) {
    if (tick.mint !== mint) continue;
    if (tick.atMs > replayNowMs) break;
    selected = tick;
  }
  return selected ? { ...selected, replayNowMs } : null;
}

export function simulationStatusOptions(env = process.env) {
  return {
    confirmationStatus: String(env.SIMULATION_CONFIRMATION_STATUS || 'confirmed'),
    confirmationDelayMs: Math.max(0, envNumber(env, 'SIMULATION_CONFIRMATION_DELAY_MS', 0)),
    failureStages: [...configuredFailureStages(env)],
    failureRate: Math.max(0, Math.min(1, envNumber(env, 'SIMULATION_RPC_FAILURE_RATE', 0))),
    tickFile: String(env.SIMULATION_TICK_FILE || '') || null,
    replaySpeed: Math.max(0, envNumber(env, 'SIMULATION_REPLAY_SPEED', 1)),
  };
}
