import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config/env.js';
import { logEvent } from './logger.js';

/**
 * The private key is decoded ONCE at module load, held only in memory for
 * this process's lifetime, and never passed to any function that logs its
 * arguments. This replaces the reference implementation's approach, where
 * the equivalent of this keypair lived in browser localStorage and signing
 * happened client-side — the single biggest issue found in that review.
 */
const keypair = Keypair.fromSecretKey(bs58.decode(config.privateKeyBase58));

export function getTradingWalletPubkey(): PublicKey {
  return keypair.publicKey;
}

/**
 * SolanaPortal's /api/trading endpoint returns the base64-encoded unsigned
 * transaction directly as the JSON body (a bare string) — NOT wrapped in
 * `{ transaction: "..." }`. Confirmed against
 * ahk780/solana-copy-trading-bot's tradeExecutor.js during the CoinVera/
 * SolanaPortal contract verification pass; an earlier draft of this file
 * assumed a wrapper object, which would have broken on the first live call.
 */
async function fetchUnsignedTransaction(
  action: 'buy' | 'sell',
  mint: string,
  amount: number,
  slippagePct: number,
  jitoTip: number,
  dex: string,
): Promise<string> {
  const response = await fetch(config.solanaPortalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wallet_address: config.walletAddress,
      action,
      dex,
      mint,
      amount,
      slippage: slippagePct,
      tip: jitoTip,
      type: 'jito',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SolanaPortal error: ${response.status} ${response.statusText} | ${text}`);
  }

  return response.json(); // bare base64 string
}

function signTransaction(base64Transaction: string): VersionedTransaction {
  const txBuffer = Buffer.from(base64Transaction, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([keypair]);
  return transaction;
}

/**
 * Jito's sendTransaction expects the signed transaction BASE58-encoded,
 * passed as the sole array element with no `encoding` field — NOT base64.
 * Confirmed against the reference implementation's tradeExecutor.js; an
 * earlier draft of this file used base64 + an explicit encoding param,
 * which Jito would have rejected or silently mis-decoded.
 */
async function submitToJito(transaction: VersionedTransaction): Promise<string> {
  const signedTxBase58 = bs58.encode(transaction.serialize());

  const response = await fetch(config.jitoRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [signedTxBase58],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jito sendTransaction failed: ${response.status} ${response.statusText} | ${text}`);
  }

  const result = await response.json();
  if (!result.result) {
    throw new Error(`Jito did not return a result: ${JSON.stringify(result)}`);
  }
  return result.result; // transaction signature
}

async function waitForConfirmation(signature: string): Promise<void> {
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  await connection.confirmTransaction(signature, 'confirmed');
}

/**
 * Reads the actual on-chain SPL token balance for the trading wallet.
 * Used right after a buy confirms to record the REAL token amount
 * received, instead of estimating it — the confirmed CoinVera trade
 * message has no per-unit price field to derive an estimate from
 * anyway (it only has solAmount/tokenAmount for the COPIED wallet's
 * trade, not ours). Mirrors the approach in
 * ahk780/solana-copy-trading-bot's index.js (raw BigInt + decimals,
 * to avoid float rounding errors).
 */
export async function getActualTokenBalance(mint: string): Promise<number> {
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  const owner = keypair.publicKey;
  const mintPubkey = new PublicKey(mint);

  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPubkey });

  let totalRaw = 0n;
  let decimals = 0;
  for (const { account } of accounts.value) {
    const parsed = account.data.parsed.info.tokenAmount;
    totalRaw += BigInt(parsed.amount);
    decimals = parsed.decimals;
  }

  return Number(totalRaw) / 10 ** decimals;
}

/**
 * Executes a buy or sell end-to-end: build → sign (server-side) → submit
 * via Jito → wait for confirmation. Callers are responsible for all DB
 * bookkeeping (positions, exit_fills) — this function only talks to the
 * chain and returns the signature.
 *
 * `dex` must be SolanaPortal's expected code ('pumpfun', 'jupiter',
 * 'meteora', 'raydium') — see dexMapper.ts to derive it from CoinVera's
 * `dexs` array. Passing the wrong dex is a likely cause of confusing
 * SolanaPortal errors, since the reference implementation confirmed this
 * is a required, DEX-specific routing parameter, not a hint.
 */
export async function executeOrder(
  correlationId: string,
  action: 'buy' | 'sell',
  mint: string,
  amount: number,
  slippagePct: number,
  jitoTip: number,
  dex: string,
): Promise<string> {
  await logEvent({ correlationId, category: 'execution', level: 'info', message: `Building ${action} tx for ${mint} on ${dex}, amount=${amount}` });

  const unsigned = await fetchUnsignedTransaction(action, mint, amount, slippagePct, jitoTip, dex);
  const signed = signTransaction(unsigned);
  const signature = await submitToJito(signed);

  await logEvent({ correlationId, category: 'execution', level: 'info', message: `Submitted ${action} tx, awaiting confirmation`, context: { signature } });

  await waitForConfirmation(signature);

  await logEvent({ correlationId, category: 'execution', level: 'success', message: `${action.toUpperCase()} confirmed for ${mint}`, context: { signature } });

  return signature;
}
