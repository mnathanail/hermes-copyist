/**
 * Source-agnostic trade signal. Every signal source (PumpPortal today,
 * possibly Helius later for transfer detection) normalizes its own wire
 * format into this shape, so the mirror engine never sees vendor fields.
 */
export type TradeSide = 'buy' | 'sell';

export interface TradeSignal {
  source: string;
  side: TradeSide;
  /** The watched wallet that made the trade. */
  wallet: string;
  mint: string;
  /** The target's own transaction signature — the idempotency key. */
  signature: string;
  /** SOL the target spent (buy) or received (sell), always positive. */
  solAmount: number;
  /** Tokens the target bought or sold, always positive. */
  tokenAmount: number;
  /** Target's token balance for this mint right AFTER this trade, if the source reports it. */
  targetBalanceAfter: number | null;
  /**
   * Sells only: the share (0–100) of the target's holding that this sell
   * represents. This is what we mirror — "they sold 30%, we sell 30% of
   * ours". null when the source gives no balance to compute it from.
   */
  sellPct: number | null;
  /** 'pump' (bonding curve) or 'pump-amm' (PumpSwap); vendor string otherwise. */
  pool: string;
  /** The target's execution price in SOL per token (solAmount / tokenAmount). */
  targetPriceSol: number | null;
  marketCapSol: number | null;
  /** Our wall-clock receive time. PumpPortal sends no timestamp. */
  detectedAt: Date;
  /** Untouched vendor payload, kept for the event log and debugging. */
  raw: Record<string, unknown>;
}

export type SourceStatus =
  | { kind: 'connected'; at: Date }
  | { kind: 'disconnected'; at: Date; reason: string }
  | { kind: 'subscribed'; at: Date; wallets: number };

export interface SignalSourceHandlers {
  onSignal: (signal: TradeSignal) => void;
  /** Any message that is not a recognizable trade (acks, 'create' events, unknown shapes). */
  onUnparsed?: (raw: unknown) => void;
  /** Connection lifecycle — the engine records disconnected→connected windows as blind gaps. */
  onStatus?: (status: SourceStatus) => void;
  log?: (message: string) => void;
}

export interface SignalSource {
  readonly name: string;
  start(): void;
  stop(): void;
  /** Replaces the full set of watched wallets (adds and removes as needed). */
  setWallets(addresses: string[]): void;
}
