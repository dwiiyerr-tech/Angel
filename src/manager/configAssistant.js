import { setting } from '../db/settings.js';
import {
  CONTROL_PLANE_PROPOSABLE_SETTINGS,
  activeConfigVersion,
  createStrategyProposal,
  openStrategyProposal,
} from '../controlPlane/registry.js';

const ROUTES = new Set([
  'pumpportal_graduated',
  'pumpfun_pregrad',
  'trenches_completed',
  'fee_trending',
  'trending',
  'graduated_trending',
  'dual_source',
]);

export const MANAGER_CONFIG_CATALOG = Object.freeze({
  confidence: {
    key: 'llm_min_confidence',
    label: 'LLM confidence floor',
    unit: 'score',
    examples: ['65', '70', '75'],
  },
  liquidity: {
    key: 'min_liquidity_usd',
    label: 'minimum DEX liquidity',
    unit: 'USD',
    examples: ['5000', '7500', '10k'],
  },
  extreme_bot: {
    key: 'filter_extreme_bot_holders_pct',
    label: 'extreme bot-holder hard veto',
    unit: '%',
    examples: ['60', '70', '80'],
  },
  extreme_dev: {
    key: 'filter_extreme_dev_migrations',
    label: 'extreme developer-migration hard veto',
    unit: 'count',
    examples: ['75', '100', '150'],
  },
  flow_dump: {
    key: 'flow_hard_price_change_pct',
    label: '1h severe-dump hard veto',
    unit: '%',
    examples: ['-8', '-10', '-15'],
  },
  flow_net: {
    key: 'flow_hard_net_buyer_ratio',
    label: '5m severe net-buyer ratio hard veto',
    unit: 'ratio',
    examples: ['0', '0.05', '0.10'],
  },
  opportunity: {
    key: 'min_opportunity_size_multiplier',
    label: 'minimum opportunity/source-weight floor',
    unit: 'multiplier',
    examples: ['0.35', '0.40', '0.50'],
  },
  blocked_routes: {
    key: 'blocked_routes',
    label: 'blocked signal routes',
    unit: 'routes',
    examples: ['trending,graduated_trending', 'trending', 'none'],
  },
});

const KEY_TO_ALIAS = new Map(Object.entries(MANAGER_CONFIG_CATALOG).map(([alias, row]) => [row.key, alias]));

function normalizeNumericToken(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[$,%]/g, '');
  const match = raw.match(/^(-?\d+(?:\.\d+)?)([km])?$/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = String(match[2] || '').toLowerCase();
  if (suffix === 'k') return base * 1_000;
  if (suffix === 'm') return base * 1_000_000;
  return base;
}

function normalizeRoutes(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(none|off|empty|kosong|tidak ada)$/i.test(raw)) return [];
  let parts;
  try {
    const parsed = JSON.parse(raw);
    parts = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    parts = raw.split(/[,+]/);
  }
  const routes = [...new Set(parts.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  for (const route of routes) {
    if (!ROUTES.has(route)) throw new Error(`Unknown route: ${route}`);
  }
  return routes;
}

function resolveAlias(input) {
  const token = String(input || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (MANAGER_CONFIG_CATALOG[token]) return token;
  if (KEY_TO_ALIAS.has(token)) return KEY_TO_ALIAS.get(token);
  const synonyms = new Map([
    ['conf', 'confidence'],
    ['confidence_floor', 'confidence'],
    ['konfidens', 'confidence'],
    ['konfidensi', 'confidence'],
    ['liq', 'liquidity'],
    ['likuiditas', 'liquidity'],
    ['bot_extreme', 'extreme_bot'],
    ['bot_hard', 'extreme_bot'],
    ['dev_migrations', 'extreme_dev'],
    ['dev_extreme', 'extreme_dev'],
    ['dump', 'flow_dump'],
    ['flow_price', 'flow_dump'],
    ['net_buyer', 'flow_net'],
    ['net_buyers', 'flow_net'],
    ['source_weight', 'opportunity'],
    ['opportunity_floor', 'opportunity'],
    ['blocked', 'blocked_routes'],
    ['routes', 'blocked_routes'],
  ]);
  return synonyms.get(token) || null;
}

export function parseConfigValue(alias, rawValue) {
  const row = MANAGER_CONFIG_CATALOG[alias];
  if (!row) throw new Error(`Unsupported config alias: ${alias}`);
  if (row.key === 'blocked_routes') return normalizeRoutes(rawValue);
  const number = normalizeNumericToken(rawValue);
  if (number == null) throw new Error(`Invalid numeric value for ${alias}: ${rawValue}`);
  return number;
}

export function parseExplicitConfigInstruction(text) {
  const value = String(text || '').trim();
  if (!value) return null;

  const slash = value.match(/^\/configset(?:@\w+)?\s+(\S+)\s+(.+)$/i);
  if (slash) {
    const alias = resolveAlias(slash[1]);
    if (!alias) throw new Error(`Unknown config field: ${slash[1]}`);
    return { alias, key: MANAGER_CONFIG_CATALOG[alias].key, value: parseConfigValue(alias, slash[2]), explicit: true };
  }

  // Natural-language mutation is intentionally narrow. Brainstorming phrases
  // such as "what if confidence were 70" must not create proposals accidentally.
  const natural = value.match(/^(?:angel\s+)?(?:config\s+)?(?:set|atur|ubah|ganti)\s+(\S+)\s+(?:ke\s+|jadi\s+|=\s*)?(.+)$/i);
  if (!natural) return null;
  const alias = resolveAlias(natural[1]);
  if (!alias) return null;
  return { alias, key: MANAGER_CONFIG_CATALOG[alias].key, value: parseConfigValue(alias, natural[2]), explicit: true };
}

export function managerConfigSnapshot() {
  const active = activeConfigVersion();
  const open = openStrategyProposal();
  const fields = Object.fromEntries(Object.entries(MANAGER_CONFIG_CATALOG).map(([alias, row]) => {
    const fallback = active?.config?.settings?.[row.key] ?? null;
    const current = setting(row.key, fallback == null ? '' : String(fallback));
    return [alias, {
      key: row.key,
      label: row.label,
      unit: row.unit,
      current: row.key === 'blocked_routes' ? (() => {
        try { return JSON.parse(current || '[]'); } catch { return []; }
      })() : (current === '' ? null : Number(current)),
      examples: row.examples,
      proposable: CONTROL_PLANE_PROPOSABLE_SETTINGS.has(row.key),
    }];
  }));
  return {
    mode: 'proposal_only',
    directMutationAllowed: false,
    activeConfigVersion: active?.version || null,
    openProposal: open ? { id: open.id, status: open.status, proposedVersion: open.proposed_version } : null,
    fields,
  };
}

export function createOwnerConfigProposal({ text, chatId = null } = {}) {
  const parsed = parseExplicitConfigInstruction(text);
  if (!parsed) return null;
  if (!CONTROL_PLANE_PROPOSABLE_SETTINGS.has(parsed.key)) {
    throw new Error(`${parsed.key} is not permitted through Manager config proposals`);
  }
  const active = activeConfigVersion();
  const change = {
    key: parsed.key,
    value: parsed.value,
    rationale: `Explicit authenticated owner instruction via Angel Manager: ${String(text).slice(0, 300)}`,
    evidence: {
      source: 'owner_explicit_command',
      activeConfigVersion: active?.version || null,
    },
  };
  const proposal = createStrategyProposal({
    changes: [change],
    evidence: {
      windowMs: 0,
      totalClosed: 0,
      source: 'owner_explicit_command',
      ownerChatId: chatId == null ? null : String(chatId),
      command: String(text).slice(0, 500),
      activeConfigVersion: active?.version || null,
    },
    analysis: {
      type: 'owner_directed_configuration',
      note: 'Proposal only. Active settings remain unchanged until PAPER challenger evaluation and explicit promotion.',
    },
    source: 'manager_owner_command',
    analystMode: 'owner_explicit',
    actor: 'telegram_owner',
  });
  return { parsed, proposal };
}

export function configAssistantHelpText() {
  return [
    'Manager config assistant is proposal-only. Commands never mutate active settings immediately.',
    ...Object.entries(MANAGER_CONFIG_CATALOG).map(([alias, row]) => `${alias} -> ${row.key} (${row.unit})`),
  ].join('\n');
}
