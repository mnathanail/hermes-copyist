import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logEvent } from './logger.js';
import type { WatchlistWallet } from '../types/index.js';

export interface DetectedBuy {
  wallet: WatchlistWallet;
  mint: string;
  solAmount: number;
  dexs: string[];
  parentSignature: string;
}

/**
 * Watches every ACTIVE wallet in watchlist_wallets over a single CoinVera
 * WebSocket connection. Emits 'buy' events; does not decide auto/manual
 * or execute anything itself — that split lives in index.ts, matching the
 * "watcher observes, engine acts" separation agreed during planning.
 *
 * Subscribe payload (`{ apiKey, method: 'subscribeTrade', tokens: [...] }`)
 * and trade message shape (`signer`, `ca`, `trade`, `solAmount`, `dexs`)
 * confirmed against ahk780/solana-copy-trading-bot's websocket.js — a
 * server-side reference implementation from the same author as the
 * browser-based repo this project was originally inspired by.
 *
 * One caveat: that reference only ever populated `tokens` with a single
 * wallet. The array shape strongly implies multi-address support, but
 * it's worth a smoke test with 2+ real addresses before relying on it
 * in production.
 */
export class WalletWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private watchedWallets = new Map<string, WatchlistWallet>();
  private staticAddresses: string[] | null;

  /**
   * Pass `staticAddresses` to watch a fixed list of wallets without any
   * Postgres dependency — this is what scripts/smoke-test.ts uses, so the
   * WS contract can be verified before the DB/dashboard exist at all.
   * Leave it undefined for normal operation (reads watchlist_wallets).
   */
  constructor(staticAddresses?: string[]) {
    super();
    this.staticAddresses = staticAddresses ?? null;
  }

  async start(): Promise<void> {
    await this.refreshWatchlist();
    this.connect();
  }

  async refreshWatchlist(): Promise<void> {
    this.watchedWallets.clear();

    if (this.staticAddresses) {
      for (const address of this.staticAddresses) {
        this.watchedWallets.set(address, {
          id: -1, address, owner: null, label: 'smoke-test', active: true, strategyId: null,
        });
      }
    } else {
      const { rows } = await pool.query<{
        id: number; address: string; owner: string | null;
        label: string | null; active: boolean; strategy_id: number | null;
      }>(`SELECT id, address, owner, label, active, strategy_id FROM watchlist_wallets WHERE active = true`);

      for (const row of rows) {
        this.watchedWallets.set(row.address, {
          id: row.id,
          address: row.address,
          owner: row.owner,
          label: row.label,
          active: row.active,
          strategyId: row.strategy_id,
        });
      }
    }

    await logEvent({
      category: 'system',
      level: 'info',
      message: `Watchlist refreshed: ${this.watchedWallets.size} active wallet(s)`,
    });

    // If already connected, re-subscribe with the fresh address list.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribe();
    }
  }

  private connect(): void {
    this.ws = new WebSocket(config.coinveraWsUrl);

    this.ws.on('open', () => {
      logEvent({ category: 'system', level: 'success', message: 'Connected to CoinVera WS' });
      this.subscribe();
      this.pingInterval = setInterval(() => this.ws?.ping(), 5000);
    });

    this.ws.on('message', (raw) => this.handleMessage(raw));

    this.ws.on('close', () => {
      logEvent({ category: 'system', level: 'warning', message: 'CoinVera WS closed, reconnecting in 3s' });
      if (this.pingInterval) clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', (err) => {
      logEvent({ category: 'error', level: 'error', message: `CoinVera WS error: ${err.message}` });
    });
  }

  private subscribe(): void {
    const addresses = [...this.watchedWallets.keys()];
    this.ws?.send(JSON.stringify({
      method: 'subscribeTrade',
      apiKey: config.coinveraApiKey,
      tokens: addresses,
    }));
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let data: any;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Subscription ack — not a trade event, nothing to do but could be logged.
    if (data?.type === 'subscribeTrade') {
      this.emit('raw', data);
      return;
    }

    this.emit('raw', data);

    // Confirmed shape: { signer, signature, dexs, ca, trade, solAmount, tokenAmount }.
    // A buy is `trade === 'buy'` AND `solAmount < 0` (SOL leaving the signer's
    // wallet) — checking both, same as the reference implementation, guards
    // against acting on a malformed or ambiguous message.
    if (data?.trade !== 'buy' || !(data.solAmount < 0)) return;

    const wallet = this.watchedWallets.get(data.signer);
    if (!wallet) return; // trade from a signer we're not watching (or already removed)

    const detected: DetectedBuy = {
      wallet,
      mint: data.ca,
      solAmount: Math.abs(data.solAmount),
      dexs: data.dexs ?? [],
      parentSignature: data.signature,
    };

    this.emit('buy', detected);
  }

  stop(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.ws?.close();
  }
}
