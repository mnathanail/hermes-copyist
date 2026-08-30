import { pool } from '../db/pool.js';
import type { TradingMode } from '../types/index.js';

/**
 * Reads the CURRENT global mode fresh on every call — deliberately not
 * cached in memory. Positions snapshot management_mode at open time
 * (see positions.management_mode), so the only thing that needs to be
 * "live" is the decision made for a brand-new incoming signal.
 */
export async function getTradingMode(): Promise<TradingMode> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'trading_mode'`,
  );
  return (rows[0]?.value as TradingMode) ?? 'auto';
}

export async function setTradingMode(mode: TradingMode): Promise<void> {
  await pool.query(
    `UPDATE settings SET value = $1, updated_at = now() WHERE key = 'trading_mode'`,
    [mode],
  );
}

export async function getAutoBuyAmountSol(): Promise<number> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'auto_buy_amount_sol'`,
  );
  return Number(rows[0]?.value ?? '0.1');
}

export async function setAutoBuyAmountSol(amountSol: number): Promise<void> {
  await pool.query(
    `UPDATE settings SET value = $1, updated_at = now() WHERE key = 'auto_buy_amount_sol'`,
    [String(amountSol)],
  );
}
