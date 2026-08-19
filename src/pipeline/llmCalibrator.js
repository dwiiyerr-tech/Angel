import { db } from '../db/connection.js';
import { setSetting, setting } from '../db/settings.js';
import { sendTelegram } from '../telegram/send.js';

export async function runLLMCalibration() {
  try {
    const now = Date.now();
    const lastRun = Number(setting('last_llm_calibration_ms', '0'));
    if (now - lastRun < 12 * 3600 * 1000) return 'Skipping: recently run';

    const query = `
      SELECT p.pnl_percent 
      FROM llm_decisions l 
      JOIN dry_run_positions p ON l.id = p.llm_decision_id 
      WHERE l.verdict = 'BUY' AND p.status = 'closed' AND l.created_at_ms > ?
    `;
    
    const decisions = db.prepare(query).all(now - 7 * 24 * 3600 * 1000);
    if (decisions.length < 5) return 'Not enough closed trades (need 5)';
    
    let correct = 0;
    for (const d of decisions) {
      if (d.pnl_percent > 0) correct++;
    }
    
    const accuracy = correct / decisions.length;
    
    setSetting('llm_calibration_overall', accuracy.toString());
    setSetting('last_llm_calibration_ms', now.toString());
    
    let msg = `Overall Accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${decisions.length})`;
    
    if (accuracy < 0.35) {
      msg += `\n⚠️ Warning: Accuracy is very low (under 35%). Consider tightening filters or prompt.`;
      await sendTelegram(msg);
    }
    
    return msg;
  } catch (err) {
    console.error('LLM calibration failed:', err);
    return 'Error running calibration';
  }
}

export function startLLMCalibrator() {
  setTimeout(runLLMCalibration, 10 * 60 * 1000); // First run 10 min after boot
  setInterval(runLLMCalibration, 24 * 60 * 60 * 1000);
}
