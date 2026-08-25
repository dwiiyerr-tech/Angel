import { db } from '../db/connection.js';
import { setSetting, setting } from '../db/settings.js';
import { sendTelegram } from '../telegram/send.js';
import { DRY_RUN_SIMULATOR_VERSION } from '../learning/simulatorVersion.js';

export async function runLLMCalibration() {
  try {
    const now = Date.now();
    const lastRun = Number(setting('last_llm_calibration_ms', '0'));
    if (now - lastRun < 12 * 3600 * 1000) return 'Skipping: recently run';

    const query = `
      SELECT p.pnl_percent, l.confidence
      FROM llm_decisions l
      JOIN dry_run_positions p ON l.id = p.llm_decision_id
      WHERE l.verdict = 'BUY'
        AND p.status = 'closed'
        AND p.execution_mode = 'shadow_live'
        AND json_extract(p.snapshot_json, '$.shadowLiveCompatible') = 1
        AND json_extract(p.snapshot_json, '$.entryQuoteMode') = 'position_sized'
        AND l.created_at_ms > ?
        AND json_extract(p.snapshot_json, '$.simulatorVersion') = ?
    `;

    const decisions = db.prepare(query).all(now - 7 * 24 * 3600 * 1000, DRY_RUN_SIMULATOR_VERSION);
    if (decisions.length < 5) return 'Not enough closed shadow-live trades (need 5)';

    const wins = decisions.filter(row => Number(row.pnl_percent) > 0).length;
    const winRate = wins / decisions.length;
    const brier = decisions.reduce((sum, row) => {
      const probability = Math.max(0, Math.min(1, Number(row.confidence || 0) / 100));
      const outcome = Number(row.pnl_percent) > 0 ? 1 : 0;
      return sum + (probability - outcome) ** 2;
    }, 0) / decisions.length;
    const buckets = new Map();
    for (const row of decisions) {
      const bucket = Math.floor(Number(row.confidence || 0) / 10) * 10;
      const current = buckets.get(bucket) || { count: 0, predicted: 0, wins: 0 };
      current.count += 1;
      current.predicted += Number(row.confidence || 0) / 100;
      current.wins += Number(row.pnl_percent) > 0 ? 1 : 0;
      buckets.set(bucket, current);
    }
    const ece = [...buckets.values()].reduce((sum, bucket) => {
      const predicted = bucket.predicted / bucket.count;
      const observed = bucket.wins / bucket.count;
      return sum + bucket.count / decisions.length * Math.abs(predicted - observed);
    }, 0);

    setSetting('llm_calibration_overall', winRate.toString());
    setSetting('llm_calibration_brier', brier.toString());
    setSetting('llm_calibration_ece', ece.toString());
    setSetting('last_llm_calibration_ms', now.toString());

    let msg = `BUY outcome audit: win rate ${(winRate * 100).toFixed(1)}% (${wins}/${decisions.length}), Brier ${brier.toFixed(3)}, ECE ${(ece * 100).toFixed(1)}%`;
    if (winRate < 0.35 || ece > 0.2) {
      msg += '\n⚠️ Warning: BUY outcomes are weak or confidence is poorly calibrated. Review prompt lessons; no setting was changed.';
      await sendTelegram(msg);
    }
    return msg;
  } catch (err) {
    console.error('LLM calibration failed:', err);
    return 'Error running calibration';
  }
}

export function startLLMCalibrator() {
  setTimeout(runLLMCalibration, 10 * 60 * 1000);
  setInterval(runLLMCalibration, 24 * 60 * 60 * 1000);
}
