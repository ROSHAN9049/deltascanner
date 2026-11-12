import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCloseClientOrderId,
  createDeltaExecutor
} from '../worker/execution/delta-executor.mjs';
import {
  closeTrackedPosition,
  isExitLifecycleEnrolled,
  resolveAutomaticPositionExitReason,
  runAutomaticPositionExitCycle
} from '../worker/execution/exit-lifecycle.mjs';

const TESTNET_ENV = {
  DELTA_EXECUTION_MODE: 'testnet',
  DELTA_ENVIRONMENT: 'TESTNET',
  DELTA_TESTNET_API_KEY: 'test-api-key',
  DELTA_TESTNET_API_SECRET: 'test-api-secret'
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

function createExchangeHarness({ rejectClose = false } = {}) {
  const posts = [];
  const ordersByClientId = new Map();
  let isFlat = false;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const path = parsed.pathname;

    if (method === 'GET' && path === '/v2/orders/client_order_id/' + decodeURIComponent(path.split('/').pop())) {
      const clientId = decodeURIComponent(path.split('/').pop());
      const found = ordersByClientId.get(clientId);
      return found
        ? jsonResponse(200, { success: true, result: found })
        : jsonResponse(404, { success: false, error: { code: 'not_found' } });
    }

    if (method === 'GET' && path === '/v2/positions/margined') {
      return jsonResponse(200, {
        success: true,
        result: isFlat ? [] : [{
          product_symbol: 'SPYXUSD',
          product_id: 123,
          size: 2,
          entry_price: 100,
          mark_price: 101
        }]
      });
    }

    if (method === 'GET' && path === '/v2/products') {
      return jsonResponse(200, {
        success: true,
        result: [{ id: 123, symbol: 'SPYXUSD', contract_type: 'perpetual_futures' }],
        meta: {}
      });
    }

    if (method === 'GET' && path === '/v2/orders') {
      return jsonResponse(200, { success: true, result: [], meta: {} });
    }

    if (method === 'POST' && path === '/v2/orders') {
      const body = JSON.parse(init.body || '{}');
      posts.push(body);
      if (rejectClose) {
        return jsonResponse(400, {
          success: false,
          error: { code: 'invalid_order', message: 'Testnet rejected reduce-only close' }
        });
      }
      const order = {
        id: 501,
        product_id: body.product_id,
        product_symbol: 'SPYXUSD',
        side: body.side,
        size: body.size,
        order_type: body.order_type,
        reduce_only: body.reduce_only,
        client_order_id: body.client_order_id,
        state: 'OPEN',
        unfilled_size: body.size
      };
      ordersByClientId.set(body.client_order_id, order);
      return jsonResponse(200, { success: true, result: order });
    }

    throw new Error('Unexpected Testnet request: ' + method + ' ' + parsed.pathname);
  };

  const reservations = new Map();
  const logs = [];
  const database = {
    async select(table, query = '') {
      if (table === 'dd_orders') {
        const match = query.match(/client_order_id=eq\.([^&]+)/);
        const clientId = match ? decodeURIComponent(match[1]) : '';
        const row = reservations.get(clientId);
        return row ? [{ ...row }] : [];
      }
      return [];
    },
    async upsert(table, row, conflict) {
      assert.equal(table, 'dd_orders');
      assert.equal(conflict, 'client_order_id');
      reservations.set(row.client_order_id, { ...row });
      return row;
    },
    async update(table, query, patch) {
      if (table === 'dd_orders') {
        const match = query.match(/client_order_id=eq\.([^&]+)/);
        const clientId = match ? decodeURIComponent(match[1]) : '';
        if (reservations.has(clientId)) {
          reservations.set(clientId, { ...reservations.get(clientId), ...patch });
        }
      }
      return [];
    },
    async log(level, message, details) {
      logs.push({ level, message, details });
    }
  };

  const executor = createDeltaExecutor({
    env: TESTNET_ENV,
    fetchImpl,
    database,
    now: () => Date.parse('2026-11-12T03:45:00.000Z')
  });
  return { executor, posts, reservations, logs, setFlat: value => { isFlat = value; } };
}

function makeCanonicalDb() {
  const rows = [
    {
      id: 118, symbol: 'SPYXUSD', status: 'OPEN',
      client_order_id: 'spx-entry-118', entry_order_id: 'spx-entry-118',
      side: 'BUY', product_id: 123
    },
    {
      id: 119, symbol: 'PAXGUSD', status: 'OPEN',
      client_order_id: 'paxg-entry-119', entry_order_id: 'paxg-entry-119',
      side: 'SELL', product_id: 456
    }
  ];
  const logs = [];
  const updates = [];
  return {
    rows, logs, updates,
    database: {
      async select(table, query) {
        assert.equal(table, 'dd_delta_positions');
        const symbol = decodeURIComponent(query.match(/symbol=eq\.([^&]+)/)?.[1] || '');
        return rows.filter(row => row.symbol === symbol && row.status === 'OPEN').map(row => ({ ...row }));
      },
      async update(table, query, patch) {
        updates.push({ table, query, patch: { ...patch } });
        if (table === 'dd_delta_positions') {
          const id = decodeURIComponent(query.match(/id=eq\.([^&]+)/)?.[1] || '');
          const row = rows.find(item => String(item.id) === id);
          if (row) Object.assign(row, patch);
        }
        return [];
      }
    },
    log: async (level, message, details) => logs.push({ level, message, details })
  };
}

test('close client order ID is deterministic per canonical position and reason', () => {
  const first = buildCloseClientOrderId('118', 'TIMEOUT');
  assert.equal(first, buildCloseClientOrderId('118', 'TIMEOUT'));
  assert.notEqual(first, buildCloseClientOrderId('119', 'TIMEOUT'));
  assert.notEqual(first, buildCloseClientOrderId('118', 'STOP_LOSS'));
  assert.ok(first.length <= 32);
});

test('Delta Testnet executor submits a real reduce-only market close for TIMEOUT', async () => {
  const harness = createExchangeHarness();
  const order = await harness.executor.closePosition('SPYXUSD', 2, {
    positionId: '118',
    closeReason: 'TIMEOUT',
    expectedSide: 'BUY',
    expectedProductId: 123,
    strategy: 'SCALPING'
  });

  assert.equal(harness.posts.length, 1);
  assert.equal(harness.posts[0].product_id, 123);
  assert.equal(harness.posts[0].size, 2);
  assert.equal(harness.posts[0].side, 'sell');
  assert.equal(harness.posts[0].order_type, 'market_order');
  assert.equal(harness.posts[0].reduce_only, true);
  assert.equal(harness.posts[0].client_order_id, buildCloseClientOrderId('118', 'TIMEOUT'));
  assert.equal(order.id, 501);
  assert.equal(harness.reservations.get(order.client_order_id).role, 'EXIT');
});

test('repeated timeout close reuses the same exchange order and never duplicates POST', async () => {
  const harness = createExchangeHarness();
  const options = {
    positionId: '118',
    closeReason: 'TIMEOUT',
    expectedSide: 'BUY',
    expectedProductId: 123,
    strategy: 'SCALPING'
  };
  const first = await harness.executor.closePosition('SPYXUSD', 2, options);
  const second = await harness.executor.closePosition('SPYXUSD', 2, options);
  assert.equal(first.id, second.id);
  assert.equal(harness.posts.length, 1);
  assert.ok(harness.logs.some(row => row.message.includes('no duplicate POST sent')));
});

test('persisted TIMEOUT marker is retried by the next automatic exit cycle', async () => {
  const position = {
    opened_at: '2026-11-11T00:00:00.000Z',
    requested_exit_reason: 'TIMEOUT'
  };
  assert.equal(resolveAutomaticPositionExitReason(position, {
    nowMs: Date.parse('2026-11-12T00:00:00.000Z'),
    maxHoldMinutes: 999
  }), 'TIMEOUT');

  const attempted = [];
  const result = await runAutomaticPositionExitCycle({
    position,
    nowMs: Date.parse('2026-11-12T00:00:00.000Z'),
    maxHoldMinutes: 999,
    onExit: async reason => {
      attempted.push(reason);
      return { accepted: true };
    }
  });
  assert.equal(result.attempted, true);
  assert.deepEqual(attempted, ['TIMEOUT']);
});

test('exchange rejection leaves canonical position OPEN and emits an error alert', async () => {
  const harness = createExchangeHarness({ rejectClose: true });
  const state = makeCanonicalDb();
  const position = {
    origin: 'ENGINE', strategy: 'SCALPING', symbol: 'SPYXUSD',
    execution_id: 'spx-entry-118', client_order_id: 'spx-entry-118',
    entry_order_id: 'spx-entry-118', opened_at: '2026-11-06T00:00:00.000Z'
  };
  await assert.rejects(closeTrackedPosition({
    database: state.database,
    executor: harness.executor,
    position,
    symbol: 'SPYXUSD',
    productId: 123,
    qty: 2,
    side: 'BUY',
    reason: 'TIMEOUT',
    deploymentStartedAtMs: Date.parse('2026-11-12T03:00:00.000Z'),
    autoCloseLegacy: true,
    now: () => Date.parse('2026-11-12T03:45:00.000Z'),
    log: state.log
  }));

  assert.equal(state.rows.find(row => row.id === 118).status, 'OPEN');
  assert.equal(state.rows.find(row => row.id === 118).requested_exit_reason, 'TIMEOUT');
  assert.equal(state.rows.find(row => row.id === 119).requested_exit_reason, undefined);
  assert.ok(state.logs.some(row => row.level === 'ERROR' && row.message.includes('position remains OPEN')));
  assert.equal(harness.posts.length, 1);
});

test('AUTO_CLOSE_LEGACY gates old positions but future-enrolled positions are managed', () => {
  const deploymentStartedAtMs = Date.parse('2026-11-12T03:00:00.000Z');
  assert.equal(isExitLifecycleEnrolled({
    opened_at: '2026-11-06T00:00:00.000Z'
  }, { deploymentStartedAtMs, autoCloseLegacy: false }), false);
  assert.equal(isExitLifecycleEnrolled({
    opened_at: '2026-11-12T03:01:00.000Z'
  }, { deploymentStartedAtMs, autoCloseLegacy: false }), true);
  assert.equal(isExitLifecycleEnrolled({
    opened_at: '2026-11-06T00:00:00.000Z'
  }, { deploymentStartedAtMs, autoCloseLegacy: true }), true);
});

test('SPYXUSD #118 and PAXGUSD #119 are enrolled and closed independently', async () => {
  const state = makeCanonicalDb();
  const calls = [];
  const executor = {
    async closePosition(symbol, qty, options) {
      calls.push({ symbol, qty, options });
      return { id: 700 + options.positionId, client_order_id: 'stable-' + options.positionId };
    }
  };
  const deploymentStartedAtMs = Date.parse('2026-11-12T03:00:00.000Z');
  const common = {
    database: state.database,
    executor,
    deploymentStartedAtMs,
    autoCloseLegacy: true,
    now: () => Date.parse('2026-11-12T03:45:00.000Z'),
    log: state.log
  };

  const spyx = {
    origin: 'ENGINE', strategy: 'SCALPING', symbol: 'SPYXUSD',
    execution_id: 'spx-entry-118', client_order_id: 'spx-entry-118',
    entry_order_id: 'spx-entry-118', opened_at: '2026-11-06T00:00:00.000Z'
  };
  await closeTrackedPosition({
    ...common, position: spyx, symbol: 'SPYXUSD', productId: 123,
    qty: 2, side: 'BUY', reason: 'TIMEOUT'
  });
  assert.equal(state.rows.find(row => row.id === 118).requested_exit_reason, 'TIMEOUT');
  assert.equal(state.rows.find(row => row.id === 119).requested_exit_reason, undefined);
  assert.deepEqual(calls.map(call => call.symbol), ['SPYXUSD']);

  const paxg = {
    origin: 'ENGINE', strategy: 'SCALPING', symbol: 'PAXGUSD',
    execution_id: 'paxg-entry-119', client_order_id: 'paxg-entry-119',
    entry_order_id: 'paxg-entry-119', opened_at: '2026-11-06T00:00:00.000Z'
  };
  await closeTrackedPosition({
    ...common, position: paxg, symbol: 'PAXGUSD', productId: 456,
    qty: 1, side: 'SELL', reason: 'TIMEOUT'
  });
  assert.equal(state.rows.find(row => row.id === 119).requested_exit_reason, 'TIMEOUT');
  assert.deepEqual(calls.map(call => call.symbol), ['SPYXUSD', 'PAXGUSD']);
  assert.equal(calls[0].options.positionId, '118');
  assert.equal(calls[1].options.positionId, '119');
});

test('legacy position remains untouched when AUTO_CLOSE_LEGACY is false', async () => {
  const state = makeCanonicalDb();
  let invoked = false;
  const result = await closeTrackedPosition({
    database: state.database,
    executor: { closePosition: async () => { invoked = true; } },
    position: {
      origin: 'ENGINE', strategy: 'SCALPING', symbol: 'SPYXUSD',
      execution_id: 'spx-entry-118', client_order_id: 'spx-entry-118',
      entry_order_id: 'spx-entry-118', opened_at: '2026-11-06T00:00:00.000Z'
    },
    symbol: 'SPYXUSD', productId: 123, qty: 2, side: 'BUY', reason: 'TIMEOUT',
    deploymentStartedAtMs: Date.parse('2026-11-12T03:00:00.000Z'),
    autoCloseLegacy: false,
    log: state.log
  });
  assert.deepEqual(result, { skipped: true, reason: 'LEGACY_POSITION_NOT_ENROLLED' });
  assert.equal(invoked, false);
  assert.equal(state.rows.find(row => row.id === 118).requested_exit_reason, undefined);
});
