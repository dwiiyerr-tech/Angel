import assert from 'node:assert/strict';
import fs from 'node:fs';

const positions = fs.readFileSync(new URL('../../src/db/positions.js', import.meta.url), 'utf8');
const router = fs.readFileSync(new URL('../../src/execution/router.js', import.meta.url), 'utf8');
const executor = fs.readFileSync(new URL('../../src/liveExecutor.js', import.meta.url), 'utf8');
const orchestrator = fs.readFileSync(new URL('../../src/pipeline/orchestrator.js', import.meta.url), 'utf8');
const callbacks = fs.readFileSync(new URL('../../src/telegram/callbacks.js', import.meta.url), 'utf8');
const menus = fs.readFileSync(new URL('../../src/telegram/menus.js', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../../src/research/policy.js', import.meta.url), 'utf8');

// The public product exposes exactly PAPER and LIVE. Old Shadow/Confirm names
// survive only as internal compatibility bridges and migration aliases.
assert.match(policy, /PAPER_ALIASES/);
assert.match(policy, /LIVE_ALIASES/);
assert.match(menus, /set:trading_mode:paper/);
assert.match(menus, /set:trading_mode:live/);
assert.doesNotMatch(menus, /set:trading_mode:shadow_live/);
assert.doesNotMatch(menus, /set:trading_mode:confirm/);

// PAPER is routed to the mature zero-capital Research engine before money-grade
// execution. If legacy execution code is reached, its shadow bridge is still
// simulation-only and explicitly cannot broadcast.
assert.match(positions, /if \(mode === 'live'\) return 'confirm'/);
assert.match(positions, /return 'shadow_live'/);
assert.match(router, /if \(mode === 'shadow_live'\)/);
assert.match(router, /assertContractSafetyForMoneyMode/);
assert.match(router, /assertLiveRiskBudget/);
assert.match(router, /simulateJupiterSwap/);
assert.match(router, /broadcast: false/);

const simulateOnly = executor.match(/export async function simulateJupiterSwap[\s\S]*?\n}\n\nexport async function executeJupiterSwap/)?.[0] || '';
assert.match(simulateOnly, /simulateAndValidateTransaction/);
assert.match(simulateOnly, /broadcast: false/);
assert.doesNotMatch(simulateOnly, /jupiterExecute\(/);
assert.doesNotMatch(simulateOnly, /jitoSendTransaction\(/);

// Public LIVE maps internally to the old Confirm branch: a BUY creates a
// pending intent, and only the authenticated intent-confirm callback may reach
// executeConfirmedIntent. Direct manual LIVE BUY is explicitly blocked.
assert.match(orchestrator, /if \(mode === 'confirm'\)/);
assert.match(orchestrator, /createTradeIntent/);
assert.match(orchestrator, /pending_confirmation/);
assert.match(callbacks, /executeConfirmedIntent/);
assert.match(callbacks, /Direct manual BUY is disabled in LIVE/);
assert.doesNotMatch(callbacks, /await executeLiveBuy\(/);

console.log('[two-mode-execution] PAPER no-broadcast and owner-confirmed LIVE entry bridge verified');
