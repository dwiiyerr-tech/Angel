import axios from 'axios';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  JUPITER_API_KEY,
  JUPITER_SLIPPAGE_BPS,
  JUPITER_SWAP_BASE_URL,
  JSON_HEADERS,
  SOLANA_PRIVATE_KEY,
  SOLANA_RPC_URL,
  WSOL_MINT,
} from './config.js';

let liveWallet = null;
let solanaConnection = null;

function parseKeypair(secret) {
  const value = String(secret || '').trim();
  if (!value) return null;
  if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  return Keypair.fromSecretKey(bs58.decode(value));
}

export function initLiveExecution() {
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

export async function fetchLiveTokenBalance(mint) {
  if (!liveWallet || !solanaConnection) return null;
  try {
    const accounts = await solanaConnection.getParsedTokenAccountsByOwner(
      liveWallet.publicKey,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    return accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount || null;
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
  const res = await axios.get(url.toString(), {
    timeout: 20_000,
    headers: { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY },
  });
  const order = res.data;
  if (order.errorCode || order.error) {
    throw new Error(`Jupiter order failed: ${order.errorMessage || order.error || order.errorCode}`);
  }
  return order;
}

function orderTransactionBase64(order) {
  return order?.transaction || order?.swapTransaction || null;
}

function signTransaction(transactionBase64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  const feePayer = tx.message.staticAccountKeys?.[0];
  if (!feePayer || !feePayer.equals(liveWallet.publicKey)) {
    throw new Error('Refusing swap transaction with an unexpected fee payer.');
  }
  tx.sign([liveWallet]);
  return { tx, base64: Buffer.from(tx.serialize()).toString('base64') };
}

async function simulateAndValidateTransaction(tx, { inputMint, amount }) {
  const walletAddress = liveWallet.publicKey.toBase58();
  const balanceBefore = await solanaConnection.getBalance(liveWallet.publicKey, 'confirmed');
  const simulation = await solanaConnection.simulateTransaction(tx, {
    sigVerify: true,
    replaceRecentBlockhash: false,
    commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [walletAddress] },
  });
  if (simulation.value.err) throw new Error(`Swap simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const balanceAfter = Number(simulation.value.accounts?.[0]?.lamports);
  if (!Number.isFinite(balanceAfter)) throw new Error('Swap simulation did not return the wallet balance.');
  const debit = Math.max(0, balanceBefore - balanceAfter);
  const tradeDebit = inputMint === WSOL_MINT ? Number(amount) : 0;
  const maxOverheadLamports = 10_000_000; // fees + ATA/rent ceiling (0.01 SOL)
  if (debit > tradeDebit + maxOverheadLamports) {
    throw new Error(`Swap simulation attempted excessive wallet debit: ${debit} lamports.`);
  }
}

async function jupiterExecute(order, signedTransaction) {
  requireLiveExecution();
  const body = {
    signedTransaction,
    requestId: order.requestId,
  };
  try {
    const res = await axios.post(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/execute`, body, {
      timeout: 30_000,
      headers: { ...JSON_HEADERS, 'content-type': 'application/json', 'x-api-key': JUPITER_API_KEY },
    });
    return res.data;
  } catch (error) {
    // Once /execute has been submitted, a timeout or transport failure does
    // not prove the transaction failed. Retrying with a new order can create
    // a duplicate fill, so callers must treat this outcome as ambiguous.
    // Any failure after submitting /execute is ambiguous. Even an HTTP error
    // can be returned after the provider broadcast the transaction.
    error.swapOutcomeUnknown = true;
    error.swapStage = 'execute';
    error.swapRequestId = order.requestId || null;
    throw error;
  }
}

export async function executeJupiterSwap({ inputMint, outputMint, amount }) {
  const order = await jupiterOrder({ inputMint, outputMint, amount });
  const transaction = orderTransactionBase64(order);
  if (!transaction) throw new Error('Jupiter order did not include a transaction.');
  const signed = signTransaction(transaction);
  await simulateAndValidateTransaction(signed.tx, { inputMint, amount });
  const executed = await jupiterExecute(order, signed.base64);
  if (executed?.status && executed.status !== 'Success') {
    throw new Error(`Jupiter execute failed: ${executed.error || executed.code || executed.status}`);
  }
  const signature = executed?.signature || executed?.txid || executed?.transactionId || null;
  if (!signature) {
    const error = new Error(`Jupiter execute returned no signature (status: ${executed?.status || 'unknown'})`);
    error.swapOutcomeUnknown = true;
    error.swapRequestId = order.requestId || null;
    throw error;
  }
  try {
    const confirmation = await Promise.race([
      solanaConnection.confirmTransaction(signature, 'confirmed'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('on-chain confirmation timeout')), 20_000)),
    ]);
    if (confirmation?.value?.err) {
      throw new Error(`On-chain swap failed: ${JSON.stringify(confirmation.value.err)}`);
    }
  } catch (cause) {
    const error = new Error(`Swap signature ${signature} could not be confirmed: ${cause.message}`);
    error.swapOutcomeUnknown = true;
    error.swapSignature = signature;
    error.swapRequestId = order.requestId || null;
    throw error;
  }
  return {
    order,
    executed,
    signature,
    inputAmount: String(amount),
    // Never treat a pre-trade quote as the amount actually received.
    outputAmount: String(executed?.outputAmountResult || executed?.totalOutputAmount || ''),
  };
}
