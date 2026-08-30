export type TradingMode = 'auto' | 'manual';

export type SignalStatus =
  | 'auto_executed'
  | 'pending'
  | 'executed_manually'
  | 'ignored'
  | 'expired';

export type PositionStatus = 'open' | 'closed';

export type ExitTriggerType =
  | 'take_profit_tier'
  | 'stop_loss'
  | 'timeout'
  | 'manual_partial'
  | 'panic_full';

export interface ExitStrategy {
  id: number;
  name: string;
  stopLossPct: number;
  timeoutMs: number;
}

export interface ExitStrategyTier {
  id: number;
  strategyId: number;
  tierOrder: number;
  triggerPct: number;
  sellPortionPct: number;
}

export interface WatchlistWallet {
  id: number;
  address: string;
  owner: string | null;
  label: string | null;
  active: boolean;
  strategyId: number | null;
}

export interface SignalEvent {
  id: number;
  walletId: number;
  mint: string;
  solAmountDetected: number;
  modeAtDetection: TradingMode;
  status: SignalStatus;
  createdAt: Date;
}

export interface Position {
  id: number;
  walletId: number;
  signalEventId: number | null;
  mint: string;
  dex: string; // SolanaPortal dex code, from dexMapper
  entryPriceSol: number;
  entryPriceUsd: number | null;
  tokenAmountTotal: number;
  tokenAmountRemaining: number;
  solSize: number;
  managementMode: TradingMode; // locked at open — see planning notes in CLAUDE.md
  status: PositionStatus;
  entrySignature: string;
  openedAt: Date;
  closedAt: Date | null;
}

export interface ExitFill {
  id: number;
  positionId: number;
  triggerType: ExitTriggerType;
  requestedPct: number | null;
  tokenAmountSold: number;
  solReceived: number | null;
  signature: string | null;
  executedAt: Date;
}

export type LogLevel = 'info' | 'warning' | 'error' | 'success';
export type LogCategory = 'signal' | 'execution' | 'exit' | 'manual_action' | 'system' | 'error';

export interface LogEventInput {
  correlationId?: string;
  category: LogCategory;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}
