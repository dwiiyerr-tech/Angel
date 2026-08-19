import WebSocket from 'ws';
import fs from 'fs';

const WS_URL = 'wss://pumpportal.fun/api/data';
const LOG_FILE = './migration_test.log';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// Clear log
fs.writeFileSync(LOG_FILE, '');

log('Connecting to PumpPortal...');

const ws = new WebSocket(WS_URL);
let startTime = Date.now();
let migrationCount = 0;
let createCount = 0;
let totalMsgs = 0;

ws.on('open', () => {
  log('✅ Connected!');
  ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  ws.send(JSON.stringify({ method: 'subscribeMigration' }));
  log('Subscribed: subscribeNewToken + subscribeMigration');
  log('Waiting for events (will run for 60 minutes)...\n');
});

ws.on('message', (data) => {
  totalMsgs++;
  try {
    const payload = JSON.parse(data.toString());
    const txType = payload.txType || 'unknown';
    
    if (txType === 'migrate') {
      migrationCount++;
      log(`🚀 MIGRATION #${migrationCount} — ${payload.name || 'unknown'} (${payload.mint || payload.tokenAddress || '?'})`);
      log(`   full: ${JSON.stringify(payload).substring(0, 500)}`);
    } else if (txType === 'create') {
      createCount++;
      if (createCount <= 5) {
        log(`🆕 CREATE #${createCount}: ${payload.name || 'unknown'} (${payload.mint || '?'})`);
      }
    }
  } catch (e) {
    log(`[parse error] ${data.toString().substring(0, 200)}`);
  }
});

ws.on('error', (err) => {
  log(`❌ ERROR: ${err.message}`);
});

ws.on('close', (code, reason) => {
  log(`CLOSED code=${code} reason=${reason}`);
});

// Status tiap 5 menit
setInterval(() => {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  log(`[status] ${min}m${sec}s | creates: ${createCount} | migrations: ${migrationCount} | total_msgs: ${totalMsgs}`);
}, 300000);

// Auto-stop 60 menit
setTimeout(() => {
  log(`\n=== 60 MINUTE SUMMARY ===`);
  log(`Total messages: ${totalMsgs}`);
  log(`Creates: ${createCount}`);
  log(`Migrations: ${migrationCount}`);
  ws.close();
  process.exit(0);
}, 3600000);

process.on('SIGINT', () => {
  log('\nInterrupted.');
  ws.close();
  process.exit(0);
});
