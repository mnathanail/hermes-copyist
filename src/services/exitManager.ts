import { pool } from '../db/pool.js';
import { logEvent } from './logger.js';
import { executeOrder } from './solanaExecution.js';
import type { ExitStrategy, ExitStrategyTier, ExitTriggerType, Position } from '../types/index.js';

const DEFAULT_SLIPPAGE_PCT = 15;
const DEFAULT_JITO_TIP = 0.0005;

interface StrategyWithTiers extends ExitStrategy {
  tiers: ExitStrategyTier[];
}

/**
 * Resolves a position's exit strategy: the wallet's explicit strategy_id,
 * or the "default" strategy as fallback. v1 has exactly one strategy row,
 * but this lookup is what makes low/medium/risky presets a data change
 * later instead of a code change.
 */
export async function getStrategyForPosition(positionWalletId: number): Promise<StrategyWithTiers> {
  const { rows: walletRows } = await pool.query<{ strategy_id: number | null }>(
    `SELECT strategy_id FROM watchlist_wallets WHERE id = $1`,
    [positionWalletId],
  );

  const strategyId = walletRows[0]?.strategy_id;

  const { rows: strategyRows } = await pool.query<{
    id: number; name: string; stop_loss_pct: string; timeout_ms: string;
  }>(
    strategyId
      ? `SELECT * FROM exit_strategies WHERE id = $1`
      : `SELECT * FROM exit_strategies WHERE name = 'default'`,
    strategyId ? [strategyId] : [],
  );

  const strategy = strategyRows[0];
  const { rows: tierRows } = await pool.query<{
    id: number; strategy_id: number; tier_order: number; trigger_pct: string; sell_portion_pct: string;
  }>(`SELECT * FROM exit_strategy_tiers WHERE strategy_id = $1 ORDER BY tier_order ASC`, [strategy.id]);

  return {
    id: strategy.id,
    name: strategy.name,
    stopLossPct: Number(strategy.stop_loss_pct),
    timeoutMs: Number(strategy.timeout_ms),
    tiers: tierRows.map((t) => ({
      id: t.id,
      strategyId: t.strategy_id,
      tierOrder: t.tier_order,
      triggerPct: Number(t.trigger_pct),
      sellPortionPct: Number(t.sell_portion_pct),
    })),
  };
}

/** How many take_profit_tier fills already happened for this position. */
async function countFiredTiers(positionId: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM exit_fills WHERE position_id = $1 AND trigger_type = 'take_profit_tier'`,
    [positionId],
  );
  return Number(rows[0].count);
}

/**
 * Core exit executor. Sells `portionPct` of the position's CURRENT
 * remaining token amount (not the original total) — so tier percentages
 * compound the way you'd expect ("sell 25% of what's left"), and a
 * manual "sell 30%" always means 30% of what's open right now.
 */
async function performExit(
  position: Position,
  portionPct: number,
  triggerType: ExitTriggerType,
  requestedPct?: number,
): Promise<void> {
  const correlationId = `position:${position.id}`;
  const tokenAmountToSell = position.tokenAmountRemaining * (portionPct / 100);

  await logEvent({
    correlationId,
    category: 'exit',
    level: 'info',
    message: `Exiting ${portionPct}% of remaining (${tokenAmountToSell}) via ${triggerType}`,
  });

  const signature = await executeOrder(
    correlationId,
    'sell',
    position.mint,
    tokenAmountToSell,
    DEFAULT_SLIPPAGE_PCT,
    DEFAULT_JITO_TIP,
    position.dex,
  );

  const newRemaining = position.tokenAmountRemaining - tokenAmountToSell;
  const closed = newRemaining <= 0.000001;

  await pool.query(
    `INSERT INTO exit_fills (position_id, trigger_type, requested_pct, token_amount_sold, signature)
     VALUES ($1, $2, $3, $4, $5)`,
    [position.id, triggerType, requestedPct ?? null, tokenAmountToSell, signature],
  );

  await pool.query(
    `UPDATE positions SET token_amount_remaining = $1, status = $2, closed_at = $3 WHERE id = $4`,
    [Math.max(newRemaining, 0), closed ? 'closed' : 'open', closed ? new Date() : null, position.id],
  );

  await logEvent({
    correlationId,
    category: 'exit',
    level: 'success',
    message: closed ? `Position fully closed via ${triggerType}` : `Partial exit recorded via ${triggerType}`,
    context: { signature, remaining: Math.max(newRemaining, 0) },
  });
}

/** Manual partial sell — only valid for management_mode = 'manual' positions. */
export async function manualPartialSell(position: Position, requestedPct: number): Promise<void> {
  await performExit(position, requestedPct, 'manual_partial', requestedPct);
}

/** Panic sell — always available, any mode, always 100% of remaining. */
export async function panicSell(position: Position): Promise<void> {
  await performExit(position, 100, 'panic_full');
}

/**
 * Auto-mode evaluation, called by positionMonitor on each price check.
 * Only ever called for management_mode = 'auto' positions — manual
 * positions never get an automatic exit (by design, see planning notes).
 */
export async function evaluateAutoExit(position: Position, currentPriceUsd: number): Promise<void> {
  const strategy = await getStrategyForPosition(position.walletId);
  const pnlPct = ((currentPriceUsd / (position.entryPriceUsd ?? currentPriceUsd)) - 1) * 100;
  const heldMs = Date.now() - position.openedAt.getTime();

  if (pnlPct <= -strategy.stopLossPct) {
    await performExit(position, 100, 'stop_loss');
    return;
  }

  if (heldMs >= strategy.timeoutMs) {
    await performExit(position, 100, 'timeout');
    return;
  }

  const firedCount = await countFiredTiers(position.id);
  const nextTier = strategy.tiers[firedCount];
  if (nextTier && pnlPct >= nextTier.triggerPct) {
    await performExit(position, nextTier.sellPortionPct, 'take_profit_tier');
  }
}
