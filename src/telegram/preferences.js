import { boolSetting, setSetting } from '../db/settings.js';

const VERDICTS = ['buy', 'watch', 'pass'];

function keyFor(verdict) {
  const normalized = String(verdict || '').trim().toLowerCase();
  if (!VERDICTS.includes(normalized)) throw new Error(`Unsupported decision notification: ${verdict}`);
  return `telegram_notify_${normalized}`;
}

export function decisionNotificationEnabled(verdict) {
  const normalized = String(verdict || '').trim().toLowerCase();
  if (!VERDICTS.includes(normalized)) return true;
  return boolSetting(keyFor(normalized), true);
}

export function decisionNotificationStatus() {
  return Object.fromEntries(VERDICTS.map(verdict => [verdict, decisionNotificationEnabled(verdict)]));
}

export function setDecisionNotification(verdict, enabled) {
  const normalized = String(verdict || '').trim().toLowerCase();
  setSetting(keyFor(normalized), enabled ? 'true' : 'false');
  return decisionNotificationEnabled(normalized);
}

export function setAllDecisionNotifications(enabled) {
  for (const verdict of VERDICTS) setDecisionNotification(verdict, enabled);
  return decisionNotificationStatus();
}
