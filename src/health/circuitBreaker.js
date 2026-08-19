import { setting, setSetting } from '../db/settings.js';
import { sendTelegram } from '../telegram/send.js';

export async function pauseLiveEntries(reason) {
  const mode = setting('trading_mode', 'dry_run');
  if (mode === 'dry_run') return false;
  if (mode === 'live') setSetting('trading_mode', 'confirm');
  if (setting('live_circuit_breaker_open', 'false') === 'true') return false;
  setSetting('live_circuit_breaker_open', 'true');
  const message = `🛑 <b>LIVE CIRCUIT BREAKER LATCHED</b>\n\nAll new entries are blocked${mode === 'live' ? ' (live → confirm)' : ''}.\nReason: ${reason}\nExisting positions remain monitored. Reset requires dry_run, no unresolved executions, and a new live snapshot.`;
  console.error(`[circuit-breaker] ${reason}`);
  await sendTelegram(message).catch(error => console.error(`[circuit-breaker] alert failed: ${error.message}`));
  return true;
}
