import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaEngine, OPTION_UNDERLYINGS, duplicatePositionBlocker, tradetronRouteBlocker } from '../worker/engine.mjs';

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


test('multiple distinct open positions do not trigger a global scanner cap', () => {
  const positions = Array.from({ length: 12 }, (_, index) => ({
    symbol: 'COIN' + index + 'USD',
    qty: 1,
    strategy: index % 2 ? 'SCALPING' : 'MOMENTUM'
  }));
  assert.equal(duplicatePositionBlocker(positions, 'NEWDISCOVERYUSD'), '');
});

test('same-symbol duplicate protection remains active with position caps removed', () => {
  assert.equal(duplicatePositionBlocker([
    { symbol: 'BTCUSD', qty: 1, origin: 'TRADETRON' },
    { symbol: 'ETHUSD', qty: 2, origin: 'TRADETRON' }
  ], 'BTCUSD'), 'Duplicate symbol');
  assert.equal(duplicatePositionBlocker([
    { symbol: 'BTCUSD', qty: 0, origin: 'TRADETRON' }
  ], 'BTCUSD'), '');
});

test('daily PnL does not create a scanner-side daily loss gate', async () => {
  const engine = new DeltaEngine();
  const settings = {
    enabled: true, auto_trade: true, emergency_stop: false, continuous_mode: true,
    risk_pct: 0.3, max_leverage: 3, score_min: 65
  };
  const gate = await engine.riskGate(
    { blocked: [], symbol: 'BTCUSD', stage: 'SETUP', side: null, candlesFresh: true },
    'MOMENTUM',
    { equity: 100, available: 100 },
    settings,
    [],
    [{ closed_at: new Date().toISOString(), net_pnl: -100 }]
  );
  assert.equal(gate.reasons.some(reason => /daily loss|daily trade/i.test(reason)), false);
});
