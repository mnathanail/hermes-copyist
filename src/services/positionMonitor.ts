import { pool } from '../db/pool.js';
import { logEvent } from './logger.js';
import { fetchTokenPrice } from './priceService.js';
import { evaluateAutoExit } from './exitManager.js';
import type { Position } from '../types/index.js';

const CHECK_INTERVAL_MS = 10_000;
const CONCURRENCY = 5;

/**
 * Only ever evaluates positions with management_mode = 'auto'. Manual
 * positions are deliberately excluded here — their exit is entirely in
 * the user's hands via the Active Trades UI (partial sell / panic sell),
 * per the planning decision that manual mode means manual all the way.
 *
 * Runs checks with a small concurrency cap instead of the reference
 * implementation's fully sequential loop-with-delay, so this doesn't
 * slow to a crawl as the number of open positions grows.
 */
let running = false;

async function fetchOpenAutoPositions(): Promise<Position[]> {
  const { rows } = await pool.query(
    `SELECT * FROM positions WHERE status = 'open' AND management_mode = 'auto'`,
  );
  return rows.map(mapRow);
}

function mapRow(row: any): Position {
  return {
    id: row.id,
    walletId: row.wallet_id,
    signalEventId: row.signal_event_id,
    mint: row.mint,
    dex: row.dex,
    entryPriceSol: Number(row.entry_price_sol),
    entryPriceUsd: row.entry_price_usd !== null ? Number(row.entry_price_usd) : null,
    tokenAmountTotal: Number(row.token_amount_total),
    tokenAmountRemaining: Number(row.token_amount_remaining),
    solSize: Number(row.sol_size),
    managementMode: row.management_mode,
    status: row.status,
    entrySignature: row.entry_signature,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

async function checkOne(position: Position): Promise<void> {
  try {
    const price = await fetchTokenPrice(position.mint);
    if (!price) {
      await logEvent({
        correlationId: `position:${position.id}`,
        category: 'system',
        level: 'warning',
        message: `No price data for ${position.mint}, skipping this cycle`,
      });
      return;
    }
    await evaluateAutoExit(position, price.priceInUsd);
  } catch (err: any) {
    await logEvent({
      correlationId: `position:${position.id}`,
      category: 'error',
      level: 'error',
      message: `Error monitoring position: ${err.message}`,
    });
  }
}

async function tick(): Promise<void> {
  if (running) return; // prevent overlapping cycles
  running = true;
  try {
    const positions = await fetchOpenAutoPositions();
    for (let i = 0; i < positions.length; i += CONCURRENCY) {
      const batch = positions.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(checkOne));
    }
  } finally {
    running = false;
  }
}

export function startPositionMonitor(): NodeJS.Timeout {
  return setInterval(tick, CHECK_INTERVAL_MS);
}
