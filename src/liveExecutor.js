import axios from 'axios';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  JUPITER_API_KEY,
  JUPITER_SLIPPAGE_BPS,
  JUPITER_SWAP_BASE_URL,
  JITO_BLOCK_ENGINE_URL,
  JITO_BUNDLE_ONLY,
  JITO_ENABLED,
  JSON_HEADERS,
  SOLANA_PRIVATE_KEY,
  SOLANA_RPC_URL,
  WSOL_MINT,
} from './config.js';
import { rateLimiter, REQUEST_PRIORITY } from './enrichment/rateLimiter.js';
import {
  MAX_SWAP_VALIDATION_ACCOUNTS,
  validateSimulatedSwapEffects,
  walletTokenBalancesFromAccounts,
} from './execution/swapValidation.js';
import { ensureLiveSafetySchema } from './db/liveSafety.js';
import { db } from './db/connection.js';
import { injectSimulationFailure, simulateConfirmation } from './execution/simulation.js';

let liveWallet = null;
let solanaConnection = null;

function parseKeypair(secret) {
  const value = String(secret || '').trim();
  if (!value) return null;
  if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  return Keypair.fromSecretKey(bs58.decode(value));
}

export function initLiveExecution() {
  ensureLiveSafetySchema();
  if (!SOLANA_PRIVATE_KEY) return;
  try {
    liveWallet = parseKeypair(SOLANA_PRIVATE_KEY);
    solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
    console.log(`[live] wallet loaded ${liveWallet.publicKey.toBase58()}`);
  } catch (err) {
    liveWallet = null;
    solanaConnection = null;
    console.log(`[live] wallet load failed: ${err.message}`);
  }
}

export function liveWalletPubkey() {
  return liveWallet?.publicKey?.toBase58() || null;
}

export function sumParsedTokenAccountBalances(accounts) {
  let total = 0n;
  for (const item of accounts || []) {
    const raw = item?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (raw == null) continue;
    const text = String(raw);
    if (!/^\d+$/.test(text)) continue;
    total += BigInt(text);
  }
  return total.toString();
}

export async function fetchLiveTokenBalance(mint) {
  if (!liveWallet || !solanaConnection) return null;
  try {
    const accounts = await solanaConnection.getParsedTokenAccountsByOwner(
      liveWallet.publicKey,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    return sumParsedTokenAccountBalances(accounts.value);
  } catch (err) {
    console.log(`[live] token balance ${mint.slice(0, 8)}... ${err.message}`);
    return null;
  }
}

export function requireLiveExecution() {
  if (!liveWallet || !solanaConnection) throw new Error('SOLANA_PRIVATE_KEY is required for live execution.');
  if (!JUPITER_API_KEY) throw new Error('JUPITER_API_KEY is required for live execution.');
}

export async function liveWalletBalanceLamports() {
  requireLiveExecution();
  return solanaConnection.getBalance(liveWallet.publicKey, 'confirmed');
}

async function jupiterOrder({ inputMint, outputMint, amount }) {
  requireLiveExecution();
  const url = new URL(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/order`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('taker', liveWallet.publicKey.toBase58());
  url.searchParams.set('slippageBps', String(JUPITER_SLIPPAGE_BPS));
  const res = await rateLimiter.schedule(() => axios.get(url.toString(), {
    timeout: 20_000,
    headers: { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY },
  }), 'jupiter', REQUEST_PRIORITY.ENTRY_EXIT);
  const order = res.data;
  if (order.errorCode || order.error) throw new Error(`Jupiter order failed: ${order.errorMessage || order.error || order.errorCode}`);
  return order;
}

function orderTransactionBase64(order) {
  return order?.transaction || order?.swapTransaction || null;
}

function signTransaction(transactionBase64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  const feePayer = tx.message.staticAccountKeys?.[0];
  if (!feePayer || !feePayer.equals(liveWallet.publicKey)) throw new Error('Refusing swap transaction with an unexpected fee payer.');
  tx.sign([liveWallet]);
  return { tx, base64: Buffer.from(tx.serialize()).toString('base64') };
}

export function localTransactionSignature(tx) {
  const signature = tx?.signatures?.[0];
  if (!signature || signature.length !== 64) throw new Error('Signed transaction is missing its primary signature.');
  return bs58.encode(signature);
}

function executionIdentity(inputMint, outputMint) {
  if (inputMint === WSOL_MINT && outputMint && outputMint !== WSOL_MINT) return { side: 'buy', mint: outputMint };
  if (outputMint === WSOL_MINT && inputMint && inputMint !== WSOL_MINT) return { side: 'sell', mint: inputMint };
  return null;
}

function journalExecutionSignature(signature, { inputMint, outputMint, finalized = false } = {}) {
  ensureLiveSafetySchema();
  const identity = executionIdentity(inputMint, outputMint);
  if (!identity || !signature) return false;
  const at = Date.now();
  const result = db.prepare(`
    UPDATE execution_operations
    SET signature = COALESCE(signature, ?),
        finalized_at_ms = CASE WHEN ? THEN COALESCE(finalized_at_ms, ?) ELSE finalized_at_ms END,
        updated_at_ms = ?
    WHERE id = (
      SELECT id FROM execution_operations
      WHERE mint = ? AND side = ? AND status IN ('pending', 'outcome_unknown')
      ORDER BY id DESC LIMIT 1
    )
  `).run(signature, finalized ? 1 : 0, at, at, identity.mint, identity.side);
  return result.changes === 1;
}

async function transactionValidationAddresses(tx) {
  const addressLookupTableAccounts = [];
  for (const lookup of tx.message.addressTableLookups || []) {
    const resolved = await solanaConnection.getAddressLookupTable(lookup.accountKey, { commitment: 'confirmed' });
    if (!resolved?.value) throw new Error(`Swap validation could not resolve lookup table ${lookup.accountKey.toBase58()}.`);
    addressLookupTableAccounts.push(resolved.value);
  }
  const accountKeys = tx.message.getAccountKeys({ addressLookupTableAccounts });
  const addresses = [liveWallet.publicKey.toBase58()];
  for (let index = 0; index < accountKeys.length; index += 1) {
    if (!tx.message.isAccountWritable(index)) continue;
    const key = accountKeys.get(index);
    if (key) addresses.push(key.toBase58());
  }
  const unique = [...new Set(addresses)];
  if (unique.length > MAX_SWAP_VALIDATION_ACCOUNTS) {
    throw new Error(`Swap validation requires ${unique.length} accounts, above the safe limit of ${MAX_SWAP_VALIDATION_ACCOUNTS}.`);
  }
  return unique;
}

async function simulateAndValidateTransaction(tx, { inputMint, outputMint, amount }) {
  const walletAddress = liveWallet.publicKey.toBase58();
  const addresses = await transactionValidationAddresses(tx);
  const publicKeys = addresses.map(address => new PublicKey(address));
  const beforeAccounts = await solanaConnection.getMultipleAccountsInfo(publicKeys, 'confirmed');
  const walletIndex = addresses.indexOf(walletAddress);
  const walletBefore = beforeAccounts[walletIndex];
  if (!walletBefore || !Number.isSafeInteger(Number(walletBefore.lamports))) throw new Error('Swap validation could not read the pre-simulation wallet balance.');

  const simulation = await solanaConnection.simulateTransaction(tx, {
    sigVerify: true,
    replaceRecentBlockhash: false,
    commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses },
  });
  if (simulation.value.err) throw new Error(`Swap simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const afterAccounts = simulation.value.accounts;
  if (!Array.isArray(afterAccounts) || afterAccounts.length !== addresses.length) throw new Error('Swap simulation did not return the requested account state.');
  const walletAfter = afterAccounts[walletIndex];
  if (!walletAfter || !Number.isSafeInteger(Number(walletAfter.lamports))) throw new Error('Swap simulation did not return the post-simulation wallet balance.');

  validateSimulatedSwapEffects({
    before: { lamports: Number(walletBefore.lamports), tokens: walletTokenBalancesFromAccounts(beforeAccounts, walletAddress) },
    after: { lamports: Number(walletAfter.lamports), tokens: walletTokenBalancesFromAccounts(afterAccounts, walletAddress) },
    inputMint,
    outputMint,
    amount,
    nativeMint: WSOL_MINT,
  });
}

async function jupiterExecute(order, signedTransaction) {
  requireLiveExecution();
  const body = { signedTransaction, requestId: order.requestId };
  try {
    const res = await rateLimiter.schedule(() => axios.post(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/execute`, body, {
      timeout: 30_000,
      headers: { ...JSON_HEADERS, 'content-type': 'application/json', 'x-api-key': JUPITER_API_KEY },
    }), 'jupiter', REQUEST_PRIORITY.ENTRY_EXIT);
    return res.data;
  } catch (error) {
    error.swapOutcomeUnknown = true;
    error.swapStage = 'execute';
    error.swapRequestId = order.requestId || null;
    throw error;
  }
}

async function jitoSendTransaction(signedTransaction) {
  const endpoint = `${JITO_BLOCK_ENGINE_URL.replace(/\/$/, '')}/api/v1/transactions`;
  const url = new URL(endpoint);
  if (JITO_BUNDLE_ONLY) url.searchParams.set('bundleOnly', 'true');
  try {
    const res = await axios.post(url.toString(), {
      jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [signedTransaction, { encoding: 'base64' }],
    }, { timeout: 20_000, headers: { 'content-type': 'application/json' } });
    if (res.data?.error) throw new Error(`Jito sendTransaction failed: ${res.data.error.message || JSON.stringify(res.data.error)}`);
    if (!res.data?.result) throw new Error('Jito returned no transaction signature.');
    return { signature: res.data.result, mevProtected: true, jito: true };
  } catch (error) {
    error.swapOutcomeUnknown = true;
    error.swapStage = 'jito_sendTransaction';
    throw error;
  }
}

function ownerMintTotal(rows, walletAddress, mint) {
  let total = 0n;
  for (const row of rows || []) {
    if (row?.owner !== walletAddress || row?.mint !== mint) continue;
    const raw = row?.uiTokenAmount?.amount;
    if (raw != null && /^\d+$/.test(String(raw))) total += BigInt(String(raw));
  }
  return total;
}

function keyString(key) {
  if (!key) return '';
  if (typeof key === 'string') return key;
  if (typeof key?.toBase58 === 'function') return key.toBase58();
  return String(key);
}

export function deriveFinalizedSwapReceipt(transaction, walletAddress, { inputMint, outputMint, nativeMint = WSOL_MINT } = {}) {
  const meta = transaction?.meta;
  const message = transaction?.transaction?.message;
  if (!meta || !message || meta.err) {
    return {
      success: false,
      error: meta?.err || 'missing_transaction_meta',
      feeLamports: Number(meta?.fee || 0),
      outputAmount: null,
      inputDebitAmount: null,
    };
  }

  const keys = message.staticAccountKeys || message.accountKeys || [];
  const walletIndex = keys.findIndex(key => keyString(key) === walletAddress);
  const feeLamports = Number(meta.fee || 0);
  const preTokens = ownerMintTotal(meta.preTokenBalances, walletAddress, inputMint);
  const postTokens = ownerMintTotal(meta.postTokenBalances, walletAddress, inputMint);
  const preOutputTokens = ownerMintTotal(meta.preTokenBalances, walletAddress, outputMint);
  const postOutputTokens = ownerMintTotal(meta.postTokenBalances, walletAddress, outputMint);

  let inputDebitAmount = null;
  if (inputMint === nativeMint) {
    if (preTokens > postTokens) {
      inputDebitAmount = (preTokens - postTokens).toString();
    } else if (walletIndex >= 0) {
      const nativeDebit = Math.max(0, Number(meta.preBalances?.[walletIndex] || 0) - Number(meta.postBalances?.[walletIndex] || 0));
      inputDebitAmount = String(Math.max(0, nativeDebit - feeLamports));
    }
  } else {
    inputDebitAmount = preTokens > postTokens ? (preTokens - postTokens).toString() : '0';
  }

  let outputAmount = null;
  if (postOutputTokens > preOutputTokens) {
    outputAmount = (postOutputTokens - preOutputTokens).toString();
  } else if (outputMint === nativeMint && walletIndex >= 0) {
    const net = Number(meta.postBalances?.[walletIndex] || 0) - Number(meta.preBalances?.[walletIndex] || 0);
    const grossOutput = net + feeLamports;
    if (Number.isSafeInteger(grossOutput) && grossOutput > 0) outputAmount = String(grossOutput);
  }

  return {
    success: true,
    error: null,
    feeLamports,
    feeSol: feeLamports / 1_000_000_000,
    outputAmount,
    inputDebitAmount,
    slot: transaction.slot ?? null,
    blockTime: transaction.blockTime ?? null,
  };
}

export async function fetchFinalizedSwapReceipt(signature, { inputMint, outputMint } = {}) {
  requireLiveExecution();
  const statuses = await solanaConnection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = statuses?.value?.[0] || null;
  if (!status) return { found: false, finalized: false, success: null, signature };
  if (status.confirmationStatus !== 'finalized') {
    return { found: true, finalized: false, success: status.err ? false : null, error: status.err || null, signature };
  }
  if (status.err) return { found: true, finalized: true, success: false, error: status.err, signature };

  const transaction = await solanaConnection.getTransaction(signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });
  if (!transaction) return { found: true, finalized: true, success: true, signature, outputAmount: null, receiptMissing: true };
  return {
    found: true,
    finalized: true,
    signature,
    ...deriveFinalizedSwapReceipt(transaction, liveWallet.publicKey.toBase58(), { inputMint, outputMint }),
  };
}

async function waitForFinalizedSwapReceipt(signature, mints, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetchFinalizedSwapReceipt(signature, mints);
    if (last.finalized && (last.success !== true || last.outputAmount)) return last;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return last || { found: false, finalized: false, success: null, signature };
}

export async function simulateJupiterSwap({ inputMint, outputMint, amount }) {
  injectSimulationFailure('order');
  const order = await jupiterOrder({ inputMint, outputMint, amount });
  const transaction = orderTransactionBase64(order);
  if (!transaction) throw new Error('Jupiter order did not include a transaction.');
  injectSimulationFailure('sign');
  const signed = signTransaction(transaction);
  injectSimulationFailure('rpc');
  await simulateAndValidateTransaction(signed.tx, { inputMint, outputMint, amount });
  const confirmation = await simulateConfirmation({ signature: null });
  return {
    order,
    simulated: true,
    broadcast: false,
    signing: { performed: true, signer: liveWallet.publicKey.toBase58(), broadcast: false },
    rpc: { simulated: true, status: 'ok' },
    confirmation,
    inputAmount: String(amount),
    outputAmount: String(order?.outAmount || order?.outputAmount || order?.outAmountResult || ''),
  };
}

export async function executeJupiterSwap({ inputMint, outputMint, amount }) {
  const order = await jupiterOrder({ inputMint, outputMint, amount });
  const transaction = orderTransactionBase64(order);
  if (!transaction) throw new Error('Jupiter order did not include a transaction.');
  const signed = signTransaction(transaction);
  await simulateAndValidateTransaction(signed.tx, { inputMint, outputMint, amount });

  // The first Solana transaction signature is deterministic after signing. It
  // is durably journaled before broadcast so a process crash during/after the
  // HTTP send still leaves enough identity for restart reconciliation.
  const localSignature = localTransactionSignature(signed.tx);
  journalExecutionSignature(localSignature, { inputMint, outputMint });

  let executed;
  try {
    executed = JITO_ENABLED ? await jitoSendTransaction(signed.base64) : await jupiterExecute(order, signed.base64);
  } catch (error) {
    error.swapOutcomeUnknown = true;
    error.swapSignature = error.swapSignature || localSignature;
    error.swapRequestId = error.swapRequestId || order.requestId || null;
    throw error;
  }
  if (executed?.status && executed.status !== 'Success') {
    const error = new Error(`Jupiter execute failed: ${executed.error || executed.code || executed.status}`);
    error.swapOutcomeUnknown = true;
    error.swapSignature = localSignature;
    error.swapRequestId = order.requestId || null;
    throw error;
  }
  const remoteSignature = executed?.signature || executed?.txid || executed?.transactionId || null;
  if (remoteSignature && remoteSignature !== localSignature) {
    const error = new Error(`Execution provider returned signature ${remoteSignature} but locally signed signature is ${localSignature}.`);
    error.swapOutcomeUnknown = true;
    error.swapSignature = localSignature;
    error.swapRequestId = order.requestId || null;
    throw error;
  }
  const signature = remoteSignature || localSignature;

  let receipt;
  try {
    receipt = await waitForFinalizedSwapReceipt(signature, { inputMint, outputMint });
  } catch (cause) {
    const error = new Error(`Swap signature ${signature} finality check failed: ${cause.message}`);
    error.swapOutcomeUnknown = true;
    error.swapSignature = signature;
    error.swapRequestId = order.requestId || null;
    throw error;
  }
  if (receipt?.finalized) journalExecutionSignature(signature, { inputMint, outputMint, finalized: true });
  if (!receipt?.finalized || receipt.success !== true) {
    const detail = receipt?.finalized && receipt.success === false
      ? `finalized with error ${JSON.stringify(receipt.error)}`
      : 'did not produce an authoritative finalized receipt before timeout';
    const error = new Error(`Swap signature ${signature} ${detail}`);
    error.swapOutcomeUnknown = true;
    error.swapSignature = signature;
    error.swapRequestId = order.requestId || null;
    throw error;
  }

  const receiptOutput = String(receipt.outputAmount || '');
  if (!/^\d+$/.test(receiptOutput) || BigInt(receiptOutput) <= 0n) {
    const error = new Error(`Swap signature ${signature} finalized but authoritative output amount is unavailable.`);
    error.swapOutcomeUnknown = true;
    error.swapSignature = signature;
    error.swapRequestId = order.requestId || null;
    throw error;
  }

  // For token -> SOL exits, verify the finalized wallet token debit equals the
  // signed request. This prevents a ledger close from accepting a receipt that
  // belongs to an unexpected token delta.
  if (inputMint !== WSOL_MINT) {
    const debit = String(receipt.inputDebitAmount || '');
    const requested = String(amount);
    if (!/^\d+$/.test(debit) || BigInt(debit) !== BigInt(requested)) {
      const error = new Error(`Swap signature ${signature} finalized with input debit ${debit || 'unknown'}, expected ${requested}.`);
      error.swapOutcomeUnknown = true;
      error.swapSignature = signature;
      error.swapRequestId = order.requestId || null;
      throw error;
    }
  }

  const providerOutput = String(executed?.outputAmountResult || executed?.totalOutputAmount || '');
  const providerOutputMismatch = /^\d+$/.test(providerOutput)
    && BigInt(providerOutput) > 0n
    && BigInt(providerOutput) !== BigInt(receiptOutput);
  if (providerOutputMismatch) {
    console.warn(`[live] provider output ${providerOutput} disagrees with finalized receipt ${receiptOutput} for ${signature.slice(0, 10)}...; receipt wins`);
  }

  return {
    order,
    executed,
    signature,
    inputAmount: String(amount),
    outputAmount: receiptOutput,
    providerOutputAmount: providerOutput || null,
    providerOutputMismatch,
    feeLamports: Number(receipt.feeLamports || 0),
    feeSol: Number(receipt.feeSol || 0),
    finalized: true,
    finalizedAtMs: Date.now(),
    receipt,
  };
}
