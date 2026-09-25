import WebSocket from 'ws';
import { isSubscribeAck, parsePumpPortalTrade } from './pumpPortalEvents.js';
import type { SignalSource, SignalSourceHandlers } from './types.js';

/**
 * PumpPortal data websocket as a SignalSource.
 *
 * Ported from ArgusTrench's pumpportalConnection.ts, keeping the fixes for
 * the three production incidents recorded there:
 *
 * 1. (2026-09-09) ws.send() on a socket that exists but is still CONNECTING
 *    throws, and the uncaught exception crash-looped the process. → send()
 *    only when readyState === OPEN; the wallet set is remembered and
 *    re-sent on every 'open'.
 * 2. (2026-09-22/24) Merely attaching an 'unexpected-response' listener
 *    stops `ws` from calling its own abortHandshake(), so a rejected
 *    handshake (403/502) never emits 'close' and the reconnect never
 *    happens — Argus sat deaf for 27 hours. → the handler below destroys
 *    the request and schedules the reconnect itself.
 * 3. Reconnects must resubscribe everything: a fresh connection starts with
 *    zero subscriptions server-side.
 *
 * Added here: a ping/pong heartbeat. A half-open TCP connection delivers no
 * 'close' and no messages, which for a mirror bot looks exactly like "the
 * wallets are quiet". No pong within one interval → terminate → reconnect.
 *
 * PumpPortal rule: ONE connection per client, all subscriptions on it.
 * Opening one per wallet gets the key banned.
 */

const WS_OPEN = 1;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const HEARTBEAT_MS = 30_000;

/** The subset of ws.WebSocket we use — lets tests inject a fake socket. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  ping?(): void;
  terminate?(): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PumpPortalSourceOptions extends SignalSourceHandlers {
  apiKey: string;
  url?: string;
  createSocket?: (url: string) => WebSocketLike;
  timers?: Timers;
  random?: () => number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export function maskKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '(short key)';
}

export class PumpPortalSource implements SignalSource {
  readonly name = 'pumpportal';

  private socket: WebSocketLike | null = null;
  private wallets = new Set<string>();
  private reconnectAttempt = 0;
  private stopped = true;
  private heartbeat: unknown = null;
  private awaitingPong = false;

  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: PumpPortalSourceOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.timers = options.timers ?? realTimers;
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => {});
  }

  get watchedWallets(): string[] {
    return [...this.wallets];
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  setWallets(addresses: string[]): void {
    const next = new Set(addresses.map((a) => a.trim()).filter(Boolean));
    const added = [...next].filter((a) => !this.wallets.has(a));
    const removed = [...this.wallets].filter((a) => !next.has(a));
    this.wallets = next;
    if (added.length > 0) this.send({ method: 'subscribeAccountTrade', keys: added });
    if (removed.length > 0) this.send({ method: 'unsubscribeAccountTrade', keys: removed });
  }

  private connect(): void {
    const base = this.options.url ?? 'wss://pumpportal.fun/api/data';
    this.log(`[pumpportal] connecting (key ${maskKey(this.options.apiKey)})`);
    const socket = this.createSocket(`${base}?api-key=${this.options.apiKey}`);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.options.onStatus?.({ kind: 'connected', at: new Date() });
      this.log('[pumpportal] connected');
      this.resubscribeAll();
      this.startHeartbeat(socket);
    });

    socket.on('message', (data: unknown) => this.handleMessage(data));

    socket.on('pong', () => {
      this.awaitingPong = false;
    });

    socket.on('close', () => this.handleDrop(socket, 'socket closed'));

    socket.on('error', (error: Error) => {
      // 'close' follows an error; the reconnect is scheduled there, not here.
      this.log(`[pumpportal] error: ${error.message}`);
    });

    socket.on('unexpected-response', (request: { destroy(): void }, response: any) => {
      const chunks: Buffer[] = [];
      response?.on?.('data', (chunk: Buffer) => chunks.push(chunk));
      response?.on?.('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
        this.log(`[pumpportal] handshake rejected: status=${response?.statusCode} body=${body || '(empty)'}`);
      });
      request.destroy();
      this.handleDrop(socket, `handshake rejected (${response?.statusCode ?? '?'})`);
    });
  }

  private handleMessage(data: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      this.options.onUnparsed?.(data);
      return;
    }
    if (isSubscribeAck(json)) {
      this.log(`[pumpportal] ack: ${(json as { message: string }).message}`);
      return;
    }
    const signal = parsePumpPortalTrade(json);
    if (signal) {
      this.options.onSignal(signal);
    } else {
      this.options.onUnparsed?.(json);
    }
  }

  /** Single path for every way a connection can die, so we reconnect exactly once. */
  private handleDrop(socket: WebSocketLike, reason: string): void {
    if (this.socket !== socket) return; // stale socket, already handled
    this.socket = null;
    this.stopHeartbeat();
    if (this.stopped) return;
    this.options.onStatus?.({ kind: 'disconnected', at: new Date(), reason });
    this.log(`[pumpportal] disconnected (${reason}) — reconnecting`);
    const index = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const base = RECONNECT_BACKOFF_MS[index] ?? 30_000;
    const delay = Math.round(base * (0.85 + this.random() * 0.3));
    this.reconnectAttempt += 1;
    this.timers.setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  private resubscribeAll(): void {
    if (this.wallets.size === 0) return;
    this.send({ method: 'subscribeAccountTrade', keys: [...this.wallets] });
    this.options.onStatus?.({ kind: 'subscribed', at: new Date(), wallets: this.wallets.size });
  }

  private startHeartbeat(socket: WebSocketLike): void {
    this.stopHeartbeat();
    if (!socket.ping) return;
    this.awaitingPong = false;
    this.heartbeat = this.timers.setInterval(() => {
      if (this.socket !== socket) return;
      if (this.awaitingPong) {
        this.log('[pumpportal] no pong within heartbeat — terminating half-open socket');
        if (socket.terminate) socket.terminate();
        else socket.close();
        this.handleDrop(socket, 'heartbeat timeout');
        return;
      }
      this.awaitingPong = true;
      socket.ping?.();
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private send(payload: Record<string, unknown>): void {
    // Not connected, or still CONNECTING: fine — resubscribeAll() on 'open' sends it.
    if (this.socket === null || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }
}
