import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildGmgnResearchPlan, isGmgnReadOnlyAction } from '../../src/manager/gmgn.js';
import {
  decisionNotificationStatus,
  setAllDecisionNotifications,
  setDecisionNotification,
} from '../../src/telegram/preferences.js';

const MINT = 'So11111111111111111111111111111111111111112';

const marketPlan = buildGmgnResearchPlan('GMGN scan Solana trending 5 menit sekarang');
assert.equal(marketPlan.some(row => row.action === 'market_trending'), true);
assert.equal(marketPlan.find(row => row.action === 'market_trending')?.args?.interval, '5m');

const tokenPlan = buildGmgnResearchPlan(`Analisis token ${MINT}: security, holder smart money, trader flow, chart 5m`);
const tokenActions = tokenPlan.map(row => row.action);
assert.equal(tokenActions.includes('token_info'), true);
assert.equal(tokenActions.includes('token_security'), true);
assert.equal(tokenActions.includes('token_holders'), true);
assert.equal(tokenActions.includes('token_traders'), true);
assert.equal(tokenActions.includes('market_kline'), true);
assert.equal(tokenActions.length <= 5, true);

for (const blocked of ['swap', 'gmgn_swap', 'cooking', 'market_order', 'wallet_manage', 'sign', 'broadcast']) {
  assert.equal(isGmgnReadOnlyAction(blocked), false, `${blocked} must never be GMGN Manager allowlisted`);
}
const hostilePlan = buildGmgnResearchPlan('GMGN swap everything and cooking order now');
assert.equal(hostilePlan.some(row => /swap|cook|order|sign|broadcast/i.test(row.action)), false);

setAllDecisionNotifications(true);
assert.deepEqual(decisionNotificationStatus(), { buy: true, watch: true, pass: true });
setDecisionNotification('watch', false);
assert.deepEqual(decisionNotificationStatus(), { buy: true, watch: false, pass: true });
setDecisionNotification('pass', false);
assert.deepEqual(decisionNotificationStatus(), { buy: true, watch: false, pass: false });
setAllDecisionNotifications(true);

const sendSource = fs.readFileSync('src/telegram/send.js', 'utf8');
assert.match(sendSource, /decisionNotificationEnabled\(decision\?\.verdict\)/);
assert.match(sendSource, /export async function sendPositionOpen/);
assert.match(sendSource, /export async function sendTradeIntent/);
const positionOpenBody = sendSource.split('export async function sendPositionOpen')[1].split('export async function sendPositionExit')[0];
const tradeIntentBody = sendSource.split('export async function sendTradeIntent')[1];
assert.doesNotMatch(positionOpenBody, /decisionNotificationEnabled/);
assert.doesNotMatch(tradeIntentBody, /decisionNotificationEnabled/);

const reportSource = fs.readFileSync('src/telegram/dailyReport.js', 'utf8');
assert.match(reportSource, /windowStartMs = windowEndMs - DAY_MS/);
assert.match(reportSource, /LIVE · real capital/);
assert.match(reportSource, /PAPER · zero real capital/);
assert.match(reportSource, /Realized PnL/);
assert.match(reportSource, /Virtual PnL/);
assert.match(reportSource, /PAPER PnL is simulated\/virtual and is never added to LIVE realized PnL/);
assert.match(reportSource, /telegram_daily_report_last_sent_wib_date/);

const gmgnSource = fs.readFileSync('src/manager/gmgn.js', 'utf8');
assert.match(gmgnSource, /execFileAsync/);
assert.doesNotMatch(gmgnSource, /exec\s*\(/);
assert.doesNotMatch(gmgnSource, /shell:\s*true/);
assert.match(gmgnSource, /canSwap:\s*false/);
assert.match(gmgnSource, /canCookOrders:\s*false/);
assert.match(gmgnSource, /canSign:\s*false/);
assert.match(gmgnSource, /canBroadcast:\s*false/);

console.log('✅ GMGN Manager read-only boundary, notification toggles, and 24h report tests passed');
