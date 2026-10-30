import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOptionsReservationPayload,
  createDeltaOptionsExecutionManager
} from '../worker/execution/delta-options-execution-manager.mjs';
import {
  OPTIONS_EXECUTION_ALLOWED,
  OPTIONS_EXECUTION_LOCK_REASON
} from '../worker/options-execution-lock.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);

function ticker(symbol, optionType, productId, underlying = 'BTC') {
  return {
    symbol,
    underlying,
    product_id: productId,
    contract_type: optionType === 'CALL' ? 'call_options' : 'put_options',
    contract_value: '0.001',
    tick_size: '0.0001',
    state: 'live',
    testnet_product_verified: true
  };
}

test('BUY reservation payload stores one direction-matched long premium leg', () => {
  const payload = buildOptionsReservationPayload({
    strategy: 'OPTIONS_BUY',
    underlyingSide: 'BUY',
    ticker: ticker('C-BTC-90000-311026', 'CALL', 101),
    qty: 2,
    riskBudgetUsd: 10,
    maxLossUsd: 4,
    reservedMarginUsd: 4.2,
    clientGroupId: 'buy-group-12345',
    now: NOW
  });
  assert.equal(payload.group.strategy, 'OPTIONS_BUY');
  assert.equal(payload.group.underlying_symbol, 'BTCUSD');
  assert.equal(payload.group.option_type, 'CALL');
  assert.equal(payload.group.requested_qty, 2);
  assert.equal(payload.legs.length, 1);
  assert.equal(payload.legs[0].role, 'LONG_PREMIUM');
  assert.equal(payload.legs[0].side, 'BUY');
  assert.equal(payload.legs[0].productId, 101);
  assert.equal(payload.legs[0].contractValue, 0.001);
  assert.ok(payload.legs[0].clientOrderId.length <= 32);
  assert.equal(payload.legs[0].expiry_at, '2026-10-31T12:00:00.000Z');
});

test('SELL reservation payload stores protective BUY before short SELL with same expiry', () => {
  const payload = buildOptionsReservationPayload({
    strategy: 'OPTIONS_SELL',
    underlyingSide: 'SELL',
    shortTicker: ticker('C-BTC-90000-311026', 'CALL', 201),
    protectiveTicker: ticker('C-BTC-95000-311026', 'CALL', 202),
    qty: 2,
    riskBudgetUsd: 25,
    maxLossUsd: 15,
    reservedMarginUsd: 18,
    netCreditUsd: 0.5,
    clientGroupId: 'sell-group-12345',
    now: NOW
  });
  assert.equal(payload.group.strategy, 'OPTIONS_SELL');
  assert.equal(payload.group.net_credit_usd, 0.5);
  assert.equal(payload.legs.length, 2);
  assert.deepEqual(payload.legs.map(leg => [leg.role, leg.side]), [
    ['PROTECTIVE_WING', 'BUY'],
    ['SHORT_OPTION', 'SELL']
  ]);
  assert.equal(payload.legs[0].expiry_at, payload.legs[1].expiry_at);
  assert.notEqual(payload.legs[0].clientOrderId, payload.legs[1].clientOrderId);
});

test('reservation preview blocks missing risk, reserve, credit, bad legs and XAUT', () => {
  const buy = {
    strategy: 'OPTIONS_BUY',
    underlyingSide: 'BUY',
    ticker: ticker('C-BTC-90000-311026', 'CALL', 101),
    qty: 1,
    riskBudgetUsd: 10,
    maxLossUsd: 4,
    reservedMarginUsd: 4.2,
    clientGroupId: 'preview-group-1',
    now: NOW
  };
  for (const overrides of [
    { riskBudgetUsd: 0 },
    { maxLossUsd: 11 },
    { reservedMarginUsd: 0 },
    { ticker: ticker('C-XAUT-4000-311026', 'CALL', 901, 'XAUT') }
  ]) {
    assert.throws(() => buildOptionsReservationPayload({ ...buy, ...overrides }));
  }
  assert.throws(() => buildOptionsReservationPayload({
    strategy: 'OPTIONS_SELL',
    underlyingSide: 'SELL',
    shortTicker: ticker('C-BTC-90000-311026', 'CALL', 201),
    protectiveTicker: ticker('C-BTC-95000-311026', 'CALL', 202),
    qty: 1,
    riskBudgetUsd: 10,
    maxLossUsd: 5,
    reservedMarginUsd: 6,
    netCreditUsd: 0,
    clientGroupId: 'preview-group-2',
    now: NOW
  }), /Net credit/);
});

test('hard lock blocks reservation before RPC and submission before executor/network', async () => {
  assert.equal(OPTIONS_EXECUTION_ALLOWED, false);
  let rpcCalls = 0;
  let orderCalls = 0;
  const manager = createDeltaOptionsExecutionManager({
    database: {
      rpc: async () => { rpcCalls += 1; return { group_id: 'x' }; },
      select: async () => []
    },
    executor: {
      placeOptionOrder: async () => { orderCalls += 1; return { id: 1 }; }
    },
    now: () => NOW,
    createGroupId: () => 'deterministic-group-123'
  });

  const valid = {
    strategy: 'OPTIONS_BUY',
    underlyingSide: 'BUY',
    ticker: ticker('C-BTC-90000-311026', 'CALL', 101),
    qty: 1,
    riskBudgetUsd: 10,
    maxLossUsd: 4,
    reservedMarginUsd: 4.2
  };
  await assert.rejects(manager.reserve(valid), error => error.message === OPTIONS_EXECUTION_LOCK_REASON);
  await assert.rejects(manager.submitReservedOrder({
    symbol: 'C-BTC-90000-311026', side: 'BUY', qty: 1, limitPrice: 10,
    clientOrderId: 'DDO-ABCDEFGHIJKL-LP-1'
  }), error => error.message === OPTIONS_EXECUTION_LOCK_REASON);
  assert.equal(rpcCalls, 0);
  assert.equal(orderCalls, 0);
});

test('active-group read rejects malformed or duplicated snapshots', async () => {
  const manager = createDeltaOptionsExecutionManager({
    database: {
      select: async () => [{ id: 'group-1', state: 'OPEN' }]
    }
  });
  assert.deepEqual(await manager.getActiveGroup(), { id: 'group-1', state: 'OPEN' });

  const duplicate = createDeltaOptionsExecutionManager({
    database: {
      select: async () => [{ id: '1' }, { id: '2' }]
    }
  });
  await assert.rejects(duplicate.getActiveGroup(), /invalid active-group snapshot/);
});
