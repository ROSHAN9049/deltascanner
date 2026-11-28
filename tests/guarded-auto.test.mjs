import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGuardedAuto,
  assertExactMinimumQuantity,
  assertKnownMargin,
  assertAttachedBracket,
  buildGuardedEntryBracketFields,
  verifyAttachedBracketOrEmergencyClose,
  resolveExchangeMinimumOrderSize
} from '../worker/execution/guarded-auto.mjs';

function fixtures(overrides = {}) {
  const state = {
    enabled: true, auto_trade: true, emergency_stop: false,
    guarded_auto_enabled: true, guarded_estop_active: false,
    momentum_enabled: true, scalping_enabled: true,
    last_tick_at: new Date(1_700_000_000_000).toISOString()
  };
  Object.assign(state, overrides.settings || {});
  let activeReservation = false;
  const db = {
    async select() { return [state]; },
    async update(_table, _query, patch) { Object.assign(state, patch); return [state]; },
    async log() {},
    async reserveGuardedAutoEntry() {
      if (activeReservation) return false;
      activeReservation = true;
      return true;
    },
    async releaseGuardedAutoEntry() { activeReservation = false; return true; }
  };
  const exchange = {
    orders: [{ id: 11, symbol: 'XAUTUSD' }],
    positions: [{ symbol: 'XAUTUSD', qty: 1, side: 'BUY', product_id: 9001, order_id: 'entry-1' }],
    async getOpenOrders() { return [...this.orders]; },
    async cancelOrderById(id) { this.orders = this.orders.filter(row => row.id !== id); },
    async getOpenPositions() { return [...this.positions]; },
    async closePosition(symbol) {
      this.positions = this.positions.filter(row => row.symbol !== symbol);
      return { id: 22 };
    }
  };
  const auto = createGuardedAuto({
    database: db,
    executor: exchange,
    env: {
      DELTA_ENVIRONMENT: 'TESTNET',
      DELTA_EXECUTION_MODE: 'testnet',
      DELTA_TESTNET_REST_BASE: 'https://cdn-ind.testnet.deltaex.org'
    },
    now: () => 1_700_000_000_000
  });
  return { state, db, exchange, auto };
}

test('two concurrent Momentum/Scalping entries yield exactly one global reservation', async () => {
  const { auto } = fixtures();
  const inputs = [
    { strategy: 'MOMENTUM', symbol: 'XAUTUSD', stage: 'CONFIRMED', clientOrderId: 'mom-1' },
    { strategy: 'SCALPING', symbol: 'PAXGUSD', stage: 'CONFIRMED', clientOrderId: 'scalp-1' }
  ];
  const results = await Promise.allSettled(inputs.map(input => auto.reserve(input)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('unknown exchange minimum is rejected instead of guessed', () => {
  assert.throws(() => resolveExchangeMinimumOrderSize({ id: 9001, tick_size: '0.1' }), /GUARDED_EXCHANGE_MINIMUM_SIZE_UNKNOWN/);
  assert.equal(resolveExchangeMinimumOrderSize({ minimum_order_size: 1 }), 1);
});

test('quantity above or below exchange minimum is rejected', () => {
  assert.equal(assertExactMinimumQuantity(1, 1), 1);
  assert.throws(() => assertExactMinimumQuantity(2, 1), /GUARDED_QUANTITY_MUST_EQUAL_EXCHANGE_MINIMUM/);
  assert.throws(() => assertExactMinimumQuantity(0, 1), /GUARDED_QUANTITY_MUST_EQUAL_EXCHANGE_MINIMUM/);
});

test('missing and stale margin are rejected', () => {
  assert.throws(() => assertKnownMargin({ available: null, observedAt: 1000, now: 1000 }), /GUARDED_MARGIN_UNKNOWN_OR_STALE/);
  assert.throws(() => assertKnownMargin({ available: 10, observedAt: 1, now: 60_000 }), /GUARDED_MARGIN_UNKNOWN_OR_STALE/);
  assert.equal(assertKnownMargin({ available: 10, observedAt: 59_000, now: 60_000 }), 10);
});

test('missing attached SL/TP causes fail-closed bracket verification', () => {
  assert.equal(assertAttachedBracket({ id: 1, bracket_order: false, bracket_stop_loss_price: '95', bracket_take_profit_price: '110' }, 95, 110), true);
  assert.throws(() => assertAttachedBracket({ id: 1, bracket_order: true, bracket_stop_loss_price: '95' }, 95, 110), /GUARDED_ATTACHED_SL_TP_NOT_VERIFIED/);
  assert.equal(assertAttachedBracket({
    id: 1, bracket_order: true,
    bracket_stop_loss_price: '95', bracket_take_profit_price: '110'
  }, 95, 110), true);
});

test('LIVE host/profile forces auto_trade off and rejects entry', async () => {
  const { state } = fixtures();
  const liveAuto = createGuardedAuto({
    database: { ...fixtures().db, update: async (_t, _q, patch) => Object.assign(state, patch), log: async () => {} },
    executor: fixtures().exchange,
    env: { DELTA_ENVIRONMENT: 'LIVE', DELTA_EXECUTION_MODE: 'live', DELTA_TESTNET_REST_BASE: 'https://api.india.delta.exchange' },
    now: () => 1_700_000_000_000
  });
  await assert.rejects(liveAuto.assertEntryAllowed({
    strategy: 'MOMENTUM', symbol: 'XAUTUSD', stage: 'CONFIRMED'
  }), /GUARDED_TESTNET_ROUTE_REQUIRED/);
  assert.equal(state.auto_trade, false);
});

test('SETUP is never eligible for order dispatch', async () => {
  const { auto } = fixtures();
  await assert.rejects(auto.assertEntryAllowed({
    strategy: 'MOMENTUM', symbol: 'XAUTUSD', stage: 'SETUP'
  }), /GUARDED_REQUIRES_CONFIRMED_SIGNAL/);
});

test('E-STOP disables entries, cancels orders, closes positions and reconciles flat', async () => {
  const { auto, state, exchange } = fixtures();
  const result = await auto.emergencyStop({ reason: 'TEST' });
  assert.equal(state.auto_trade, false);
  assert.equal(state.enabled, false);
  assert.equal(state.guarded_estop_active, true);
  assert.equal(exchange.orders.length, 0);
  assert.equal(exchange.positions.length, 0);
  assert.equal(result.reconciledFlat, true);
  assert.equal(result.reconciledOrdersClear, true);
  assert.equal(result.complete, true);
});

test('guarded entry payload pre-attaches both SL and TP before POST', () => {
  assert.deepEqual(buildGuardedEntryBracketFields(95, 110), {
    bracket_stop_loss_price: '95',
    bracket_take_profit_price: '110',
    bracket_stop_trigger_method: 'mark_price'
  });
  assert.throws(() => buildGuardedEntryBracketFields(0, 110), /GUARDED_ATTACHED_SL_TP_INVALID/);
});

test('post-fill bracket verification failure invokes emergency close and remains a failure', async () => {
  let emergencyCloseCalled = false;
  await assert.rejects(verifyAttachedBracketOrEmergencyClose({
    order: { id: 1, bracket_stop_loss_price: '95', bracket_take_profit_price: null },
    stopLossPrice: 95,
    takeProfitPrice: 110,
    emergencyClose: async () => { emergencyCloseCalled = true; }
  }), /GUARDED_ATTACHED_SL_TP_NOT_VERIFIED/);
  assert.equal(emergencyCloseCalled, true);
});

test('engine disabled or auto_trade OFF blocks guarded entry before reservation', async () => {
  for (const settings of [{ enabled: false }, { auto_trade: false }]) {
    const { auto } = fixtures({ settings });
    await assert.rejects(auto.assertEntryAllowed({
      strategy: 'MOMENTUM', symbol: 'XAUTUSD', stage: 'CONFIRMED'
    }), /GUARDED_AUTO_DISABLED_OR_ESTOP_ACTIVE/);
  }
});

test('invalid pre-attach SL/TP prevents entry submission entirely', async () => {
  let postCalls = 0;
  const submit = async payload => { postCalls += 1; return payload; };
  await assert.rejects(async () => {
    const bracketFields = buildGuardedEntryBracketFields(0, 110);
    return submit({ product_id: 123, size: 1, ...bracketFields });
  }, /GUARDED_ATTACHED_SL_TP_INVALID/);
  assert.equal(postCalls, 0);
});
