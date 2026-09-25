/**
 * Phase 1 smoke test — PumpPortal signal source, observe only.
 *
 * Connects ONE PumpPortal websocket, subscribes the given wallets, and
 * prints every trade as the mirror engine will see it. Nothing is bought,
 * nothing touches the DB, no private key is needed.
 *
 * What it verifies (Phase 1 gate: 24h, no missed trade):
 *   1. Buys AND sells arrive for every watched wallet, on pump.fun and
 *      PumpSwap (the pool column shows which).
 *   2. `newTokenBalance` is present on sells, so sell % can be mirrored.
 *      Any sell where sellPct is null is flagged.
 *   3. Nothing unexpected is dropped: every non-trade message is printed.
 *   4. Reconnects work and every blind window is recorded.
 *
 * Cross-check afterwards: compare the JSONL file with each wallet's
 * activity on GMGN/Solscan for the same period. Every trade there must
 * be here.
 *
 * Usage:
 *   PUMPPORTAL_API_KEY=... SMOKE_TEST_WALLETS=addr1,addr2 npm run smoke-test
 *
 * Optional: SMOKE_TEST_OUT_DIR (default ./logs), SMOKE_TEST_SUMMARY_MIN (default 5).
 * On Railway, stdout is enough: every line is also in the service logs.
 */
import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PumpPortalSource } from '../src/signals/pumpPortalSource.js';
import type { TradeSignal } from '../src/signals/types.js';

const apiKey = process.env.PUMPPORTAL_API_KEY?.trim();
const wallets = (process.env.SMOKE_TEST_WALLETS ?? '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

if (!apiKey) {
  console.error('Missing PUMPPORTAL_API_KEY.');
  process.exit(1);
}
if (wallets.length === 0) {
  console.error('Set SMOKE_TEST_WALLETS to a comma-separated list of wallet addresses.');
  process.exit(1);
}

const outDir = process.env.SMOKE_TEST_OUT_DIR ?? './logs';
const summaryMin = Number(process.env.SMOKE_TEST_SUMMARY_MIN ?? '5');
const startedAt = new Date();
const outFile = path.join(outDir, `smoke-${startedAt.toISOString().replace(/[:.]/g, '-')}.jsonl`);
let fileOk = true;
try {
  mkdirSync(outDir, { recursive: true });
} catch {
  fileOk = false;
}

function record(entry: Record<string, unknown>): void {
  if (!fileOk) return;
  try {
    appendFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (err: any) {
    fileOk = false;
    console.warn(`[file] could not write ${outFile}: ${err.message} — continuing with stdout only`);
  }
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

// ── counters for the periodic summary ─────────────────────────────
const perWallet = new Map<string, { buys: number; sells: number; sellsWithoutPct: number }>();
for (const w of wallets) perWallet.set(w, { buys: 0, sells: 0, sellsWithoutPct: 0 });
const pools = new Map<string, number>();
const buyersByMint = new Map<string, Set<string>>();
const seenSignatures = new Set<string>();
let duplicates = 0;
let sellsWithoutSeenBuy = 0;
let unparsedCount = 0;
let disconnects = 0;
let blindMs = 0;
let disconnectedAt: Date | null = null;

function onSignal(s: TradeSignal): void {
  const dup = seenSignatures.has(`${s.signature}:${s.wallet}`);
  seenSignatures.add(`${s.signature}:${s.wallet}`);
  if (dup) duplicates += 1;

  const stats = perWallet.get(s.wallet);
  if (!stats) {
    console.warn(`[unexpected] trade from a wallet we did not subscribe: ${s.wallet}`);
  }

  let note = '';
  if (s.side === 'buy') {
    if (stats) stats.buys += 1;
    const buyers = buyersByMint.get(s.mint) ?? new Set<string>();
    buyers.add(s.wallet);
    buyersByMint.set(s.mint, buyers);
    if (buyers.size > 1) note = ` ⚠ ${buyers.size} watched wallets in this token (duplicate_token case)`;
  } else {
    if (stats) stats.sells += 1;
    if (s.sellPct === null) {
      if (stats) stats.sellsWithoutPct += 1;
      note = ' ⚠ no newTokenBalance → sell % unknown';
    }
    if (!buyersByMint.get(s.mint)?.has(s.wallet)) {
      sellsWithoutSeenBuy += 1;
      note += ' (no buy seen in this run → no_position case)';
    }
  }
  pools.set(s.pool, (pools.get(s.pool) ?? 0) + 1);

  const pct = s.side === 'sell' ? ` sell%=${s.sellPct === null ? '?' : s.sellPct.toFixed(1)}` : '';
  const price = s.targetPriceSol === null ? '?' : s.targetPriceSol.toExponential(4);
  console.log(
    `${s.detectedAt.toISOString()} ${s.side.toUpperCase().padEnd(4)} ${short(s.wallet)} ${s.mint} ` +
      `sol=${s.solAmount.toFixed(4)} tokens=${s.tokenAmount.toFixed(0)}${pct} pool=${s.pool} price=${price}` +
      (dup ? ' [DUPLICATE signature]' : '') +
      note,
  );
  record({ type: 'signal', signal: { ...s, detectedAt: s.detectedAt.toISOString() } });
}

function summary(final = false): void {
  const upMin = ((Date.now() - startedAt.getTime()) / 60000).toFixed(1);
  const blind = blindMs + (disconnectedAt ? Date.now() - disconnectedAt.getTime() : 0);
  console.log(`\n── ${final ? 'FINAL ' : ''}summary · up ${upMin} min ──────────────────────────`);
  for (const [w, st] of perWallet) {
    console.log(`  ${w}  buys=${st.buys} sells=${st.sells}${st.sellsWithoutPct ? ` sells-without-%=${st.sellsWithoutPct}` : ''}`);
  }
  const multi = [...buyersByMint.entries()].filter(([, b]) => b.size > 1).length;
  console.log(
    `  pools=${JSON.stringify(Object.fromEntries(pools))} duplicate-signatures=${duplicates} ` +
      `tokens-with-2+-wallets=${multi} sells-without-seen-buy=${sellsWithoutSeenBuy} unparsed=${unparsedCount}`,
  );
  console.log(`  disconnects=${disconnects} blind-time=${(blind / 1000).toFixed(0)}s${fileOk ? ` · file ${outFile}` : ''}`);
  console.log('──────────────────────────────────────────────────────────\n');
}

const source = new PumpPortalSource({
  apiKey,
  url: process.env.PUMPPORTAL_WS_URL, // override only for local testing
  log: (m) => console.log(`${new Date().toISOString()} ${m}`),
  onSignal,
  onUnparsed: (raw) => {
    unparsedCount += 1;
    console.log(`${new Date().toISOString()} [unparsed] ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`);
    record({ type: 'unparsed', raw });
  },
  onStatus: (st) => {
    if (st.kind === 'disconnected') {
      disconnects += 1;
      disconnectedAt ??= st.at;
      record({ type: 'gap_start', reason: st.reason });
    } else if (st.kind === 'connected' && disconnectedAt) {
      const gap = st.at.getTime() - disconnectedAt.getTime();
      blindMs += gap;
      console.log(`${st.at.toISOString()} [gap] blind for ${(gap / 1000).toFixed(1)}s — trades in this window were missed`);
      record({ type: 'gap_end', blindMs: gap, since: disconnectedAt.toISOString() });
      disconnectedAt = null;
    }
  },
});

console.log(`\n=== Hermes — PumpPortal smoke test (observe only) ===`);
console.log(`Watching ${wallets.length} wallet(s):`);
for (const w of wallets) console.log(`  ${w}`);
console.log(fileOk ? `Recording to ${outFile}` : 'File output disabled — stdout only');
console.log('Waiting for trades… (Ctrl+C to stop)\n');

record({ type: 'start', wallets });
source.setWallets(wallets);
source.start();

setInterval(() => summary(), Math.max(1, summaryMin) * 60_000).unref();

function shutdown(): void {
  summary(true);
  record({ type: 'stop' });
  source.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
