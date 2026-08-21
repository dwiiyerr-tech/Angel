import assert from 'node:assert/strict';
import { validateSimulatedSwapEffects } from '../../src/execution/swapValidation.js';
import { WSOL_MINT } from '../../src/config.js';

console.log('[test_live_executor_semantics] Starting simulated swap semantic tests...');

// These cases validate wallet effects before a signed Jupiter transaction is
// broadcast, so any unexpected asset debit must fail closed at simulation time.
// This suite is also the final integration gate after syncing onto main.
const inputMint = 'InputMint111111111111111111111111111111111';
const outputMint = 'OutputMint11111111111111111111111111111111';
const unrelatedMint = 'OtherMint111111111111111111111111111111111';

function snapshot({ lamports = 1_000_000_000, tokens = {} } = {}) {
  return { lamports, tokens: Object.fromEntries(Object.entries(tokens).map(([mint, amount]) => [mint, BigInt(amount)])) };
}

assert.doesNotThrow(() => validateSimulatedSwapEffects({
  before: snapshot({ tokens: { [inputMint]: 1000, [outputMint]: 100, [unrelatedMint]: 500 } }),
  after: snapshot({ lamports: 999_995_000, tokens: { [inputMint]: 700, [outputMint]: 250, [unrelatedMint]: 500 } }),
  inputMint,
  outputMint,
  amount: '300',
  nativeMint: WSOL_MINT,
}));

assert.throws(() => validateSimulatedSwapEffects({
  before: snapshot({ tokens: { [inputMint]: 1000, [outputMint]: 100 } }),
  after: snapshot({ tokens: { [inputMint]: 650, [outputMint]: 200 } }),
  inputMint,
  outputMint,
  amount: '300',
  nativeMint: WSOL_MINT,
}), /exceeded requested input/);

assert.throws(() => validateSimulatedSwapEffects({
  before: snapshot({ tokens: { [inputMint]: 1000, [outputMint]: 100, [unrelatedMint]: 500 } }),
  after: snapshot({ tokens: { [inputMint]: 700, [outputMint]: 250, [unrelatedMint]: 499 } }),
  inputMint,
  outputMint,
  amount: '300',
  nativeMint: WSOL_MINT,
}), /unexpected token debit/);

assert.throws(() => validateSimulatedSwapEffects({
  before: snapshot({ tokens: { [inputMint]: 1000, [outputMint]: 100 } }),
  after: snapshot({ tokens: { [inputMint]: 700, [outputMint]: 100 } }),
  inputMint,
  outputMint,
  amount: '300',
  nativeMint: WSOL_MINT,
}), /did not credit expected output/);

assert.doesNotThrow(() => validateSimulatedSwapEffects({
  before: snapshot({ lamports: 1_000_000_000, tokens: { [inputMint]: 1000 } }),
  after: snapshot({ lamports: 1_100_000_000, tokens: { [inputMint]: 700 } }),
  inputMint,
  outputMint: WSOL_MINT,
  amount: '300',
  nativeMint: WSOL_MINT,
}));

assert.throws(() => validateSimulatedSwapEffects({
  before: snapshot({ lamports: 1_000_000_000, tokens: { [inputMint]: 1000 } }),
  after: snapshot({ lamports: 999_995_000, tokens: { [inputMint]: 700 } }),
  inputMint,
  outputMint: WSOL_MINT,
  amount: '300',
  nativeMint: WSOL_MINT,
}), /did not increase wallet SOL/);

assert.throws(() => validateSimulatedSwapEffects({
  before: snapshot({ lamports: 1_000_000_000, tokens: { [outputMint]: 100 } }),
  after: snapshot({ lamports: 800_000_000, tokens: { [outputMint]: 250 } }),
  inputMint: WSOL_MINT,
  outputMint,
  amount: '50000000',
  nativeMint: WSOL_MINT,
}), /excessive wallet debit/);

assert.throws(() => validateSimulatedSwapEffects({
  before: snapshot(), after: snapshot(), inputMint, outputMint, amount: 'not-a-number', nativeMint: WSOL_MINT,
}), /Invalid raw token amount/);

console.log('[test_live_executor_semantics] SUCCESS: token debits, output credits, and SOL effects fail closed.');
