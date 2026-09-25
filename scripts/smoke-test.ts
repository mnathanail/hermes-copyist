/**
 * Smoke test for the Helius / Jupiter / SolanaPortal / Jito contract.
 *
 * Purpose: verify the assumptions documented in CLAUDE.md against REAL
 * wallets and REAL API responses, before any dashboard or DB workflow
 * depends on them. Specifically checks:
 *
 *   1. Helius transactionSubscribe delivers notifications for multiple
 *      watched wallets (accountInclude supports up to 50,000 addresses
 *      per Helius's docs — no plan-tier ambiguity like CoinVera had).
 *   2. The balance-delta buy detection in walletWatcher.ts actually
 *      identifies buys correctly against real transactions.
 *   3. dexMapper's program-ID resolution produces a dex SolanaPortal accepts.
 *   4. Jupiter Price API returns usable prices (and surfaces the known
 *      gap for pre-migration pump.fun tokens, if hit).
 *   5. (LIVE mode only) A full buy → confirm → read-back → sell round
 *      trip works end-to-end with real funds, using a tiny amount.
 *
 * ── Usage ──────────────────────────────────────────────────────────
 *
 *   DRY RUN (safe, default — no funds spent, just observes and logs):
 *     SMOKE_TEST_WALLETS=addr1,addr2 npm run smoke-test
 *
 *   LIVE (spends real SOL — see SMOKE_TEST_BUY_AMOUNT_SOL below):
 *     SMOKE_TEST_WALLETS=addr1,addr2 SMOKE_TEST_LIVE=true npm run smoke-test
 *
 * Pick at least 2 wallets that trade frequently on pump.fun/Raydium for a
 * realistic test. Let it run for a while; it does not exit on its own in
 * dry-run mode (Ctrl+C when satisfied). In LIVE mode it exits automatically
 * after completing one full round trip.
 */
import { WalletWatcher, type DetectedBuy } from '../src/services/walletWatcher.js';
import { executeOrder, getActualTokenBalance } from '../src/services/solanaExecution.js';
import { fetchTokenPrice } from '../src/services/priceService.js';

const addresses = (process.env.SMOKE_TEST_WALLETS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
const isLive = process.env.SMOKE_TEST_LIVE === 'true';
const buyAmountSol = Number(process.env.SMOKE_TEST_BUY_AMOUNT_SOL ?? '0.01');

if (addresses.length === 0) {
  console.error('Set SMOKE_TEST_WALLETS to a comma-separated list of at least 2 wallet addresses.');
  process.exit(1);
}

console.log(`\n=== Hermes Copyist — Helius contract smoke test ===`);
console.log(`Watching ${addresses.length} wallet(s): ${addresses.join(', ')}`);
console.log(`Mode: ${isLive ? `LIVE — will spend ~${buyAmountSol} SOL on the first detected buy` : 'DRY RUN — observe only, no funds spent'}`);
console.log(`Waiting for trade activity... (Ctrl+C to stop)\n`);

const seenSigners = new Set<string>();
let liveTestCompleted = false;

const watcher = new WalletWatcher(addresses);

// See every raw message Helius sends — subscription ack, every matching
// transaction (not just recognized buys) — to eyeball the real shape
// against what walletWatcher.ts assumes.
watcher.on('raw', (data: any) => {
  if (typeof data?.result === 'number' && data?.id !== undefined) {
    console.log(`[ack] Subscription confirmed, id=${data.result}`);
    return;
  }
  if (data?.method !== 'transactionNotification') return;

  const sig = data.params?.result?.signature;
  const meta = data.params?.result?.transaction?.meta;
  const message = data.params?.result?.transaction?.transaction?.message;
  const accountKeys = (message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k?.pubkey));

  const matched = addresses.filter((a) => accountKeys.includes(a));
  for (const signer of matched) {
    if (!seenSigners.has(signer)) {
      seenSigners.add(signer);
      console.log(`\n[new signer seen] ${signer} (${seenSigners.size}/${addresses.length} watched wallets have shown activity so far)`);
    }
  }

  const shapeOk = typeof sig === 'string' && Array.isArray(meta?.preTokenBalances) && Array.isArray(meta?.postTokenBalances);
  console.log(`[tx] signature=${sig} matched=[${matched.join(', ')}] preTokenBalances=${meta?.preTokenBalances?.length} postTokenBalances=${meta?.postTokenBalances?.length} — shape ${shapeOk ? 'OK ✅' : 'UNEXPECTED ⚠️'}`);
  if (!shapeOk) {
    console.log(`  Full raw message for inspection: ${JSON.stringify(data)}`);
  }
});

watcher.on('buy', async (detected: DetectedBuy) => {
  console.log(`\n[buy detected] wallet=${detected.wallet.address} mint=${detected.mint} solAmount≈${detected.solAmount} dex="${detected.dex}" sig=${detected.parentSignature}`);

  // Sanity-check the price lookup regardless of dry-run/live, since this
  // is the piece most likely to have coverage gaps (see priceService.ts).
  const price = await fetchTokenPrice(detected.mint);
  if (price) {
    console.log(`  Jupiter price lookup OK: ${JSON.stringify(price)}`);
  } else {
    console.log(`  ⚠️ Jupiter has no price for ${detected.mint} yet — likely a pre-migration bonding-curve token. This is the known gap documented in CLAUDE.md.`);
  }

  if (!isLive || liveTestCompleted) {
    console.log(`  (dry run — not executing. Re-run with SMOKE_TEST_LIVE=true to test real execution.)`);
    return;
  }

  liveTestCompleted = true; // only ever do one live round trip per run
  console.log(`\n=== LIVE round trip starting (${buyAmountSol} SOL) ===`);

  try {
    console.log(`[1/4] Buying ${buyAmountSol} SOL of ${detected.mint} on ${detected.dex}...`);
    const buySig = await executeOrder('smoke-test', 'buy', detected.mint, buyAmountSol, 15, 0.0005, detected.dex);
    console.log(`  ✅ Buy confirmed: https://solscan.io/tx/${buySig}`);

    console.log(`[2/4] Reading back actual on-chain token balance...`);
    const tokenAmount = await getActualTokenBalance(detected.mint);
    console.log(`  ✅ Balance: ${tokenAmount} tokens.`);

    if (tokenAmount <= 0) {
      console.error(`  ⚠️ Token balance came back as ${tokenAmount} — cannot sell back. Manual check needed on-chain.`);
      process.exit(1);
    }

    console.log(`[3/4] Selling the full ${tokenAmount} tokens back on ${detected.dex}...`);
    const sellSig = await executeOrder('smoke-test', 'sell', detected.mint, tokenAmount, 15, 0.0005, detected.dex);
    console.log(`  ✅ Sell confirmed: https://solscan.io/tx/${sellSig}`);

    console.log(`[4/4] Round trip complete. Contract verified end-to-end.`);
  } catch (err: any) {
    console.error(`  ❌ Round trip failed: ${err.message}`);
    console.error(`  This is exactly the kind of failure this smoke test exists to catch before the dashboard depends on it.`);
  } finally {
    console.log(`\nExiting smoke test.`);
    process.exit(0);
  }
});

watcher.start();
