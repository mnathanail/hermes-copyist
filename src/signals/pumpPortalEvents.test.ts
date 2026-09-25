import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSellPct, isSubscribeAck, parsePumpPortalTrade } from './pumpPortalEvents.js';

/**
 * Real event captured by ArgusTrench on 2026-09-09 (subscribeAccountTrade).
 * The trader is one of Hermes's first watched wallets.
 */
const REAL_BUY_EVENT = {
  signature: '5EMqqRbMjAPF4tBPNw1TJNv6LcFyFMJ8rhXJfVihaZVSYkvorn2j85o4h222XGDretUX4MR54MsnRUhXuMfT6SiF',
  mint: '5ygJ27k1ZyUBdeR9LeNxQ5vZ4n4togt3kxxcYnHUpump',
  traderPublicKey: '3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5',
  txType: 'buy',
  tokenAmount: 30589322.786086,
  solAmount: 2.629842459,
  newTokenBalance: 30589322.786086,
  bondingCurveKey: 'B8b9eismEq7HFU8dhgongN354P6FfhWp81ghvdB8r5yL',
  vTokensInBondingCurve: 596796597.218102,
  vSolInBondingCurve: 53.93797509913754,
  marketCapSol: 90.37915991907988,
  pool: 'pump',
};

test('parses the real buy event', () => {
  const s = parsePumpPortalTrade(REAL_BUY_EVENT);
  assert.ok(s);
  assert.equal(s.side, 'buy');
  assert.equal(s.wallet, '3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5');
  assert.equal(s.mint, REAL_BUY_EVENT.mint);
  assert.equal(s.pool, 'pump');
  assert.equal(s.sellPct, null);
  assert.equal(s.targetBalanceAfter, REAL_BUY_EVENT.newTokenBalance);
  assert.ok(s.targetPriceSol !== null);
  // Target's execution price should sit near the bonding-curve price after the trade.
  const curvePrice = REAL_BUY_EVENT.vSolInBondingCurve / REAL_BUY_EVENT.vTokensInBondingCurve;
  assert.ok(Math.abs(s.targetPriceSol - curvePrice) / curvePrice < 0.1);
});

test('sell of half the holding → 50%', () => {
  const s = parsePumpPortalTrade({ ...REAL_BUY_EVENT, txType: 'sell', tokenAmount: 1000, newTokenBalance: 1000 });
  assert.equal(s?.side, 'sell');
  assert.equal(s?.sellPct, 50);
});

test('sell that leaves 0 → 100%', () => {
  const s = parsePumpPortalTrade({ ...REAL_BUY_EVENT, txType: 'sell', tokenAmount: 1000, newTokenBalance: 0 });
  assert.equal(s?.sellPct, 100);
});

test('sell that leaves only dust → 100%', () => {
  assert.equal(computeSellPct(1_000_000, 500), 100); // 0.05% left
  assert.ok(Math.abs((computeSellPct(1000, 3000) ?? 0) - 25) < 1e-9);
});

test('sell without newTokenBalance → sellPct null (unknown, engine decides)', () => {
  const { newTokenBalance: _omit, ...noBalance } = REAL_BUY_EVENT;
  const s = parsePumpPortalTrade({ ...noBalance, txType: 'sell' });
  assert.ok(s);
  assert.equal(s.sellPct, null);
});

test('PumpSwap-style event without bonding-curve fields still parses', () => {
  const { vTokensInBondingCurve: _a, vSolInBondingCurve: _b, bondingCurveKey: _c, marketCapSol: _d, ...amm } = REAL_BUY_EVENT;
  const s = parsePumpPortalTrade({ ...amm, pool: 'pump-amm' });
  assert.ok(s);
  assert.equal(s.pool, 'pump-amm');
  assert.equal(s.marketCapSol, null);
});

test('negative solAmount is normalized to positive', () => {
  const s = parsePumpPortalTrade({ ...REAL_BUY_EVENT, solAmount: -1.5 });
  assert.equal(s?.solAmount, 1.5);
});

test('non-trades return null instead of throwing', () => {
  assert.equal(parsePumpPortalTrade(null), null);
  assert.equal(parsePumpPortalTrade('text'), null);
  assert.equal(parsePumpPortalTrade({}), null);
  assert.equal(parsePumpPortalTrade({ ...REAL_BUY_EVENT, txType: 'create' }), null);
  assert.equal(parsePumpPortalTrade({ ...REAL_BUY_EVENT, signature: '' }), null);
  assert.equal(parsePumpPortalTrade({ ...REAL_BUY_EVENT, tokenAmount: 'x' }), null);
});

test('subscribe ack is recognized', () => {
  assert.equal(isSubscribeAck({ message: 'Successfully subscribed to keys.' }), true);
  assert.equal(isSubscribeAck(REAL_BUY_EVENT), false);
});
