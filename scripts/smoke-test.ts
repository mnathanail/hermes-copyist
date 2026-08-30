/**
 * Smoke test for the CoinVera / SolanaPortal / Jito contract.
 *
 * Purpose: verify the assumptions documented in CLAUDE.md against REAL
 * wallets and REAL API responses, before any dashboard or DB workflow
 * depends on them. Specifically checks:
 *
 *   1. Multi-wallet WS subscribe actually delivers trades for every
 *      watched address, not just the first one (unverified in both
 *      reference implementations — they only ever watched one wallet).
 *   2. The trade message shape matches what's documented
 *      (signer/ca/trade/solAmount/dexs).
 *   3. dexMapper produces a dex code SolanaPortal accepts.
 *   4. (LIVE mode only) A full buy → confirm → read-back → sell round
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
 * Pick at least 2 wallets that trade frequently on pump.fun for a
 * realistic test — a Twitter/Telegram "smart money" tracker list works
 * well as a source. Let it run for a while; it does not exit on its own
 * in dry-run mode (Ctrl+C when satisfied). In LIVE mode it exits
 * automatically after completing one full round trip.
 */
import { WalletWatcher, type DetectedBuy } from '../src/services/walletWatcher.js';
import { mapDex } from '../src/services/dexMapper.js';
import { executeOrder, getActualTokenBalance } from '../src/services/solanaExecution.js';
import { fetchTokenPrice } from '../src/services/priceService.js';

const addresses = (process.env.SMOKE_TEST_WALLETS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
const isLive = process.env.SMOKE_TEST_LIVE === 'true';
const buyAmountSol = Number(process.env.SMOKE_TEST_BUY_AMOUNT_SOL ?? '0.01');

if (addresses.length === 0) {
  console.error('Set SMOKE_TEST_WALLETS to a comma-separated list of at least 2 wallet addresses.');
  process.exit(1);
}

console.log(`\n=== Hermes Copyist — CoinVera contract smoke test ===`);
console.log(`Watching ${addresses.length} wallet(s): ${addresses.join(', ')}`);
console.log(`Mode: ${isLive ? `LIVE — will spend ~${buyAmountSol} SOL on the first detected buy` : 'DRY RUN — observe only, no funds spent'}`);
console.log(`Waiting for trade activity... (Ctrl+C to stop)\n`);

const seenSigners = new Set<string>();
let liveTestCompleted = false;

const watcher = new WalletWatcher(addresses);

// See every message CoinVera sends, not just recognized buys — this is
// the main point of the smoke test: comparing real payloads to what
// walletWatcher.ts assumes.
watcher.on('raw', (data: any) => {
  if (data?.type === 'subscribeTrade') {
    console.log(`[ack] Subscription response:`, JSON.stringify(data));
    return;
  }

  if (data?.signer && !seenSigners.has(data.signer)) {
    seenSigners.add(data.signer);
    console.log(`\n[new signer seen] ${data.signer} (${seenSigners.size}/${addresses.length} watched wallets have shown activity so far)`);
  }

  const shapeOk = typeof data?.signer === 'string'
    && typeof data?.ca === 'string'
    && (data?.trade === 'buy' || data?.trade === 'sell')
    && typeof data?.solAmount === 'number'
    && Array.isArray(data?.dexs);

  console.log(`[trade] signer=${data?.signer} trade=${data?.trade} solAmount=${data?.solAmount} ca=${data?.ca} dexs=${JSON.stringify(data?.dexs)} — shape ${shapeOk ? 'OK ✅' : 'UNEXPECTED ⚠️'}`);
  if (!shapeOk) {
    console.log(`  Full raw message for inspection: ${JSON.stringify(data)}`);
  }
});

watcher.on('buy', async (detected: DetectedBuy) => {
  const dex = mapDex(detected.dexs);
  console.log(`\n[buy detected] wallet=${detected.wallet.address} mint=${detected.mint} solAmount=${detected.solAmount} dexs=${JSON.stringify(detected.dexs)} → mapped dex="${dex}"`);

  if (!isLive || liveTestCompleted) {
    console.log(`  (dry run — not executing. Re-run with SMOKE_TEST_LIVE=true to test real execution.)`);
    return;
  }

  liveTestCompleted = true; // only ever do one live round trip per run
  console.log(`\n=== LIVE round trip starting (${buyAmountSol} SOL) ===`);

  try {
    console.log(`[1/4] Buying ${buyAmountSol} SOL of ${detected.mint} on ${dex}...`);
    const buySig = await executeOrder('smoke-test', 'buy', detected.mint, buyAmountSol, 15, 0.0005, dex);
    console.log(`  ✅ Buy confirmed: https://solscan.io/tx/${buySig}`);

    console.log(`[2/4] Reading back actual on-chain token balance + price...`);
    const [tokenAmount, price] = await Promise.all([
      getActualTokenBalance(detected.mint),
      fetchTokenPrice(detected.mint),
    ]);
    console.log(`  ✅ Balance: ${tokenAmount} tokens. Price: ${JSON.stringify(price)}`);

    if (tokenAmount <= 0) {
      console.error(`  ⚠️ Token balance came back as ${tokenAmount} — cannot sell back. Manual check needed on-chain.`);
      process.exit(1);
    }

    console.log(`[3/4] Selling the full ${tokenAmount} tokens back on ${dex}...`);
    const sellSig = await executeOrder('smoke-test', 'sell', detected.mint, tokenAmount, 15, 0.0005, dex);
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
