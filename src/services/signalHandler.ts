import { pool } from '../db/pool.js';
import { logEvent } from './logger.js';
import { getTradingMode, getAutoBuyAmountSol } from './settingsService.js';
import { canOpenPosition } from './riskGuard.js';
import { executeOrder, getActualTokenBalance } from './solanaExecution.js';
import { fetchTokenPrice } from './priceService.js';
import { mapDex } from './dexMapper.js';
import type { DetectedBuy } from './walletWatcher.js';

const DEFAULT_SLIPPAGE_PCT = 15;
const DEFAULT_JITO_TIP = 0.0005;

/** Broadcaster injected from api/server.ts so pending manual signals reach the dashboard live. */
export type NotifyFn = (event: { type: string; payload: unknown }) => void;
let notify: NotifyFn = () => {};
export function setNotifier(fn: NotifyFn): void {
  notify = fn;
}

/**
 * Entry point for every detected buy from a watched wallet. This is where
 * the auto/manual fork happens — see planning notes: the mode captured
 * here (mode_at_detection / management_mode) is a snapshot, immune to
 * later global toggle changes.
 */
export async function handleDetectedBuy(detected: DetectedBuy): Promise<void> {
  const mode = await getTradingMode();

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO signal_events (wallet_id, mint, sol_amount_detected, mode_at_detection, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
    [detected.wallet.id, detected.mint, detected.solAmount, mode],
  );
  const signalId = rows[0].id;
  const correlationId = `signal:${signalId}`;

  await logEvent({
    correlationId,
    category: 'signal',
    level: 'info',
    message: `Buy detected from wallet ${detected.wallet.owner ?? detected.wallet.address} for ${detected.mint} (mode=${mode})`,
    context: { dexs: detected.dexs, parentSignature: detected.parentSignature },
  });

  if (mode === 'manual') {
    notify({ type: 'pending_signal', payload: { signalId, ...detected } });
    await logEvent({ correlationId, category: 'signal', level: 'info', message: 'Manual mode — awaiting user decision, notification sent' });
    return;
  }

  // AUTO mode: check risk, then buy immediately.
  const buyAmountSol = await getAutoBuyAmountSol();
  const risk = await canOpenPosition(detected.wallet.id, detected.mint, buyAmountSol);

  if (!risk.allowed) {
    await pool.query(`UPDATE signal_events SET status = 'ignored' WHERE id = $1`, [signalId]);
    await logEvent({ correlationId, category: 'signal', level: 'warning', message: `Signal ignored: ${risk.reason}` });
    return;
  }

  await executeBuy(signalId, detected, buyAmountSol, 'auto');
}

/**
 * Shared by both auto-execution and the manual "Buy" button in the UI
 * (see api/server.ts) — the only difference is who decided the amount
 * and which management_mode gets locked onto the resulting position.
 *
 * Entry price/token amount are read back from chain + CoinVera AFTER
 * confirmation rather than estimated — see solanaExecution.getActualTokenBalance
 * for why (the confirmed CoinVera message has no per-unit price field
 * for OUR trade, only the copied wallet's amounts).
 */
export async function executeBuy(
  signalId: number,
  detected: DetectedBuy,
  solAmount: number,
  managementMode: 'auto' | 'manual',
): Promise<void> {
  const correlationId = `signal:${signalId}`;
  const dex = mapDex(detected.dexs);

  const signature = await executeOrder(
    correlationId,
    'buy',
    detected.mint,
    solAmount,
    DEFAULT_SLIPPAGE_PCT,
    DEFAULT_JITO_TIP,
    dex,
  );

  const [tokenAmount, price] = await Promise.all([
    getActualTokenBalance(detected.mint),
    fetchTokenPrice(detected.mint),
  ]);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO positions
       (wallet_id, signal_event_id, mint, dex, entry_price_sol, entry_price_usd,
        token_amount_total, token_amount_remaining, sol_size, management_mode, entry_signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10) RETURNING id`,
    [
      detected.wallet.id, signalId, detected.mint, dex,
      price?.priceInSol ?? null, price?.priceInUsd ?? null,
      tokenAmount, solAmount, managementMode, signature,
    ],
  );

  await pool.query(
    `UPDATE signal_events SET status = $1 WHERE id = $2`,
    [managementMode === 'auto' ? 'auto_executed' : 'executed_manually', signalId],
  );

  await logEvent({
    correlationId,
    category: 'execution',
    level: 'success',
    message: `Position #${rows[0].id} opened (${managementMode}) for ${detected.mint} on ${dex}`,
    context: { signature, solAmount, tokenAmount, entryPriceUsd: price?.priceInUsd },
  });
}
