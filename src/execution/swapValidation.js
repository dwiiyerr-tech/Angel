import bs58 from 'bs58';

export const MAX_SWAP_VALIDATION_ACCOUNTS = 64;
export const MAX_SWAP_OVERHEAD_LAMPORTS = 10_000_000;

const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

function publicKeyString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value?.toBase58 === 'function') return value.toBase58();
  return String(value);
}

function accountDataBuffer(info) {
  const data = info?.data;
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data) && typeof data[0] === 'string') return Buffer.from(data[0], data[1] || 'base64');
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  return null;
}

export function walletTokenBalancesFromAccounts(accountInfos, walletAddress) {
  const totals = {};
  for (const info of accountInfos || []) {
    if (!info || !TOKEN_PROGRAM_IDS.has(publicKeyString(info.owner))) continue;
    const data = accountDataBuffer(info);
    if (!data || data.length < 72) continue;
    const tokenOwner = bs58.encode(data.subarray(32, 64));
    if (tokenOwner !== walletAddress) continue;
    const mint = bs58.encode(data.subarray(0, 32));
    const amount = data.readBigUInt64LE(64);
    totals[mint] = (totals[mint] || 0n) + amount;
  }
  return totals;
}

function rawAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid raw token amount: ${text || '(empty)'}`);
  const parsed = BigInt(text);
  if (parsed <= 0n) throw new Error('Invalid raw token amount: amount must be positive.');
  return parsed;
}

function lamports(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${label} wallet lamport balance.`);
  return parsed;
}

function tokenAmount(snapshot, mint) {
  const value = snapshot?.tokens?.[mint] ?? 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function validateSimulatedSwapEffects({ before, after, inputMint, outputMint, amount, nativeMint }) {
  if (!inputMint || !outputMint || inputMint === outputMint) throw new Error('Swap validation requires distinct input and output mints.');
  const requestedInput = rawAmount(amount);
  const beforeLamports = lamports(before?.lamports, 'pre-simulation');
  const afterLamports = lamports(after?.lamports, 'post-simulation');
  const native = String(nativeMint || 'So11111111111111111111111111111111111111112');

  const nativeDebit = Math.max(0, beforeLamports - afterLamports);
  const nativeTradeDebit = inputMint === native ? requestedInput : 0n;
  const maxNativeDebit = nativeTradeDebit + BigInt(MAX_SWAP_OVERHEAD_LAMPORTS);
  if (BigInt(nativeDebit) > maxNativeDebit) {
    throw new Error(`Swap simulation attempted excessive wallet debit: ${nativeDebit} lamports.`);
  }

  if (inputMint !== native) {
    const inputBefore = tokenAmount(before, inputMint);
    const inputAfter = tokenAmount(after, inputMint);
    const inputDebit = inputBefore > inputAfter ? inputBefore - inputAfter : 0n;
    if (inputDebit === 0n) throw new Error('Swap simulation did not debit the expected input token.');
    if (inputDebit > requestedInput) {
      throw new Error(`Swap simulation exceeded requested input: ${inputDebit} > ${requestedInput}.`);
    }
  }

  if (outputMint === native) {
    if (afterLamports <= beforeLamports) {
      throw new Error('Swap simulation did not increase wallet SOL for the expected output.');
    }
  } else {
    const outputBefore = tokenAmount(before, outputMint);
    const outputAfter = tokenAmount(after, outputMint);
    if (outputAfter <= outputBefore) {
      throw new Error('Swap simulation did not credit expected output token.');
    }
  }

  const allMints = new Set([
    ...Object.keys(before?.tokens || {}),
    ...Object.keys(after?.tokens || {}),
  ]);
  for (const mint of allMints) {
    if (mint === inputMint) continue;
    const pre = tokenAmount(before, mint);
    const post = tokenAmount(after, mint);
    if (post < pre) {
      throw new Error(`Swap simulation attempted unexpected token debit for mint ${mint}.`);
    }
  }

  return {
    walletLamportDelta: afterLamports - beforeLamports,
    inputDebitRaw: inputMint === native
      ? BigInt(nativeDebit)
      : tokenAmount(before, inputMint) - tokenAmount(after, inputMint),
    outputCreditRaw: outputMint === native
      ? BigInt(Math.max(0, afterLamports - beforeLamports))
      : tokenAmount(after, outputMint) - tokenAmount(before, outputMint),
  };
}
