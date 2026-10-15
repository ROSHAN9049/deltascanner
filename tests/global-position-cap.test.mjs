import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_OPEN_POSITIONS,
  countOpenPositionSymbols,
  globalOpenPositionCapBlocker,
  isGlobalOpenPositionCapReached,
  normalizeMaxOpenPositions
} from '../src/open-position-cap.js';
import { evaluateGridTick } from '../worker/grid-strategy.mjs';

test('normalizes a positive integer cap and uses a conservative fallback', () => {
  assert.equal(normalizeMaxOpenPositions(3), 3);
  assert.equal(normalizeMaxOpenPositions(3.8), 3);
  assert.equal(normalizeMaxOpenPositions(0), DEFAULT_MAX_OPEN_POSITIONS);
  assert.equal(normalizeMaxOpenPositions('not-a-number'), DEFAULT_MAX_OPEN_POSITIONS);
});

test('counts unique, non-zero open symbols and pending signal reservations', () => {
  assert.equal(countOpenPositionSymbols([
    { symbol: 'BTCUSD', qty: 1 },
    { symbol: 'btcusd', qty: -2 },
    { symbol: 'ETHUSD', qty: 0 },
    { symbol: 'SOLUSD', qty: 1, origin: 'SIGNAL_RESERVATION' },
    { symbol: '', qty: 1 },
    { symbol: 'ADAUSD', qty: 'invalid' }
  ]), 2);
});

test('allows a new symbol below the cap', () => {
  assert.equal(globalOpenPositionCapBlocker([
    { symbol: 'BTCUSD', qty: 1 },
    { symbol: 'ETHUSD', qty: -1 }
  ], 'SOLUSD', 3), '');
  assert.equal(isGlobalOpenPositionCapReached([
    { symbol: 'BTCUSD', qty: 1 },
    { symbol: 'ETHUSD', qty: -1 }
  ], 3), false);
});

test('blocks new symbols at and above the configured cap without closing existing positions', () => {
  const alreadyOpen = [
    { symbol: 'BTCUSD', qty: 1 },
    { symbol: 'ETHUSD', qty: -1 },
    { symbol: 'SOLUSD', qty: 1 }
  ];
  assert.match(globalOpenPositionCapBlocker(alreadyOpen, 'ADAUSD', 3), /Global open-position limit reached \(3\/3\)/);
  assert.match(globalOpenPositionCapBlocker([...alreadyOpen, { symbol: 'XRPUSD', qty: 1 }], 'ADAUSD', 3), /\(4\/3\)/);
  assert.equal(alreadyOpen.length, 3, 'the helper must not mutate or close existing positions');
  assert.equal(isGlobalOpenPositionCapReached(alreadyOpen, 3), true);
});

test('lets the duplicate-symbol gate provide the reason for an already occupied symbol', () => {
  assert.equal(globalOpenPositionCapBlocker([
    { symbol: 'BTCUSD', qty: 1 },
    { symbol: 'ETHUSD', qty: -1 },
    { symbol: 'SOLUSD', qty: 1 }
  ], 'btcUSD', 3), '');
});

test('counts open snapshot rows and reservations, so reservations consume slots too', () => {
  const positions = [
    { symbol: 'BTCUSD', qty: 1, origin: 'TRADETRON' },
    { symbol: 'ETHUSD', qty: -1, origin: 'TRADETRON' },
    { symbol: 'SOLUSD', qty: 1, origin: 'SIGNAL_RESERVATION' }
  ];
  assert.equal(countOpenPositionSymbols(positions), 3);
  assert.match(globalOpenPositionCapBlocker(positions, 'ADAUSD', 3), /limit reached/);
});

test('global cap blocks new grid entries while still allowing existing grid positions to be managed', () => {
  const timestamp = Date.parse('2026-10-15T11:00:00.000Z');
  const result = evaluateGridTick({
    settings: {
      grid_enabled: true,
      grid_symbol: 'ETHUSD',
      grid_lower_price: 90,
      grid_upper_price: 110,
      grid_levels_count: 8,
      grid_max_positions: 1,
      grid_risk_per_trade_pct: 0.3,
      grid_daily_loss_pct: 2,
      grid_max_drawdown_pct: 5,
      grid_momentum_pause_pct: 2.5,
      grid_reduce_after_losses: true,
      globalPositionCapReached: true
    },
    state: {
      status: 'RUNNING',
      positions: [],
      trades: [],
      events: [],
      lastPrice: 103,
      wasEnabled: true,
      strategyStartEquity: 10000,
      dayStartEquity: 10000,
      highWaterEquity: 10000,
      tradeDate: '2026-10-15',
      configSignature: 'ETHUSD|90|110|8'
    },
    price: 100,
    equity: 10000,
    available: 10000,
    candles: [],
    dataFresh: true,
    emergencyStop: false,
    timestamp,
    maxLeverage: 3
  });
  assert.equal(result.entered.length, 0);
  assert.equal(result.state.positions.length, 0);
  assert.ok(result.state.events.some(event => event.type === 'BLOCK' && event.reason === 'GLOBAL_OPEN_POSITION_LIMIT'));
});
