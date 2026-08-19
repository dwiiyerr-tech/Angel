import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, json } from '../utils.js';
import { escapeHtml, fmtPct } from '../format.js';
import { db } from '../db/connection.js';
import { numSetting, boolSetting, setSetting, activeStrategy, setActiveStrategy, strategyById, updateStrategyConfig } from '../db/settings.js';
import { candidateById, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  positionsText,
  candidateButtons,
  positionButtons,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { sendTelegram, sendBatch, sendPositionOpen } from './send.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { approveLesson, rejectLesson, runLearning, sendLessons } from '../learning/commands.js';
import { fetchWalletPnl } from '../enrichment/wallets.js';
import { sendDailyReport } from './dailyReport.js';
import { runBackup, getBackupStatus } from '../db/backup.js';
import { runLLMCalibration } from '../pipeline/llmCalibrator.js';
import { setting } from '../db/settings.js';
import { approveLiveConfigSnapshot, approvedLiveConfig, createLiveConfigSnapshot, liveConfigChecksum } from '../db/liveConfig.js';

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    console.warn(`[telegram] ignored unauthorized chat ${chatId}`);
    return;
  }
  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/strategy')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    if (!id) {
      return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
    const valid = ['sniper', 'dip_buy', 'smart_money', 'degen'];
    if (!valid.includes(id)) {
      return bot.sendMessage(chatId, `Unknown strategy. Valid: ${valid.join(', ')}`);
    }
    setActiveStrategy(id);
    return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
  }
  if (text.startsWith('/stratset')) {
    const parts = text.split(/\s+/);
    const [, id, key, ...rest] = parts;
    const value = rest.join(' ');
    if (!id || !key || !value) {
      return bot.sendMessage(chatId, 'Usage: /stratset <strategy_id> <key> <value>\n\nExample: /stratset sniper tp_percent 75\n\nKeys: tp_percent, sl_percent, position_size_sol, max_open_positions, min_mcap_usd, max_mcap_usd, min_holders, trailing_enabled, trailing_percent, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, max_hold_ms, use_llm, llm_min_confidence, min_source_count, require_fee_claim, min_fee_claim_sol, min_gmgn_total_fee_sol, max_ath_distance_pct, win_block_days');
    }
    const strat = strategyById(id);
    if (!strat) return bot.sendMessage(chatId, `Strategy "${id}" not found.`);
    const numKeys = new Set(['tp_percent', 'sl_percent', 'position_size_sol', 'max_open_positions', 'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent', 'trailing_percent', 'partial_tp_at_percent', 'partial_tp_sell_percent', 'max_hold_ms', 'llm_min_confidence', 'min_source_count', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct', 'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'min_saved_wallet_holders', 'min_graduated_volume_usd', 'win_block_days']);
    const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim']);
    const newConfig = { ...strat };
    delete newConfig.id;
    delete newConfig.name;
    if (numKeys.has(key)) {
      newConfig[key] = Number(value);
    } else if (boolKeys.has(key)) {
      newConfig[key] = value === 'true' || value === '1' || value === 'yes';
    } else {
      newConfig[key] = value;
    }
    updateStrategyConfig(id, newConfig);
    return bot.sendMessage(chatId, `Updated ${id}.${key} = ${value}\n\n${strategyMenuText()}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/report')) return sendDailyReport(chatId);
  if (text.startsWith('/backup')) {
    try {
      const backupPath = await runBackup();
      const status = getBackupStatus();
      const filename = backupPath.split('/').pop();
      return bot.sendMessage(chatId, `✅ Backup created: ${filename} (${status.size_mb}MB)\n\nLast 3 backups:\n${status.recent.join('\n')}`);
    } catch (e) {
      return bot.sendMessage(chatId, `🔴 Database Backup Failed: ${e.message}`);
    }
  }
  if (text.startsWith('/status')) {
    const backup = getBackupStatus();
    const mode = setting('trading_mode') || 'dry_run';
    const macro = setting('current_macro_state') || 'UNKNOWN';
    let cal = 'No calibration data';
    try {
      cal = await runLLMCalibration() || cal;
    } catch (e) {}
    
    return bot.sendMessage(chatId, `🤖 <b>System Status</b>\n\nMode: ${mode}\nMacro: ${macro}\n\n<b>LLM Calibration:</b>\n${cal}\n\n<b>Backup:</b>\nLast: ${backup.last_backup || 'None'} (${backup.size_mb}MB)`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/mutations')) {
    const mutations = db.prepare('SELECT * FROM parameter_mutation_history ORDER BY id DESC LIMIT 10').all();
    if (!mutations.length) return bot.sendMessage(chatId, 'No recent mutations.');
    const lines = mutations.map(m => {
      const status = m.rolled_back ? '❌ ROLLED BACK' : '✅ ACTIVE';
      return `• ${m.param_key}: ${m.old_value} → ${m.new_value} [${status}]`;
    });
    return bot.sendMessage(chatId, `🧬 <b>Recent Mutations</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/livestatus')) {
    const approved = approvedLiveConfig();
    const checksum = liveConfigChecksum();
    const unresolved = db.prepare("SELECT count(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get().count;
    return bot.sendMessage(chatId, [
      '🔐 <b>Live Configuration</b>',
      '',
      `Current checksum: <code>${checksum}</code>`,
      `Approved snapshot: ${approved ? `#${approved.id}` : 'none'}`,
      `Mode: ${escapeHtml(setting('trading_mode', 'dry_run'))}`,
      `Unresolved executions: ${unresolved}`,
      `Circuit breaker: ${escapeHtml(setting('live_circuit_breaker_open', 'false'))}`,
    ].join('\n'), { parse_mode: 'HTML' });
  }
  if (text.startsWith('/liveapprove')) {
    const [, actionOrId, checksum] = text.split(/\s+/);
    if (actionOrId === 'create') {
      if (setting('trading_mode', 'dry_run') !== 'dry_run') {
        return bot.sendMessage(chatId, 'Switch to dry_run before creating a live snapshot.');
      }
      const snapshot = createLiveConfigSnapshot();
      return bot.sendMessage(chatId, [
        `🔐 Live snapshot #${snapshot.id} created.`,
        '',
        `<code>${snapshot.checksum}</code>`,
        '',
        `Review it, then approve with:`,
        `<code>/liveapprove ${snapshot.id} ${snapshot.checksum}</code>`,
      ].join('\n'), { parse_mode: 'HTML' });
    }
    const id = Number(actionOrId);
    if (!Number.isInteger(id) || !checksum) {
      return bot.sendMessage(chatId, 'Usage: /liveapprove create OR /liveapprove <id> <full-checksum>');
    }
    try {
      const approved = approveLiveConfigSnapshot(id, checksum);
      return bot.sendMessage(chatId, `✅ Snapshot #${approved.id} approved. Live mode may now be enabled while its checksum remains unchanged.`);
    } catch (error) {
      return bot.sendMessage(chatId, `❌ Approval failed: ${error.message}`);
    }
  }
  if (text.startsWith('/circuitreset')) {
    if (setting('trading_mode', 'dry_run') !== 'dry_run') {
      return bot.sendMessage(chatId, 'Circuit reset requires trading_mode=dry_run.');
    }
    const unresolved = db.prepare("SELECT count(*) AS count FROM execution_operations WHERE status IN ('pending', 'outcome_unknown')").get().count;
    if (unresolved > 0) return bot.sendMessage(chatId, `Cannot reset: ${unresolved} unresolved execution(s).`);
    setSetting('live_circuit_breaker_open', 'false');
    return bot.sendMessage(chatId, '✅ Circuit breaker reset in dry_run. Create and approve a fresh live snapshot before live/confirm execution.');
  }
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/executions')) {
    const rows = db.prepare(`
      SELECT id, mint, side, status, signature, error, updated_at_ms
      FROM execution_operations ORDER BY id DESC LIMIT 10
    `).all();
    const lines = rows.map(row => `#${row.id} ${row.side.toUpperCase()} ${escapeHtml(row.mint.slice(0, 10))}… [${escapeHtml(row.status)}]${row.signature ? ` sig:${escapeHtml(row.signature.slice(0, 12))}…` : ''}${row.error ? `\n${escapeHtml(row.error.slice(0, 160))}` : ''}`);
    return bot.sendMessage(chatId, `💸 <b>Execution Ledger</b>\n\n${lines.join('\n\n') || 'No execution operations.'}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/lessonapprove')) {
    const id = Number(text.split(/\s+/)[1]);
    if (!Number.isInteger(id)) return bot.sendMessage(chatId, 'Usage: /lessonapprove <id>');
    return bot.sendMessage(chatId, approveLesson(id)
      ? `✅ Lesson #${id} approved for LLM context (expires after 30 days).`
      : `Lesson #${id} is not an approval-ready candidate.`);
  }
  if (text.startsWith('/lessonreject')) {
    const id = Number(text.split(/\s+/)[1]);
    if (!Number.isInteger(id)) return bot.sendMessage(chatId, 'Usage: /lessonreject <id>');
    return bot.sendMessage(chatId, rejectLesson(id)
      ? `Rejected lesson #${id}.`
      : `Lesson #${id} is not an approval-ready candidate.`);
  }
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    return bot.sendMessage(chatId, `Saved wallet ${label}.`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
    const valid = new Set([
      'min_fee_claim_sol',
      'min_mcap_usd',
      'max_mcap_usd',
      'min_gmgn_total_fee_sol',
      'min_graduated_volume_usd',
      'max_top20_holder_percent',
      'min_saved_wallet_holders',
      'trending_enabled',
      'trending_source',
      'trending_allow_degen',
      'trending_interval',
      'trending_limit',
      'trending_order_by',
      'trending_min_volume_usd',
      'trending_min_swaps',
      'trending_max_rug_ratio',
      'trending_max_bundler_rate',
      'trading_mode',
      'llm_min_confidence',
      'llm_candidate_pick_count',
      'llm_candidate_max_age_ms',
      'max_open_positions',
      'dry_run_buy_sol',
      'default_tp_percent',
      'default_sl_percent',
      'default_trailing_enabled',
      'default_trailing_percent',
    ]);
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId) {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No dry-run positions yet.';
  await bot.sendMessage(chatId, `📍 <b>Positions</b>\n\n${text}`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

export async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, exit_signature = ?
    WHERE id = ?
  `).run(now(), price, mcap, reason, pnlPercent, pnlSol, sell?.signature || null, id);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent, pnlSol, sell }));
  const label = row.execution_mode === 'live' ? 'Closed live position' : 'Closed dry-run position';
  await bot.sendMessage(chatId, `${label} #${id}: ${escapeHtml(reason)} ${fmtPct(pnlPercent)}`, { parse_mode: 'HTML' });
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id, query);
}

export async function toggleTrailing(chatId, id, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id, query);
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Angel menu' },
    { command: 'strategy', description: 'Show/switch strategy' },
    { command: 'stratset', description: 'Set strategy config (stratset id key value)' },
    { command: 'positions', description: 'Show dry-run positions' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'pnl', description: 'Show saved-wallet PnL' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
    { command: 'backup', description: 'Create SQLite backup' },
    { command: 'status', description: 'Show system status and LLM calibration' },
    { command: 'mutations', description: 'List recent mutations' },
    { command: 'livestatus', description: 'Show live configuration approval' },
    { command: 'liveapprove', description: 'Create/approve a live snapshot' },
    { command: 'executions', description: 'Show durable execution ledger' },
    { command: 'circuitreset', description: 'Reset latched breaker in dry_run' },
    { command: 'lessonapprove', description: 'Approve an LLM lesson candidate' },
    { command: 'lessonreject', description: 'Reject an LLM lesson candidate' },
  ]).catch(err => {
    const msg = err?.message || String(err);
    if (!msg.includes('EFATAL') && !msg.includes('AggregateError')) {
      console.log(`[telegram] command registration failed: ${msg}`);
    }
  });

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await bot.sendMessage(chatId, mainMenuText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

async function sendPnl(chatId, query = null) {
  const wallets = savedWallets();
  if (!wallets.length) {
    const text = '📊 <b>PnL</b>\n\nNo saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;.';
    return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }
  const chunks = [];
  for (const wallet of wallets) {
    const pnl = await fetchWalletPnl(wallet.address).catch(() => null);
    if (!pnl) {
      chunks.push(`• <b>${escapeHtml(wallet.label)}</b>: no data`);
      continue;
    }
    chunks.push([
      `• <b>${escapeHtml(wallet.label)}</b>`,
      `Win: ${fmtPct(pnl.winRate)} · PnL: ${fmtPct(pnl.totalPnlPercent)}`,
      `Trades: ${pnl.totalTrades} · Wins: ${pnl.wins}`,
    ].join('\n'));
  }
  const text = `📊 <b>PnL</b>\n\n${chunks.join('\n\n')}`;
  return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}
