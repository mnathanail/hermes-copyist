import type { TradeSignal } from './types.js';

/**
 * PumpPortal `subscribeAccountTrade` message → TradeSignal.
 *
 * Field set confirmed by a real event captured in ArgusTrench on
 * 2026-09-09 (see pumpPortalEvents.test.ts — it is a trade by one of the
 * wallets we now watch): signature, mint, traderPublicKey, txType,
 * tokenAmount, solAmount, newTokenBalance, bondingCurveKey,
 * vTokensInBondingCurve, vSolInBondingCurve, marketCapSol, pool.
 *
 * Deliberately more lenient than Argus's parser: only the fields the
 * mirror engine cannot work without are required. The bonding-curve
 * fields are optional because a PumpSwap (`pool: 'pump-amm'`) trade has
 * not been captured yet and may not carry them — Argus's strict parser
 * would silently drop such a trade, which for a mirror bot means a missed
 * sell. Anything that fails parsing goes to onUnparsed and is logged raw.
 */
const REQUIRED_STRING_FIELDS = ['signature', 'mint', 'traderPublicKey'] as const;

/**
 * If the target keeps less than this share of its pre-sell holding, treat
 * the sell as a full exit. Wallets often leave dust (rounding, fees); we
 * should not keep 0.3% of a position open because of it.
 */
export const DUST_SHARE = 0.001;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Share (0–100) of the target's holding sold in this trade.
 * tokenAmount / (tokenAmount + balanceAfter). null if balanceAfter is unknown.
 */
export function computeSellPct(tokenAmount: number, balanceAfter: number | null): number | null {
  if (balanceAfter === null) return null;
  if (tokenAmount <= 0) return 0;
  const before = tokenAmount + Math.max(balanceAfter, 0);
  if (Math.max(balanceAfter, 0) / before < DUST_SHARE) return 100;
  return Math.min(100, (tokenAmount / before) * 100);
}

export function parsePumpPortalTrade(raw: unknown, detectedAt: Date = new Date()): TradeSignal | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  for (const key of REQUIRED_STRING_FIELDS) {
    if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) return null;
  }
  if (obj.txType !== 'buy' && obj.txType !== 'sell') return null;

  const tokenAmount = num(obj.tokenAmount);
  const solAmountRaw = num(obj.solAmount);
  if (tokenAmount === null || solAmountRaw === null) return null;

  const solAmount = Math.abs(solAmountRaw);
  const absTokens = Math.abs(tokenAmount);
  const balanceAfter = num(obj.newTokenBalance);
  const side = obj.txType;

  return {
    source: 'pumpportal',
    side,
    wallet: obj.traderPublicKey as string,
    mint: obj.mint as string,
    signature: obj.signature as string,
    solAmount,
    tokenAmount: absTokens,
    targetBalanceAfter: balanceAfter,
    sellPct: side === 'sell' ? computeSellPct(absTokens, balanceAfter) : null,
    pool: typeof obj.pool === 'string' ? obj.pool : 'unknown',
    targetPriceSol: absTokens > 0 ? solAmount / absTokens : null,
    marketCapSol: num(obj.marketCapSol),
    detectedAt,
    raw: obj,
  };
}

/** The ack PumpPortal sends after each subscribe — expected, not an anomaly. */
export function isSubscribeAck(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as Record<string, unknown>).message === 'string' &&
    ((raw as Record<string, unknown>).message as string).toLowerCase().includes('subscribed')
  );
}
