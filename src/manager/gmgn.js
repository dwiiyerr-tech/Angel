import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GMGN_API_KEY } from '../config.js';

const execFileAsync = promisify(execFile);
const SOL_MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const READ_ONLY_ACTIONS = new Set([
  'market_trending',
  'market_trenches',
  'market_signal',
  'market_hot_searches',
  'market_search',
  'market_kline',
  'token_info',
  'token_security',
  'token_pool',
  'token_holders',
  'token_traders',
]);

function enabled() {
  return process.env.GMGN_MANAGER_ENABLED !== 'false';
}

function cliBin() {
  return process.env.GMGN_CLI_BIN || 'gmgn-cli';
}

function timeoutMs() {
  const value = Number(process.env.GMGN_MANAGER_TIMEOUT_MS || 12_000);
  return Math.max(3_000, Math.min(30_000, Number.isFinite(value) ? value : 12_000));
}

function intervalFromQuestion(text) {
  const value = String(text || '').toLowerCase();
  if (/\b1\s*m(?:in(?:ute)?)?\b|1 menit/.test(value)) return '1m';
  if (/\b5\s*m(?:in(?:ute)?)?\b|5 menit/.test(value)) return '5m';
  if (/\b6\s*h(?:our)?\b|6 jam/.test(value)) return '6h';
  if (/\b24\s*h(?:our)?\b|24 jam|hari ini|today|daily/.test(value)) return '24h';
  return '1h';
}

function resolutionFromQuestion(text) {
  const value = String(text || '').toLowerCase();
  if (/\b30\s*s(?:ec(?:ond)?)?\b|30 detik/.test(value)) return '30s';
  if (/\b1\s*m(?:in(?:ute)?)?\b|1 menit/.test(value)) return '1m';
  if (/\b15\s*m(?:in(?:ute)?)?\b|15 menit/.test(value)) return '15m';
  if (/\b1\s*h(?:our)?\b|1 jam/.test(value)) return '1h';
  return '5m';
}

function explicitSearchQuery(question) {
  const match = String(question || '').match(/(?:search|cari|lookup|find)\s+(?:token\s+|wallet\s+)?([A-Za-z0-9._-]{2,64})/i);
  return match?.[1] || null;
}

export function isGmgnReadOnlyAction(action) {
  return READ_ONLY_ACTIONS.has(String(action || ''));
}

export function buildGmgnResearchPlan(question) {
  const text = String(question || '').trim();
  const lower = text.toLowerCase();
  const mint = (text.match(SOL_MINT_RE) || [])[0] || null;
  const plan = [];
  const add = (action, args = {}) => {
    if (!READ_ONLY_ACTIONS.has(action)) return;
    if (plan.some(row => row.action === action && JSON.stringify(row.args) === JSON.stringify(args))) return;
    plan.push({ action, args });
  };

  const gmgnIntent = /\bgmgn\b|trending|trenches|hot search|hot-search|signal feed|smart money|smartmoney|\bkol\b|holder|trader|rug|security|liquidity|kline|candl|chart|grafik|momentum|market scan|scan market|cek token|check token|analisis token|analyze token|token baru|new token|new launch|early token/i.test(text);
  if (!gmgnIntent && !mint) return [];

  if (mint) {
    add('token_info', { address: mint });
    if (/security|aman|safety|rug|honeypot|dev|holder|smart money|smartmoney|\bkol\b|bundler|sniper|insider|liquidity|pool|analisis|analyze|cek|check|gmgn/i.test(text)) {
      add('token_security', { address: mint });
    }
    if (/liquidity|pool|dex|reserve/i.test(text)) add('token_pool', { address: mint });
    if (/holder|smart money|smartmoney|\bkol\b|bundler|sniper|insider|dev|whale|fresh wallet/i.test(text)) {
      add('token_holders', { address: mint, limit: 20 });
    }
    if (/trader|buy sell|buy\/sell|flow|accumul|distribut|smart money|smartmoney|\bkol\b/i.test(text)) {
      add('token_traders', { address: mint, limit: 20 });
    }
    if (/kline|candl|chart|grafik|price|harga|momentum|volume|entry|timing|analisis|analyze/i.test(text)) {
      add('market_kline', { address: mint, resolution: resolutionFromQuestion(text), lookbackSeconds: 60 * 60 });
    }
    return plan.slice(0, 5);
  }

  if (/trenches|token baru|new token|new launch|baru launch|baru dibuat|early token|early project|pump\.fun/i.test(lower)) {
    add('market_trenches');
  }
  if (/signal feed|market signal|price spike|large buy|smart money signal/i.test(lower)) {
    add('market_signal');
  }
  if (/hot search|hot-search|most searched|paling dicari|pencarian panas/i.test(lower)) {
    add('market_hot_searches', { interval: intervalFromQuestion(text) });
  }
  if (/trending|pumping|market scan|scan market|scan solana|token panas|hottest|gmgn/i.test(lower)) {
    add('market_trending', { interval: intervalFromQuestion(text), limit: 20 });
  }
  const query = explicitSearchQuery(text);
  if (query) add('market_search', { query });
  return plan.slice(0, 4);
}

function actionArgs(action, args = {}) {
  const address = String(args.address || '');
  if (action.startsWith('token_') || action === 'market_kline') {
    if (!SOL_MINT_RE.test(address)) {
      SOL_MINT_RE.lastIndex = 0;
      throw new Error('Invalid Solana token address');
    }
    SOL_MINT_RE.lastIndex = 0;
  }

  switch (action) {
    case 'market_trending':
      return ['market', 'trending', '--chain', 'sol', '--interval', String(args.interval || '1h'), '--order-by', 'volume', '--limit', String(Math.max(1, Math.min(50, Number(args.limit) || 20))), '--raw'];
    case 'market_trenches':
      return ['market', 'trenches', '--chain', 'sol', '--raw'];
    case 'market_signal':
      return ['market', 'signal', '--chain', 'sol', '--raw'];
    case 'market_hot_searches':
      return ['market', 'hot-searches', '--chain', 'sol', '--interval', String(args.interval || '1h'), '--raw'];
    case 'market_search': {
      const query = String(args.query || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
      if (!query) throw new Error('Missing safe search query');
      return ['market', 'search', '--query', query, '--chain', 'sol', '--raw'];
    }
    case 'market_kline': {
      const to = Math.floor(Date.now() / 1000);
      const lookback = Math.max(300, Math.min(86_400, Number(args.lookbackSeconds) || 3600));
      return ['market', 'kline', '--chain', 'sol', '--address', address, '--resolution', String(args.resolution || '5m'), '--from', String(to - lookback), '--to', String(to), '--raw'];
    }
    case 'token_info':
      return ['token', 'info', '--chain', 'sol', '--address', address, '--raw'];
    case 'token_security':
      return ['token', 'security', '--chain', 'sol', '--address', address, '--raw'];
    case 'token_pool':
      return ['token', 'pool', '--chain', 'sol', '--address', address, '--raw'];
    case 'token_holders':
      return ['token', 'holders', '--chain', 'sol', '--address', address, '--limit', String(Math.max(1, Math.min(50, Number(args.limit) || 20))), '--raw'];
    case 'token_traders':
      return ['token', 'traders', '--chain', 'sol', '--address', address, '--limit', String(Math.max(1, Math.min(50, Number(args.limit) || 20))), '--raw'];
    default:
      throw new Error(`GMGN action is not read-only allowlisted: ${action}`);
  }
}

function compact(value, depth = 0) {
  if (depth > 6) return '[depth-truncated]';
  if (typeof value === 'string') return value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, compact(item, depth + 1)]));
  }
  return value;
}

function parseOutput(stdout) {
  const value = String(stdout || '').trim();
  if (!value) return null;
  try { return compact(JSON.parse(value)); } catch { return value.slice(0, 24_000); }
}

async function runAction(action, args) {
  if (!READ_ONLY_ACTIONS.has(action)) throw new Error(`Blocked non-read-only GMGN action: ${action}`);
  const cliArgs = actionArgs(action, args);
  const { stdout, stderr } = await execFileAsync(cliBin(), cliArgs, {
    timeout: timeoutMs(),
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      ...(GMGN_API_KEY ? { GMGN_API_KEY } : {}),
    },
  });
  return {
    action,
    command: ['gmgn-cli', ...cliArgs].join(' '),
    data: parseOutput(stdout),
    notice: String(stderr || '').trim().slice(0, 2000) || null,
  };
}

export async function collectGmgnResearch(question) {
  const plan = buildGmgnResearchPlan(question);
  if (!plan.length) return null;
  if (!enabled()) {
    return { source: 'gmgn-cli', readOnly: true, available: false, reason: 'GMGN_MANAGER_DISABLED', plan };
  }
  if (!GMGN_API_KEY) {
    return { source: 'gmgn-cli', readOnly: true, available: false, reason: 'GMGN_API_KEY_MISSING', plan };
  }

  const results = [];
  for (const step of plan) {
    try {
      results.push({ ok: true, ...(await runAction(step.action, step.args)) });
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 'GMGN_CLI_NOT_INSTALLED' : (error?.code || 'GMGN_QUERY_FAILED');
      results.push({
        ok: false,
        action: step.action,
        code,
        error: String(error?.stderr || error?.message || error).slice(0, 2500),
      });
      if (code === 'GMGN_CLI_NOT_INSTALLED') break;
    }
  }

  return {
    source: 'gmgn-cli',
    readOnly: true,
    generatedAtMs: Date.now(),
    chain: 'sol',
    authority: {
      canQueryMarketData: true,
      canSwap: false,
      canCookOrders: false,
      canManageWallet: false,
      canSign: false,
      canBroadcast: false,
    },
    plan,
    results,
  };
}
