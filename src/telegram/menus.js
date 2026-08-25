import { escapeHtml, fmtPct, fmtSol, fmtUsd } from '../format.js';
import { numSetting, boolSetting, setting, activeStrategy, allStrategies } from '../db/settings.js';
import { openPositionCount, allPositions } from '../db/positions.js';
import { savedWallets } from '../enrichment/wallets.js';
import { gmgnStatusText } from '../enrichment/gmgn.js';
import { formatPosition } from './format.js';
import { ENABLE_LLM, LLM_API_KEY } from '../config.js';
import { configuredTradingMode } from '../research/policy.js';
import { openResearchPositionCount, researchPositionCap, researchReferenceNotionalSol } from '../research/engine.js';

function modeMeta() {
  const mode = configuredTradingMode();
  if (mode === 'live') {
    return {
      key: 'live',
      icon: '🔴',
      name: 'LIVE',
      detail: 'Real funds under owner-approved configuration',
      safety: 'Wallet/signing/broadcast enabled only behind Live Safety gates',
    };
  }
  return {
    key: 'paper',
    icon: '🟢',
    name: 'PAPER',
    detail: '0 SOL paper trading with real Solana market evidence',
    safety: 'Executable quotes + realistic costs; no wallet, signing, or broadcast',
  };
}

function enabledText(value) {
  return value ? 'ON' : 'OFF';
}

function selectedModeLabel(key, label) {
  const active = modeMeta().key === key;
  return `${active ? '✅' : '▫️'} ${label}`;
}

export function menuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🤖 Agent', callback_data: 'menu:agent' },
          { text: '🎯 Strategy', callback_data: 'menu:strategy' },
        ],
        [
          { text: '📍 Positions', callback_data: 'menu:positions' },
          { text: '📊 PnL', callback_data: 'menu:pnl' },
        ],
        [
          { text: '🛡️ Filters', callback_data: 'menu:filters' },
          { text: '👛 Wallets', callback_data: 'menu:wallets' },
        ],
      ],
    },
  };
}

export function filtersText() {
  const strat = activeStrategy();
  return [
    '🛡️ <b>Safety & Market Filters</b>',
    `<i>${escapeHtml(strat.name)} strategy</i>`,
    '',
    '<b>Market gates</b>',
    `• Market cap: ${fmtUsd(strat.min_mcap_usd)} → ${strat.max_mcap_usd > 0 ? fmtUsd(strat.max_mcap_usd) : 'unlimited'}`,
    `• Min holders: ${strat.min_holders || 'off'}`,
    `• Max top-holder share: ${strat.max_top20_holder_percent < 100 ? fmtPct(strat.max_top20_holder_percent) : 'off'}`,
    `• Min creator claim: ${fmtSol(strat.min_fee_claim_sol)} SOL`,
    `• Min trading fees: ${fmtSol(strat.min_gmgn_total_fee_sol)} SOL`,
    `• Min graduated volume: ${fmtUsd(strat.min_graduated_volume_usd)}`,
    strat.max_ath_distance_pct < 0 ? `• Max ATH distance: ${strat.max_ath_distance_pct}%` : null,
    '',
    '<b>Signal quality</b>',
    `• Min sources: ${strat.min_source_count}`,
    `• Fee claim required: ${strat.require_fee_claim ? 'YES' : 'NO'}`,
    `• Saved-wallet holders: ${strat.min_saved_wallet_holders || 'off'}`,
    '',
    '<b>Discovery</b>',
    `• Trending: <b>${enabledText(boolSetting('trending_enabled', true))}</b> · ${escapeHtml(setting('trending_source', 'jupiter')).toUpperCase()}`,
    `• Interval: ${escapeHtml(setting('trending_interval', '5m'))} · Limit: ${numSetting('trending_limit', 100)}`,
    `• GMGN: token ${escapeHtml(gmgnStatusText('token'))} · trend ${escapeHtml(gmgnStatusText('trending'))}`,
    `• Min trend volume: ${fmtUsd(strat.trending_min_volume_usd)} · swaps: ${strat.trending_min_swaps}`,
    `• Max rug: ${fmtPct(strat.trending_max_rug_ratio * 100)} · bundler: ${fmtPct(strat.trending_max_bundler_rate * 100)}`,
  ].filter(Boolean).join('\n');
}

export const numericFilterLabels = {
  min_fee_claim_sol: 'minimum creator fee-claim SOL',
  min_mcap_usd: 'minimum mcap USD',
  max_mcap_usd: 'maximum mcap USD',
  min_gmgn_total_fee_sol: 'minimum total trading fees SOL (GMGN)',
  min_graduated_volume_usd: 'minimum graduated volume USD',
  max_top20_holder_percent: 'maximum holder percent',
  min_saved_wallet_holders: 'minimum saved-wallet holders',
  trending_limit: 'trending result limit',
  trending_min_volume_usd: 'minimum trending volume USD',
  trending_min_swaps: 'minimum trending swaps',
  trending_max_rug_ratio: 'maximum trending rug ratio (0.3 = 30%)',
  trending_max_bundler_rate: 'maximum trending bundler rate (0.5 = 50%)',
};

export const strategyNumericLabels = {
  min_fee_claim_sol: 'minimum creator fee-claim SOL',
  min_mcap_usd: 'minimum mcap USD',
  max_mcap_usd: 'maximum mcap USD',
  min_gmgn_total_fee_sol: 'minimum total trading fees SOL (GMGN)',
  min_graduated_volume_usd: 'minimum graduated volume USD',
  min_holders: 'minimum holders',
  max_top20_holder_percent: 'maximum top holder percent',
  min_saved_wallet_holders: 'minimum saved-wallet holders',
  max_ath_distance_pct: 'maximum ATH distance percent (-40 = 40% below ATH, 0 = off)',
  min_source_count: 'minimum source count',
  token_age_max_ms: 'maximum token age milliseconds',
  trending_min_volume_usd: 'minimum trending volume USD',
  trending_min_swaps: 'minimum trending swaps',
  trending_max_rug_ratio: 'maximum trending rug ratio (0.3 = 30%)',
  trending_max_bundler_rate: 'maximum trending bundler rate (0.5 = 50%)',
  llm_min_confidence: 'LLM minimum confidence percent',
  position_size_sol: 'position size SOL',
  max_open_positions: 'maximum open positions',
  tp_percent: 'take profit percent',
  sl_percent: 'stop loss percent',
  trailing_percent: 'trailing percent',
  partial_tp_at_percent: 'partial TP trigger percent',
  partial_tp_sell_percent: 'partial TP sell percent',
  max_hold_ms: 'maximum hold milliseconds',
};

export function filtersKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎯 Configure Strategy', callback_data: 'menu:strategy' }],
        [
          { text: '🔄 Toggle Trending', callback_data: 'toggle:trending_enabled' },
          { text: '🪐 Jupiter', callback_data: 'set:trending_source:jupiter' },
          { text: '📡 GMGN', callback_data: 'set:trending_source:gmgn' },
        ],
        [
          { text: '5m', callback_data: 'set:trending_interval:5m' },
          { text: '1h', callback_data: 'set:trending_interval:1h' },
          { text: '6h', callback_data: 'set:trending_interval:6h' },
        ],
        [{ text: '← Control Center', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function agentText() {
  const strat = activeStrategy();
  const mode = modeMeta();
  const agentEnabled = boolSetting('agent_enabled', true);
  const llmReady = Boolean(strat.use_llm && ENABLE_LLM && LLM_API_KEY);
  const paperOpen = openResearchPositionCount();
  const paperMax = researchPositionCap();
  const liveOpen = openPositionCount();
  return [
    '🤖 <b>Angel Execution Console</b>',
    '',
    `${mode.icon} <b>${mode.name}</b> · ${mode.detail}`,
    `🛡️ ${mode.safety}`,
    '',
    '<b>Runtime</b>',
    `• Agent: <b>${enabledText(agentEnabled)}</b>`,
    `• Strategy: <b>${escapeHtml(strat.name)}</b>`,
    `• Intelligence: <b>${llmReady ? 'LLM READY' : strat.use_llm ? 'LLM NOT CONFIGURED' : 'RULE-BASED'}</b>`,
    `• Confidence floor: ${fmtPct(strat.llm_min_confidence || numSetting('llm_min_confidence'))}`,
    '',
    '<b>Paper trading laboratory</b>',
    `• Real capital: <b>0 SOL</b>`,
    `• Executable quote probe: ${fmtSol(researchReferenceNotionalSol())} SOL`,
    `• Paper positions: ${paperOpen}/${paperMax}`,
    `• Simulates entry/exit friction, fees, TP/SL, trailing and partial TP`,
    '',
    '<b>Live capital envelope</b>',
    `• Strategy size: ${fmtSol(strat.position_size_sol)} SOL`,
    `• Live positions: ${liveOpen}/${strat.max_open_positions || '∞'}`,
    `• TP / SL: ${fmtPct(strat.tp_percent)} / ${fmtPct(strat.sl_percent)}`,
    `• Trailing: ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'OFF'}`,
    '',
    '<b>Pipeline</b>',
    `• Candidate batch: ${numSetting('llm_candidate_pick_count', 10)}`,
    `• Freshness window: ${Math.round(numSetting('llm_candidate_max_age_ms', 120000) / 1000)}s`,
  ].join('\n');
}

export function agentKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: boolSetting('agent_enabled', true) ? '⏸ Pause Agent' : '▶️ Start Agent', callback_data: 'toggle:agent' }],
        [
          { text: selectedModeLabel('paper', 'Paper'), callback_data: 'set:trading_mode:paper' },
          { text: selectedModeLabel('live', 'Live'), callback_data: 'set:trading_mode:live' },
        ],
        [
          { text: 'Probe .01', callback_data: 'set:research_notional_sol:0.01' },
          { text: 'Probe .05', callback_data: 'set:research_notional_sol:0.05' },
          { text: 'Probe .10', callback_data: 'set:research_notional_sol:0.1' },
        ],
        [
          { text: 'Paper Max 6', callback_data: 'set:research_max_open_positions:6' },
          { text: 'Paper Max 12', callback_data: 'set:research_max_open_positions:12' },
          { text: 'Paper Max 24', callback_data: 'set:research_max_open_positions:24' },
        ],
        [
          { text: 'Live Max 1', callback_data: 'set:max_open_positions:1' },
          { text: 'Live Max 3', callback_data: 'set:max_open_positions:3' },
          { text: 'Live Max 5', callback_data: 'set:max_open_positions:5' },
        ],
        [
          { text: 'Batch 5', callback_data: 'set:llm_candidate_pick_count:5' },
          { text: 'Batch 10', callback_data: 'set:llm_candidate_pick_count:10' },
        ],
        [
          { text: 'Fresh 2m', callback_data: 'set:llm_candidate_max_age_ms:120000' },
          { text: 'Fresh 5m', callback_data: 'set:llm_candidate_max_age_ms:300000' },
          { text: 'Fresh 10m', callback_data: 'set:llm_candidate_max_age_ms:600000' },
        ],
        [{ text: '← Control Center', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function navKeyboard(rows = []) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...rows,
        [{ text: '← Control Center', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function mainMenuText() {
  const strat = activeStrategy();
  const mode = modeMeta();
  const agentEnabled = boolSetting('agent_enabled', true);
  return [
    '👼 <b>ANGEL CONTROL CENTER</b>',
    '<i>Solana trading research + owner-controlled live execution</i>',
    '',
    `${mode.icon} Mode: <b>${mode.name}</b>`,
    `🤖 Agent: <b>${enabledText(agentEnabled)}</b>`,
    `🎯 Strategy: <b>${escapeHtml(strat.name)}</b>`,
    `🧪 Paper: <b>${openResearchPositionCount()}/${researchPositionCap()}</b> · Capital: <b>0 SOL</b>`,
    `📍 Live: <b>${openPositionCount()}/${strat.max_open_positions || '∞'}</b>`,
    '',
    `🛡️ <i>${mode.safety}</i>`,
    '',
    'Select a module below.',
  ].join('\n');
}

export function walletsText() {
  const rows = savedWallets();
  const body = rows.length
    ? rows.map(row => `• <b>${escapeHtml(row.label)}</b>\n  <code>${escapeHtml(row.address)}</code>`).join('\n\n')
    : 'No wallets saved.\nUse <code>/walletadd &lt;label&gt; &lt;address&gt;</code>.';
  return `👛 <b>Wallet Monitor</b>\n\n${body}`;
}

export function positionsText() {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No positions recorded yet.';
  return `📍 <b>Position Monitor</b>\n\n${text}`;
}

export function strategyMenuText() {
  const strat = activeStrategy();
  const all = allStrategies();
  const entryIcons = { immediate: '⚡', wait_for_dip: '📉', after_confirmation: '🧠' };
  return [
    '🎯 <b>Strategy Console</b>',
    '',
    `Active strategy: <b>${escapeHtml(strat.name)}</b>`,
    `Entry model: ${entryIcons[strat.entry_mode] || '•'} ${escapeHtml(strat.entry_mode)}`,
    '',
    '<b>Execution profile</b>',
    `• Size: ${fmtSol(strat.position_size_sol)} SOL`,
    `• Max positions: ${strat.max_open_positions}`,
    `• TP / SL: ${fmtPct(strat.tp_percent)} / ${fmtPct(strat.sl_percent)}`,
    `• Trailing: ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'OFF'}`,
    strat.partial_tp ? `• Partial TP: ${strat.partial_tp_sell_percent}% at ${fmtPct(strat.partial_tp_at_percent)}` : null,
    strat.max_hold_ms > 0 ? `• Max hold: ${Math.round(strat.max_hold_ms / 60000)}m` : null,
    '',
    '<b>Qualification</b>',
    `• Min sources: ${strat.min_source_count}`,
    `• Min holders: ${strat.min_holders || 'off'}`,
    `• Fee claim required: ${strat.require_fee_claim ? 'YES' : 'NO'}`,
    strat.max_ath_distance_pct < 0 ? `• Max ATH distance: ${strat.max_ath_distance_pct}%` : null,
    `• Win cooldown: ${strat.win_block_days ?? 'default'} days`,
    `• Decision engine: ${strat.use_llm ? `LLM ≥ ${strat.llm_min_confidence}%` : 'Rule-based'}`,
    '',
    '<b>Available strategies</b>',
    ...all.map(s => `${s.enabled ? '▶️' : '▫️'} ${escapeHtml(s.name)}`),
  ].filter(Boolean).join('\n');
}

export function strategyKeyboard() {
  const strat = activeStrategy();
  const all = allStrategies();
  const selector = all.map(s => [{
    text: `${s.enabled ? '✅ ' : ''}${s.name}`,
    callback_data: `strategy:select:${s.id}`,
  }]);
  const config = [
    [
      { text: `TP +${strat.tp_percent}%`, callback_data: 'stratinput:tp_percent' },
      { text: `SL ${strat.sl_percent}%`, callback_data: 'stratinput:sl_percent' },
    ],
    [
      { text: `Size ${strat.position_size_sol} SOL`, callback_data: 'stratinput:position_size_sol' },
      { text: `Max ${strat.max_open_positions}`, callback_data: 'stratinput:max_open_positions' },
    ],
    [
      { text: `Min Mcap ${strat.min_mcap_usd > 0 ? fmtUsd(strat.min_mcap_usd) : 'off'}`, callback_data: 'stratinput:min_mcap_usd' },
      { text: `Max Mcap ${strat.max_mcap_usd > 0 ? fmtUsd(strat.max_mcap_usd) : 'off'}`, callback_data: 'stratinput:max_mcap_usd' },
    ],
    [
      { text: `Trail ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`, callback_data: 'stratinput:trailing_percent' },
      { text: `Min Src ${strat.min_source_count}`, callback_data: 'stratinput:min_source_count' },
    ],
    [
      { text: `Fee Req ${strat.require_fee_claim ? 'on' : 'off'}`, callback_data: 'stratcfg:require_fee_claim' },
      { text: `LLM ${strat.use_llm ? 'on' : 'off'}`, callback_data: 'stratcfg:use_llm' },
    ],
    [
      { text: `Min Holders ${strat.min_holders}`, callback_data: 'stratinput:min_holders' },
      { text: `Conf ${strat.llm_min_confidence}%`, callback_data: 'stratinput:llm_min_confidence' },
    ],
    [
      { text: `Win Block ${strat.win_block_days ?? 'def'}d`, callback_data: 'stratinput:win_block_days' },
      { text: `Max Hold ${strat.max_hold_ms > 0 ? Math.round(strat.max_hold_ms / 60000) + 'm' : 'off'}`, callback_data: 'stratinput:max_hold_ms' },
    ],
    [{ text: `Partial TP ${strat.partial_tp ? 'on' : 'off'}`, callback_data: 'stratcfg:partial_tp' }],
    [
      { text: `Claim ${fmtSol(strat.min_fee_claim_sol)} SOL`, callback_data: 'stratinput:min_fee_claim_sol' },
      { text: `Fees ${fmtSol(strat.min_gmgn_total_fee_sol)} SOL`, callback_data: 'stratinput:min_gmgn_total_fee_sol' },
    ],
    [
      { text: `Grad Vol ${fmtUsd(strat.min_graduated_volume_usd)}`, callback_data: 'stratinput:min_graduated_volume_usd' },
      { text: `Max Holder ${strat.max_top20_holder_percent < 100 ? fmtPct(strat.max_top20_holder_percent) : 'off'}`, callback_data: 'stratinput:max_top20_holder_percent' },
    ],
    [
      { text: `Saved ${strat.min_saved_wallet_holders || 'off'}`, callback_data: 'stratinput:min_saved_wallet_holders' },
      { text: `ATH ${strat.max_ath_distance_pct < 0 ? `${strat.max_ath_distance_pct}%` : 'off'}`, callback_data: 'stratinput:max_ath_distance_pct' },
    ],
    [
      { text: `Age ${strat.token_age_max_ms > 0 ? Math.round(strat.token_age_max_ms / 60000) + 'm' : 'off'}`, callback_data: 'stratinput:token_age_max_ms' },
      { text: `Trend Vol ${fmtUsd(strat.trending_min_volume_usd)}`, callback_data: 'stratinput:trending_min_volume_usd' },
    ],
    [
      { text: `Trend Swaps ${strat.trending_min_swaps}`, callback_data: 'stratinput:trending_min_swaps' },
      { text: `Max Rug ${fmtPct(strat.trending_max_rug_ratio * 100)}`, callback_data: 'stratinput:trending_max_rug_ratio' },
    ],
    [
      { text: `Max Bundler ${fmtPct(strat.trending_max_bundler_rate * 100)}`, callback_data: 'stratinput:trending_max_bundler_rate' },
      { text: `Partial Sell ${strat.partial_tp_sell_percent}%`, callback_data: 'stratinput:partial_tp_sell_percent' },
    ],
    [{ text: `Partial At ${strat.partial_tp_at_percent}%`, callback_data: 'stratinput:partial_tp_at_percent' }],
  ];
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '── Strategy Selection ──', callback_data: 'noop' }],
        ...selector,
        [{ text: '── Risk & Execution ──', callback_data: 'noop' }],
        ...config,
        [{ text: '← Control Center', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function candidateButtons(candidateId, decision = null) {
  const verdict = String(decision?.verdict || '').toUpperCase();
  if (verdict && verdict !== 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: `⏭ ${verdict}`, callback_data: 'noop' }],
          [
            { text: '🔎 Candidate', callback_data: `cand:${candidateId}` },
            { text: '✖ Ignore', callback_data: `ign:${candidateId}` },
          ],
          [{ text: '📍 Positions', callback_data: 'menu:positions' }],
        ],
      },
    };
  }
  if (verdict === 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ BUY selected by decision engine', callback_data: 'noop' }],
          [
            { text: '🔎 Candidate', callback_data: `cand:${candidateId}` },
            { text: '📍 Positions', callback_data: 'menu:positions' },
          ],
          [
            { text: '🎚 TP / SL', callback_data: `tpsl:c:${candidateId}` },
            { text: '✖ Ignore', callback_data: `ign:${candidateId}` },
          ],
        ],
      },
    };
  }
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔎 Candidate', callback_data: `cand:${candidateId}` },
          { text: '🧪 Manual Test', callback_data: `buy:${candidateId}` },
        ],
        [
          { text: '🎚 TP / SL', callback_data: `tpsl:c:${candidateId}` },
          { text: '✖ Ignore', callback_data: `ign:${candidateId}` },
        ],
        [{ text: '📍 Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export function batchRevealButtons(batchId, rows, decision, triggerCandidateId = null) {
  const selectedId = Number(decision.selected_candidate_id || 0);
  const triggerId = Number(triggerCandidateId || 0);
  const keyboard = [];
  if (selectedId) keyboard.push([{ text: '🏆 Selected Candidate', callback_data: `cand:${selectedId}` }]);
  keyboard.push([{ text: '🧠 Decision Batch', callback_data: `batch:${batchId}` }]);
  if (triggerId && triggerId !== selectedId) keyboard.push([{ text: '⚡ Trigger Candidate', callback_data: `cand:${triggerId}` }]);
  keyboard.push([{ text: '📍 Positions', callback_data: 'menu:positions' }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

export function positionButtons(positionId) {
  const noBroadcast = modeMeta().key === 'paper';
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: noBroadcast ? '🧪 Close Paper Position' : '🚪 Close Live Position', callback_data: `sell:${positionId}` },
          { text: '🔄 Refresh', callback_data: `pos:${positionId}` },
        ],
        [
          { text: 'TP +25%', callback_data: `tp:${positionId}:25` },
          { text: 'TP +50%', callback_data: `tp:${positionId}:50` },
        ],
        [
          { text: 'SL -15%', callback_data: `sl:${positionId}:-15` },
          { text: 'SL -25%', callback_data: `sl:${positionId}:-25` },
        ],
        [{ text: '📈 Toggle Trailing', callback_data: `trail:${positionId}` }],
      ],
    },
  };
}

// Kept only for old pending intent messages created before the two-mode migration.
export function intentButtons(intentId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve Legacy Buy', callback_data: `intent:${intentId}:confirm` },
          { text: '✖ Reject', callback_data: `intent:${intentId}:reject` },
        ],
        [{ text: '📍 Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export async function sendTpSlDefaults(chatId, query = null) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'TP +25%', callback_data: 'set:default_tp_percent:25' },
          { text: 'TP +50%', callback_data: 'set:default_tp_percent:50' },
        ],
        [
          { text: 'SL -15%', callback_data: 'set:default_sl_percent:-15' },
          { text: 'SL -25%', callback_data: 'set:default_sl_percent:-25' },
        ],
        [
          { text: 'Trailing ON', callback_data: 'set:default_trailing_enabled:true' },
          { text: 'Trailing OFF', callback_data: 'set:default_trailing_enabled:false' },
        ],
        [{ text: '← Control Center', callback_data: 'menu:main' }],
      ],
    },
  };
  if (query) return editMenuMessage(query, agentText(), keyboard);
  const { bot } = await import('./bot.js');
  await bot.sendMessage(chatId, agentText(), { parse_mode: 'HTML', ...keyboard });
}

async function editMenuMessage(query, text, extra = {}) {
  const { TELEGRAM_CHAT_ID } = await import('../config.js');
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  const { bot } = await import('./bot.js');
  if (!messageId) {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
}
