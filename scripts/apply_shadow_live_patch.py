from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'expected block not found in {path}: {old[:100]!r}')
    got = text.count(old)
    if got < count:
        raise SystemExit(f'expected >= {count} matches in {path}, got {got}')
    p.write_text(text.replace(old, new, count))

replace('src/db/positions.js',
    "return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';",
    "return ['dry_run', 'shadow_live', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';")
replace('src/db/positions.js',
    "export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy', entryQuote = null) {",
    "export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy', entryQuote = null, executionMode = 'dry_run') {")
replace('src/db/positions.js',
    "        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, entry_fee_sol, snapshot_json\n      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
    "        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, execution_mode, strategy_id, entry_fee_sol, snapshot_json\n      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)")
replace('src/db/positions.js',
    "      decision.id || null,\n      strat.id,\n      entryFeeSol,",
    "      decision.id || null,\n      executionMode,\n      strat.id,\n      entryFeeSol,", 1)
replace('src/db/positions.js',
    "        simulatorVersion: DRY_RUN_SIMULATOR_VERSION,\n        entryQuoteMode: entryQuote ? 'position_sized' : 'fallback_mark',",
    "        simulatorVersion: DRY_RUN_SIMULATOR_VERSION,\n        executionMode,\n        shadowLiveCompatible: executionMode === 'shadow_live',\n        entryQuoteMode: entryQuote ? 'position_sized' : 'fallback_mark',")

replace('src/liveExecutor.js',
    "export async function executeJupiterSwap({ inputMint, outputMint, amount }) {\n  const order = await jupiterOrder({ inputMint, outputMint, amount });",
    "export async function simulateJupiterSwap({ inputMint, outputMint, amount }) {\n  const order = await jupiterOrder({ inputMint, outputMint, amount });\n  const transaction = orderTransactionBase64(order);\n  if (!transaction) throw new Error('Jupiter order did not include a transaction.');\n  const signed = signTransaction(transaction);\n  await simulateAndValidateTransaction(signed.tx, { inputMint, outputMint, amount });\n  return {\n    order,\n    simulated: true,\n    broadcast: false,\n    inputAmount: String(amount),\n    outputAmount: String(order?.outAmount || order?.outputAmount || order?.outAmountResult || ''),\n  };\n}\n\nexport async function executeJupiterSwap({ inputMint, outputMint, amount }) {\n  const order = await jupiterOrder({ inputMint, outputMint, amount });")

replace('src/execution/router.js',
    "import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';",
    "import { executeJupiterSwap, simulateJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';")
replace('src/execution/router.js',
    "import { calculatePositionSizeSol, createLivePosition, liveEntryBlockReason, openPositionCount, tradingMode, tryReservePositionSlot, decrementPendingPosition, riskRewardBlockReason, riskRewardRatio } from '../db/positions.js';",
    "import { calculatePositionSizeSol, createDryRunPosition, createLivePosition, liveEntryBlockReason, openPositionCount, tradingMode, tryReservePositionSlot, decrementPendingPosition, riskRewardBlockReason, riskRewardRatio } from '../db/positions.js';")
replace('src/execution/router.js',
    "import { refreshCandidateForExecution } from './positions.js';",
    "import { refreshCandidateForExecution } from './positions.js';\nimport { fetchDryRunEntryQuote } from '../enrichment/jupiter.js';")
marker = "export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {"
shadow_fn = r'''export async function executeShadowLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const strat = activeStrategy();
  const candidate = selectedRow.candidate;
  assertSafeLiveDecision(decision, strat);
  await assertContractSafetyForMoneyMode(candidate, { stage: 'pre_execution' });
  const blocked = liveEntryBlockReason(candidate.token.mint, strat);
  if (blocked) throw new Error(`Shadow-live buy blocked before simulation: ${blocked}`);
  const scaledSizeSol = calculatePositionSizeSol(candidate, decision, strat);
  const amountLamports = Math.floor(scaledSizeSol * 1_000_000_000);
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0 || scaledSizeSol > LIVE_MAX_POSITION_SOL) {
    throw new Error(`Unsafe shadow-live position size: ${scaledSizeSol} SOL (cap ${LIVE_MAX_POSITION_SOL})`);
  }
  assertLiveRiskBudget(scaledSizeSol);
  assertLossStreakAllowed('live');
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error('Shadow-live insufficient SOL balance for realistic simulation including reserve.');
  }
  if (amountLamports > balance * LIVE_MAX_WALLET_FRACTION) {
    throw new Error(`Shadow-live position exceeds ${(LIVE_MAX_WALLET_FRACTION * 100).toFixed(0)}% wallet cap.`);
  }
  const simulation = await simulateJupiterSwap({ inputMint: WSOL_MINT, outputMint: candidate.token.mint, amount: amountLamports });
  const entryQuote = await fetchDryRunEntryQuote(
    candidate.token.mint,
    scaledSizeSol,
    candidate.jupiterAsset?.decimals,
    candidate.metrics?.priceUsd,
    candidate.metrics?.marketCapUsd,
  );
  if (!entryQuote?.outputAmountRaw) {
    throw new Error('Shadow-live requires a position-sized executable entry quote; fallback mark is disabled.');
  }
  const created = createDryRunPosition(selectedRow.id, candidate, decision, `shadow_live_batch_${batchId}`, entryQuote, 'shadow_live');
  logDecisionEvent({
    batchId, triggerCandidateId, selectedRow, rows, decision,
    mode: 'shadow_live',
    action: created.isNew ? 'shadow_live_entry_simulated' : `shadow_live_blocked_${created.blockedBy || 'duplicate'}`,
    guardrails: { amountLamports, balanceLamports: balance, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS, broadcast: false },
    execution: { positionId: created.id, isNew: created.isNew, simulation },
  });
  if (created.isNew) await sendPositionOpen(created.id);
  return { ...created, simulation };
}

'''
replace('src/execution/router.js', marker, shadow_fn + marker)

replace('src/pipeline/orchestrator.js',
    "import { executeLiveBuy } from '../execution/router.js';",
    "import { executeLiveBuy, executeShadowLiveBuy } from '../execution/router.js';")
replace('src/pipeline/orchestrator.js',
    "  if (mode === 'confirm') {",
    "  if (mode === 'shadow_live') {\n    await executeShadowLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);\n    return;\n  }\n\n  if (mode === 'confirm') {")

replace('src/pipeline/llm.js',
    "'You are Angel, a Solana meme coin entry screener operating in dry-run mode.',",
    "'You are Angel, a Solana meme coin entry screener. Judge market opportunity independently of execution mode.',")
replace('src/pipeline/llm.js',
    "task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',",
    "task: 'Pick the best buy candidate from this recent batch, or choose none.',")

p = Path('src/pipeline/tradeMemory.js')
text = p.read_text()
old = "FROM dry_run_positions\n      WHERE status = 'closed' AND closed_at_ms > ?"
new = "FROM dry_run_positions\n      WHERE status = 'closed' AND execution_mode = 'shadow_live'\n        AND json_extract(snapshot_json, '$.shadowLiveCompatible') = 1\n        AND json_extract(snapshot_json, '$.simulatorVersion') = 'quote_sized_v3'\n        AND closed_at_ms > ?"
if text.count(old) != 2:
    raise SystemExit(f'tradeMemory expected 2 query matches, got {text.count(old)}')
p.write_text(text.replace(old, new))

replace('src/learning/summary.js',
    "AND COALESCE(execution_mode, 'dry_run') = 'dry_run'\n      AND json_extract(snapshot_json, '$.simulatorVersion') = ?",
    "AND execution_mode = 'shadow_live'\n      AND json_extract(snapshot_json, '$.shadowLiveCompatible') = 1\n      AND json_extract(snapshot_json, '$.simulatorVersion') = ?")
replace('src/pipeline/llmCalibrator.js',
    "WHERE l.verdict = 'BUY' AND p.status = 'closed' AND l.created_at_ms > ?\n        AND json_extract(p.snapshot_json, '$.simulatorVersion') = ?",
    "WHERE l.verdict = 'BUY' AND p.status = 'closed' AND p.execution_mode = 'shadow_live'\n        AND json_extract(p.snapshot_json, '$.shadowLiveCompatible') = 1\n        AND l.created_at_ms > ?\n        AND json_extract(p.snapshot_json, '$.simulatorVersion') = ?")
replace('src/learning/evaluation.js',
    "WHERE p.status = 'closed' AND d.created_at_ms >= ?",
    "WHERE p.status = 'closed' AND p.execution_mode = 'shadow_live'\n      AND json_extract(p.snapshot_json, '$.shadowLiveCompatible') = 1\n      AND json_extract(p.snapshot_json, '$.simulatorVersion') = 'quote_sized_v3'\n      AND d.created_at_ms >= ?")
replace('src/learning/simulatorVersion.js',
    "export const MAX_ENTRY_QUOTE_FALLBACK_RATE = 0.2;",
    "export const MAX_ENTRY_QUOTE_FALLBACK_RATE = 0;")
replace('src/learning/commands.js',
    "A candidate needs 7 days and at least 50 closed dry-run trades.",
    "A candidate needs 7 days and at least 50 closed shadow-live-compatible trades.")

Path('test/unit/test_shadow_live_mode.js').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';

const positions = fs.readFileSync(new URL('../../src/db/positions.js', import.meta.url), 'utf8');
const router = fs.readFileSync(new URL('../../src/execution/router.js', import.meta.url), 'utf8');
const executor = fs.readFileSync(new URL('../../src/liveExecutor.js', import.meta.url), 'utf8');
const orchestrator = fs.readFileSync(new URL('../../src/pipeline/orchestrator.js', import.meta.url), 'utf8');
const memory = fs.readFileSync(new URL('../../src/pipeline/tradeMemory.js', import.meta.url), 'utf8');
const summary = fs.readFileSync(new URL('../../src/learning/summary.js', import.meta.url), 'utf8');
const simulator = fs.readFileSync(new URL('../../src/learning/simulatorVersion.js', import.meta.url), 'utf8');
const llm = fs.readFileSync(new URL('../../src/pipeline/llm.js', import.meta.url), 'utf8');

assert.match(positions, /'shadow_live'/);
assert.match(orchestrator, /mode === 'shadow_live'/);
assert.match(orchestrator, /executeShadowLiveBuy/);
assert.match(router, /simulateJupiterSwap/);
assert.match(router, /fallback mark is disabled/);
assert.match(executor, /broadcast: false/);
assert.doesNotMatch(executor.match(/export async function simulateJupiterSwap[\s\S]*?\n}\n\nexport async function executeJupiterSwap/)?.[0] || '', /jupiterExecute\(/);
assert.match(memory, /execution_mode = 'shadow_live'/);
assert.match(memory, /shadowLiveCompatible/);
assert.match(summary, /execution_mode = 'shadow_live'/);
assert.match(simulator, /MAX_ENTRY_QUOTE_FALLBACK_RATE = 0/);
assert.doesNotMatch(llm, /operating in dry-run mode/);
console.log('shadow-live parity invariants passed');
''')
