import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { PumpPortalSource, type Timers, type WebSocketLike } from './pumpPortalSource.js';
import type { SourceStatus, TradeSignal } from './types.js';

class FakeSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  sent: any[] = [];
  pings = 0;
  terminated = false;
  constructor(readonly url: string) {
    super();
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send while not OPEN');
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
    setInterval: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      intervals.push(h);
      return h;
    },
    clearInterval: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  const signals: TradeSignal[] = [];
  const unparsed: unknown[] = [];
  const statuses: SourceStatus[] = [];
  const source = new PumpPortalSource({
    apiKey: 'test-key-1234567890',
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    timers,
    random: () => 0.5,
    onSignal: (s) => signals.push(s),
    onUnparsed: (r) => unparsed.push(r),
    onStatus: (s) => statuses.push(s),
  });
  return { source, sockets, timeouts, intervals, signals, unparsed, statuses };
}

const TRADE = {
  signature: 'sig1',
  mint: 'mint1',
  traderPublicKey: 'walletA',
  txType: 'sell',
  tokenAmount: 100,
  solAmount: 0.5,
  newTokenBalance: 300,
  pool: 'pump',
};

test('does not send before OPEN; subscribes all wallets in one message on open', () => {
  const h = harness();
  h.source.setWallets(['walletA', 'walletB']);
  h.source.start();
  assert.equal(h.sockets.length, 1);
  assert.ok(h.sockets[0].url.includes('api-key=test-key-1234567890'));
  h.source.setWallets(['walletA', 'walletB', 'walletC']); // CONNECTING: must not throw
  h.sockets[0].open();
  assert.deepEqual(h.sockets[0].sent, [{ method: 'subscribeAccountTrade', keys: ['walletA', 'walletB', 'walletC'] }]);
});

test('setWallets while open sends only the diff', () => {
  const h = harness();
  h.source.setWallets(['walletA', 'walletB']);
  h.source.start();
  h.sockets[0].open();
  h.sockets[0].sent = [];
  h.source.setWallets(['walletB', 'walletC']);
  assert.deepEqual(h.sockets[0].sent, [
    { method: 'subscribeAccountTrade', keys: ['walletC'] },
    { method: 'unsubscribeAccountTrade', keys: ['walletA'] },
  ]);
});

test('trade messages become signals; ack is swallowed; unknown goes to onUnparsed', () => {
  const h = harness();
  h.source.start();
  h.sockets[0].open();
  h.sockets[0].emit('message', JSON.stringify({ message: 'Successfully subscribed to keys.' }));
  h.sockets[0].emit('message', Buffer.from(JSON.stringify(TRADE)));
  h.sockets[0].emit('message', JSON.stringify({ txType: 'create', mint: 'x' }));
  h.sockets[0].emit('message', 'not json');
  assert.equal(h.signals.length, 1);
  assert.equal(h.signals[0].sellPct, 25);
  assert.equal(h.unparsed.length, 2);
});

test('close → disconnected status → reconnect → resubscribe', () => {
  const h = harness();
  h.source.setWallets(['walletA']);
  h.source.start();
  h.sockets[0].open();
  h.sockets[0].close();
  assert.equal(h.statuses.at(-1)?.kind, 'disconnected');
  assert.equal(h.timeouts.length, 1);
  assert.equal(h.timeouts[0].ms, 1000); // first backoff, jitter factor 1.0 at random=0.5
  h.timeouts[0].fn();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].open();
  assert.deepEqual(h.sockets[1].sent, [{ method: 'subscribeAccountTrade', keys: ['walletA'] }]);
});

test('rejected handshake (unexpected-response) still reconnects — the Argus 27h bug', () => {
  const h = harness();
  h.source.start();
  let destroyed = false;
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = 502;
  h.sockets[0].emit('unexpected-response', { destroy: () => (destroyed = true) }, response);
  assert.equal(destroyed, true);
  assert.equal(h.timeouts.length, 1);
  // A late 'close' from the same dead socket must not schedule a second reconnect.
  h.sockets[0].emit('close');
  assert.equal(h.timeouts.length, 1);
});

test('heartbeat: missing pong terminates and reconnects', () => {
  const h = harness();
  h.source.start();
  h.sockets[0].open();
  const beat = h.intervals[0];
  beat.fn(); // ping sent
  assert.equal(h.sockets[0].pings, 1);
  h.sockets[0].emit('pong');
  beat.fn(); // pong arrived → ping again
  assert.equal(h.sockets[0].pings, 2);
  beat.fn(); // no pong this time → terminate
  assert.equal(h.sockets[0].terminated, true);
  assert.equal(beat.cleared, true);
  assert.equal(h.timeouts.length, 1);
});

test('stop() does not reconnect', () => {
  const h = harness();
  h.source.start();
  h.sockets[0].open();
  h.source.stop();
  assert.equal(h.timeouts.length, 0);
});

test('backoff grows and caps at 30s', () => {
  const h = harness();
  h.source.start();
  for (let i = 0; i < 7; i++) {
    h.sockets.at(-1)!.close();
    h.timeouts.at(-1)!.fn();
  }
  assert.deepEqual(
    h.timeouts.map((t) => t.ms),
    [1000, 2000, 5000, 10000, 30000, 30000, 30000],
  );
});
