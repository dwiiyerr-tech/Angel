import fs from 'node:fs';
import path from 'node:path';

const logPath = path.resolve(process.cwd(), 'logs/http_rate_limit_events.jsonl');

export function recordHttpBlock({ provider = 'unknown', method = 'GET', url = '', status, source = 'http' } = {}) {
  if (status !== 403 && status !== 429) return;
  const event = { at_ms: Date.now(), at: new Date().toISOString(), provider, method, url: String(url).slice(0, 500), status, source };
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
  } catch (error) {
    console.error(`[http-block-log] failed: ${error.message}`);
  }
  console.warn(`[http-block] ${provider} ${status} ${method} ${event.url}`);
}

export function httpBlockLogPath() { return logPath; }
