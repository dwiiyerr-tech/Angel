import fs from 'fs';
import path from 'path';

let lastSignalProcessedAt = Date.now();
let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

export function recordSignalProcessed() {
  lastSignalProcessedAt = Date.now();
}

export function getLastSignalProcessedAt() {
  return lastSignalProcessedAt;
}

async function sendDeadManAlert(msg) {
  try {
    const { sendTelegram } = await import('../telegram/send.js');
    await sendTelegram(msg);
  } catch (error) {
    console.error(`[dead-man] Telegram alert failed: ${error.message}`);
  }
}

export function startDeadMansSwitch() {
  setInterval(async () => {
    const current = new Date();
    const msSinceLast = Date.now() - lastSignalProcessedAt;
    if (msSinceLast > 30 * 60 * 1000 && Date.now() - lastAlertAt >= ALERT_COOLDOWN_MS) {
      lastAlertAt = Date.now();
      const msg = '🚨 DEAD MAN SWITCH: No signals processed in 30min. System may be frozen.';
      console.error(msg);
      await sendDeadManAlert(msg);

      try {
        const logDir = path.resolve(process.cwd(), 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'dead_mans_switch.log'), `[${current.toISOString()}] ${msg}\n`);
      } catch (error) {
        console.error(`[dead-man] log append failed: ${error.message}`);
      }
    }
  }, 5 * 60 * 1000);
}
