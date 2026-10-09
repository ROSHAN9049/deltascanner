import test from 'node:test';
import assert from 'node:assert/strict';
import { OPTION_UNDERLYINGS, tradetronRouteBlocker } from '../worker/engine.mjs';

test('Options universe is restricted to BTC, ETH and Gold (XAUT)', () => {
  assert.deepEqual([...OPTION_UNDERLYINGS], ['BTC', 'ETH', 'XAUT']);
});

test('a confirmed futures signal outside the configured Tradetron route is not READY', () => {
  const blocker = tradetronRouteBlocker({
    signalOnly: true,
    bridgeEnabled: true,
    strategy: 'MOMENTUM',
    signal: { symbol: 'DOGEUSD', side: 'BUY', stage: 'CONFIRMED' },
    bridge: { isConfigured: () => false }
  });
  assert.equal(blocker, 'Tradetron route unavailable: DOGEUSD');
});

test('a configured futures bridge passes the route-readiness gate', () => {
  const blocker = tradetronRouteBlocker({
    signalOnly: true,
    bridgeEnabled: true,
    strategy: 'SCALPING',
    signal: { symbol: 'BTCUSD', side: 'SELL', stage: 'CONFIRMED' },
    bridge: { isConfigured: () => true }
  });
  assert.equal(blocker, '');
});

test('unconfirmed signals do not get misleading route-only blockers', () => {
  const blocker = tradetronRouteBlocker({
    signalOnly: true,
    bridgeEnabled: true,
    strategy: 'MOMENTUM',
    signal: { symbol: 'DOGEUSD', side: 'BUY', stage: 'SETUP' },
    bridge: { isConfigured: () => false }
  });
  assert.equal(blocker, '');
});
