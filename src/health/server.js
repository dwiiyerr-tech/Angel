import http from 'http';
import { db } from '../db/connection.js';
import { setting, boolSetting } from '../db/settings.js';
import { getLastSignalProcessedAt } from './deadMansSwitch.js';
import { getBackupStatus } from '../db/backup.js';
import axios from 'axios';
import { unresolvedExecutionCount } from '../db/executionOperations.js';
import { configuredTradingMode } from '../research/policy.js';

const PORT = process.env.PORT_HEALTH || 3099;
const bootTime = Date.now();

async function checkMlHealth() {
  try {
    const res = await axios.get(`http://127.0.0.1:${process.env.ML_SERVICE_PORT || 8001}/health`, { timeout: 1000 });
    return res.status === 200;
  } catch { return false; }
}

export function startHealthServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('pong');
    }

    if (req.url === '/health') {
      try {
        const positionCounts = db.prepare(`
          SELECT
            count(*) AS total,
            sum(CASE WHEN lower(trim(coalesce(execution_mode, 'dry_run'))) IN ('live', 'confirm') THEN 0 ELSE 1 END) AS paper,
            sum(CASE WHEN lower(trim(coalesce(execution_mode, 'dry_run'))) IN ('live', 'confirm') THEN 1 ELSE 0 END) AS live
          FROM dry_run_positions
          WHERE status IN ('open', 'entry_unknown', 'exit_unknown', 'partial_exit_unknown')
        `).get();
        const backupStatus = getBackupStatus();
        let backupLastMs = null;
        if (backupStatus.last_backup) {
          const m = backupStatus.last_backup.match(/(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})/);
          if (m) backupLastMs = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
        }

        const regimeAwarenessEnabled = boolSetting('enable_regime_awareness', false);
        const macroStateText = setting('current_macro_state') || '';
        const weatherMatch = macroStateText.match(/Market weather is (\w+)/);
        const macroState = regimeAwarenessEnabled ? (weatherMatch ? weatherMatch[1] : 'UNKNOWN') : 'DISABLED';
        const lastSignalMs = getLastSignalProcessedAt();

        const mlServiceUp = await checkMlHealth();
        const unresolvedExecutions = unresolvedExecutionCount();
        const signalAgeMs = Date.now() - lastSignalMs;
        const backupAgeMs = backupLastMs == null ? Infinity : Date.now() - backupLastMs;
        const degradedReasons = [];
        if (!mlServiceUp) degradedReasons.push('ml_service_down');
        if (signalAgeMs > 30 * 60 * 1000) degradedReasons.push('signals_stale');
        if (backupAgeMs > 8 * 60 * 60 * 1000) degradedReasons.push('backup_stale');
        if (unresolvedExecutions > 0) degradedReasons.push('unresolved_execution');
        const paperPositions = Number(positionCounts?.paper || 0);
        const livePositions = Number(positionCounts?.live || 0);
        const payload = {
          status: degradedReasons.length ? 'degraded' : 'ok',
          uptime_seconds: Math.floor((Date.now() - bootTime) / 1000),
          open_positions: Number(positionCounts?.total || 0),
          paper_positions: paperPositions,
          live_positions: livePositions,
          // Backward-compatible health keys retain their old names but now use
          // the canonical public two-mode classification.
          research_positions: paperPositions,
          execution_positions: livePositions,
          research_real_capital_sol: 0,
          last_signal_processed_ms: lastSignalMs,
          last_signal_age_seconds: Math.floor((Date.now() - lastSignalMs) / 1000),
          trading_mode: configuredTradingMode(),
          trading_mode_storage: setting('trading_mode', 'dry_run'),
          ml_service_up: mlServiceUp,
          db_backup_last_ms: backupLastMs,
          unresolved_executions: unresolvedExecutions,
          degraded_reasons: degradedReasons,
          macro_state: macroState,
          regime_awareness_enabled: regimeAwarenessEnabled,
        };

        res.writeHead(degradedReasons.length ? 503 : 200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, process.env.HEALTH_HOST || '127.0.0.1', () => {
    console.log(`[health] server running on port ${PORT}`);
  });
}
