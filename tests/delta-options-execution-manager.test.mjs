import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOptionsReservationPayload,
  createDeltaOptionsExecutionManager,
  matchesPersistedOptionsReservation
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
    settling_asset: { symbol: 'USD' },
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

test('group idempotency and leg readers reject duplicate or malformed ledger snapshots', async () => {
  const calls = [];
  const manager = createDeltaOptionsExecutionManager({
    database: {
      select: async (table, query) => {
        calls.push({ table, query });
        if (table === 'dd_options_execution_groups') {
          return [{ id: 'group-id', client_group_id: 'client-group-123', state: 'RESERVED' }];
        }
        return [{ id: 1, group_id: 'group-id' }, { id: 2, group_id: 'group-id' }];
      }
    }
  });
  const group = await manager.getGroupByClientGroupId('client-group-123');
  assert.equal(group.id, 'group-id');
  const legs = await manager.getGroupLegs('group-id');
  assert.equal(legs.length, 2);
  assert.ok(calls.every(call => call.query.includes('limit=') ));
  await assert.rejects(manager.getGroupByClientGroupId('x'), /8–80 characters/);

  const duplicated = createDeltaOptionsExecutionManager({
    database: { select: async () => [{ id: '1' }, { id: '2' }] }
  });
  await assert.rejects(duplicated.getGroupByClientGroupId('client-group-123'), /invalid snapshot/);
});


test('ambiguous reservation recovery requires exact persisted group and both leg metadata', () => {
  const payload = buildOptionsReservationPayload({
    strategy: 'OPTIONS_SELL',
    underlyingSide: 'SELL',
    shortTicker: ticker('C-BTC-90000-311026', 'CALL', 401),
    protectiveTicker: ticker('C-BTC-95000-311026', 'CALL', 402),
    qty: 2,
    riskBudgetUsd: 25,
    maxLossUsd: 15,
    reservedMarginUsd: 18,
    netCreditUsd: 0.5,
    clientGroupId: 'recover-group-12345',
    now: NOW
  });
  const groupRow = {
    id: 'db-group-1',
    ...payload.group,
    state: 'RESERVED',
    matched_qty: 0
  };
  const legRows = payload.legs.map(leg => ({
    leg_role: leg.role,
    product_id: leg.productId,
    symbol: leg.symbol,
    contract_type: leg.contractType,
    option_type: leg.optionType,
    strike: String(leg.strike),
    contract_value: String(leg.contractValue),
    tick_size: String(leg.tickSize),
    expiry_at: leg.expiry_at,
    side: leg.side,
    requested_qty: leg.qty,
    filled_qty: '0',
    order_state: 'RESERVED',
    client_order_id: leg.clientOrderId
  }));
  assert.equal(matchesPersistedOptionsReservation(groupRow, legRows, payload), true);
  assert.equal(matchesPersistedOptionsReservation(groupRow, legRows.slice(0, 1), payload), false);
  assert.equal(matchesPersistedOptionsReservation(
    { ...groupRow, state: 'OPEN' }, legRows, payload
  ), false);
  assert.equal(matchesPersistedOptionsReservation(
    groupRow,
    legRows.map((row, index) => index === 0 ? { ...row, product_id: 999 } : row),
    payload
  ), false);
  assert.equal(matchesPersistedOptionsReservation(
    groupRow,
    legRows.map((row, index) => index === 1 ? { ...row, side: 'BUY' } : row),
    payload
  ), false);
});
