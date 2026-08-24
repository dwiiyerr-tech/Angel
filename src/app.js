import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, POSITION_CHECK_MS, PUMPPORTAL_API_KEY, PUMPPORTAL_ENABLED, PREGRAD_ENABLED, TRENDING_POLL_MS, validateConfig } from './config.js';
import { db, initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorAllPositionsByMode } from './execution/modeMonitor.js';
import { ensureResearchSchema } from './research/schema.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram } from './telegram/send.js';
import { makeFailureTracker } from './utils.js';
import { summarizeLearningWindow } from './learning/summary.js';
import { generateLessons, storeLearningRun } from './learning/lessons.js';
import { pruneExpiredCache } from './db/decisions.js';
import { pruneOldFilteredCandidates, pruneOldSignalEvents } from './db/candidates.js';
import { runBackup } from './db/backup.js';
import { startHealthServer } from './health/server.js';
import { startDeadMansSwitch } from './health/deadMansSwitch.js';
import { startLLMCalibrator } from './pipeline/llmCalibrator.js';
import axios from 'axios';
import { ensureSafeStartupMode } from './db/liveConfig.js';
import { pauseLiveEntries } from './health/circuitBreaker.js';
import { recordHttpBlock } from './enrichment/httpEvents.js';

setDefaultResultOrder('ipv4first');
axios.interceptors.response.use(
  response => response,
  error => {
    recordHttpBlock({
      provider: 'axios',
      method: error?.config?.method?.toUpperCase() || 'GET',
      url: error?.config?.url,
      status: error?.response?.status,
      source: 'axios-interceptor',
    });
    return Promise.reject(error);
  },
);
validateConfig();

function nonOverlapping(name, fn) {
  let running = false;
  return async () => {
    if (running) {
      console.warn(`[scheduler] skipped overlapping ${name} cycle`);
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

function scheduleAfterCompletion(name, fn, intervalMs) {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    const startedAt = Date.now();
    try {
      await fn();
    } catch (error) {
      console.error(`[scheduler] ${name} cycle failed: ${error.message}`);
    } finally {
      if (!stopped) {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs > intervalMs) {
          console.warn(`[scheduler] slow ${name} cycle: ${elapsedMs}ms; next cycle in ${intervalMs}ms`);
        }
        setTimeout(run, intervalMs);
      }
    }
  };
  void run();
  return () => { stopped = true; };
}

export async function startAngel() {
  initDb();
  // Additive/idempotent research migration: existing Angel databases upgrade in
  // place and retain all previous live/shadow history.
  ensureResearchSchema();
  ensureSafeStartupMode();

  startHealthServer();
  startDeadMansSwitch();
  initLiveExecution();
  setupTelegram();

  if (SIGNAL_SERVER_URL) {
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');
    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);
    scheduleAfterCompletion('server signals', () => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);

    const { fetchTrenches, setCandidateHandler: setTrenchesHandler } = await import('./signals/trenches.js');
    setTrenchesHandler(processCandidateFromSignals);
    const trackTrenches = makeFailureTracker('gmgn trenches', alert);
    fetchTrenches().catch(error => console.log(`[trenches] initial fetch failed: ${error.message}`));
    setInterval(nonOverlapping('gmgn trenches', () => trackTrenches(() => fetchTrenches())), 60_000);

    const { monitorPriceAlerts, cleanupAlerts, setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    setInterval(nonOverlapping('dip monitor', () => trackDip(() => monitorPriceAlerts())), 10_000);
    setInterval(() => cleanupAlerts(), 60 * 60 * 1000);

    console.log(`[bot] ${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
  } else {
    const { fetchTrenches, setCandidateHandler } = await import('./signals/trenches.js');
    setCandidateHandler(processCandidateFromSignals);
    fetchTrenches().catch(error => console.log(`[trenches] initial fetch failed: ${error.message}`));
    setInterval(nonOverlapping('gmgn trenches', () => fetchTrenches().catch(error => console.log(`[trenches] ${error.message}`))), 60_000);
    console.log(`[bot] ${APP_NAME} started (trenches-only mode)`);
  }

  const { startGraduationPolling, fetchGraduatedCoins } = await import('./signals/graduated.js');
  const trackGraduation = makeFailureTracker('graduation poll', (msg) => sendTelegram(msg));
  fetchGraduatedCoins().catch(err => console.log(`[graduated] initial fetch failed: ${err.message}`));
  setInterval(nonOverlapping('graduation endpoint', () => trackGraduation(() => fetchGraduatedCoins())), 60_000);
  Promise.resolve(startGraduationPolling()).catch(err => console.error(`[graduated] polling error: ${err.message}`));

  const { fetchGmgnTrending, setTrendingCandidateHandler } = await import('./signals/trending.js');
  setTrendingCandidateHandler(processCandidateFromSignals);
  const trackTrending = makeFailureTracker('trending poll', (msg) => sendTelegram(msg));
  fetchGmgnTrending().catch(err => console.log(`[trending] initial fetch failed: ${err.message}`));
  setInterval(nonOverlapping('trending poll', () => trackTrending(() => fetchGmgnTrending())), TRENDING_POLL_MS);

  if (PREGRAD_ENABLED) {
    const { startPumpfunPregrad, setCandidateHandler: setPregradHandler } = await import('./signals/pumpfunPregrad.js');
    setPregradHandler(processCandidateFromSignals);
    const trackPregrad = makeFailureTracker('pumpfun pregrad', (msg) => sendTelegram(msg));
    startPumpfunPregrad(trackPregrad);
  }

  if (PUMPPORTAL_API_KEY && PUMPPORTAL_ENABLED) {
    const { startPumpportal, setCandidateHandler: setPumpportalHandler } = await import('./signals/pumpportal.js');
    setPumpportalHandler(processCandidateFromSignals);
    Promise.resolve(startPumpportal()).catch(err => console.error(`[pumpportal] error: ${err.message}`));
  }

  // One scheduler monitors every position according to the execution_mode stored
  // on that position. A global mode switch therefore cannot orphan positions
  // from the previous mode. Only live failures escape the mixed-mode monitor,
  // preserving the existing circuit-breaker escalation semantics.
  const trackPositions = makeFailureTracker(
    'position monitor',
    (msg) => sendTelegram(msg),
    3,
    (error) => pauseLiveEntries(`position monitor failed repeatedly: ${error.message}`),
  );
  let positionMonitorRunning = false;

  startLLMCalibrator();

  const mlPort = process.env.ML_SERVICE_PORT || 8001;
  setTimeout(() => {
    axios.get(`http://127.0.0.1:${mlPort}/health`, { timeout: 3000 })
      .then(res => console.log(`[app] ML Service OK: ${res.data.status}`))
      .catch(err => console.error(`[app] WARNING: ML Service down at ${mlPort}: ${err.message}`));
  }, 5000);

  setInterval(async () => {
    if (positionMonitorRunning) return;
    positionMonitorRunning = true;
    try {
      await trackPositions(() => Promise.resolve().then(() => monitorAllPositionsByMode()));
    } finally {
      positionMonitorRunning = false;
    }
  }, POSITION_CHECK_MS);

  // Durable weekly learning remains advisory-only. Zero-capital research does
  // not modify strategy/live configuration automatically.
  const LEARNING_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  const LEARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  async function runPeriodicLearning() {
    try {
      const summary = summarizeLearningWindow(LEARNING_WINDOW_MS);
      const { lessons, raw } = await generateLessons(summary);
      const runId = storeLearningRun(LEARNING_WINDOW_MS, summary, lessons, raw);
      const eligible = Number(summary.positions.closed || 0) >= 50
        && summary.dataQuality?.learningEligible === true;
      console.log(`[learn] advisory run #${runId}: ${lessons.length} ${eligible ? 'candidate' : 'insufficient'} lessons stored; no configuration changes`);
      await sendTelegram(`🧠 <b>LLM Learning (advisory only)</b>\n\nRun #${runId}: ${lessons.length} lessons stored as ${eligible ? 'candidates awaiting /lessonapprove' : 'insufficient evidence'}.\nNo settings, strategies, code, or models were changed.`);
    } catch (err) {
      console.error(`[learn] periodic learning failed: ${err.message}`);
    }
  }
  const lastLearningRun = db.prepare('SELECT MAX(created_at_ms) AS at_ms FROM learning_runs').get()?.at_ms || 0;
  const firstLearningDelay = lastLearningRun
    ? Math.max(60_000, LEARNING_INTERVAL_MS - (Date.now() - lastLearningRun))
    : 60 * 60 * 1000;
  const scheduleLearning = (delayMs) => setTimeout(async () => {
    await runPeriodicLearning();
    scheduleLearning(LEARNING_INTERVAL_MS);
  }, delayMs);
  scheduleLearning(firstLearningDelay);
  console.log(`[bot] learning cycle scheduled in ${(firstLearningDelay / 3600000).toFixed(1)}h, then every 7 days (7-day evidence window)`);

  setInterval(pruneExpiredCache, 60 * 60 * 1000);
  setInterval(() => {
    try {
      const pruned = pruneOldFilteredCandidates();
      const prunedEvents = pruneOldSignalEvents();
      if (pruned > 0 || prunedEvents > 0) {
        console.log(`[maintenance] pruned ${pruned} stale candidates and ${prunedEvents} old signal events`);
      }
    } catch (error) {
      console.error(`[maintenance] candidate pruning failed: ${error.message}`);
    }
  }, 60 * 60 * 1000);

  void runBackup().then(() => console.log('[backup] startup SQLite backup created'))
    .catch(err => console.error(`[backup] startup backup failed: ${err.message}`));
  setInterval(nonOverlapping('database backup', async () => {
    try {
      await runBackup();
      console.log('[backup] scheduled SQLite backup created');
    } catch (err) {
      console.error(`[backup] failed: ${err.message}`);
      await sendTelegram(`🔴 DATABASE BACKUP FAILED: ${err.message}`);
    }
  }), 4 * 60 * 60 * 1000);
}
