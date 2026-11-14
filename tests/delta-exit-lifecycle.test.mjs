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
  runAutomaticPositionExitCycle,
  parseEnrolledPositionIds,
  resolveExitLifecycleBoundary
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

function createExchangeHarness({ rejectClose = false, filledClose = false, lookupStatus = 404, lookupCode = 'not_found' } = {}) {
  const posts = [];
  const ordersByClientId = new Map();
  let isFlat = false;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const path = parsed.pathname;

    if (method === 'GET' && path.startsWith('/v2/orders/client_order_id/')) {
      const clientId = decodeURIComponent(path.split('/').pop());
      const found = ordersByClientId.get(clientId);
      return found
        ? jsonResponse(200, { success: true, result: found })
        : jsonResponse(lookupStatus, { success: false, error: { code: lookupCode } });
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
        state: filledClose ? 'FILLED' : 'OPEN',
        unfilled_size: filledClose ? 0 : body.size
      };
      ordersByClientId.set(body.client_order_id, order);
      if (filledClose) isFlat = true;
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

test('HTTP 400 order_not_found permits retrying a stale PENDING close reservation', async () => {
  const harness = createExchangeHarness({ lookupStatus: 400, lookupCode: 'order_not_found' });
  const clientOrderId = buildCloseClientOrderId('118', 'TIMEOUT');
  harness.reservations.set(clientOrderId, {
    client_order_id: clientOrderId,
    state: 'PENDING',
    raw: { reservation: true, outcome: 'unknown' }
  });

  const order = await harness.executor.closePosition('SPYXUSD', 2, {
    positionId: '118',
    closeReason: 'TIMEOUT',
    expectedSide: 'BUY',
    expectedProductId: 123,
    strategy: 'SCALPING'
  });

  assert.equal(harness.posts.length, 1);
  assert.equal(harness.posts[0].client_order_id, clientOrderId);
  assert.equal(order.client_order_id, clientOrderId);
  assert.equal(harness.reservations.get(clientOrderId).state, 'OPEN');
  assert.ok(harness.logs.some(row =>
    row.message.includes('explicit exchange order_not_found')
  ));
});

test('a different HTTP 400 lookup error still blocks close submission', async () => {
  const harness = createExchangeHarness({ lookupStatus: 400, lookupCode: 'invalid_request' });
  await assert.rejects(harness.executor.closePosition('SPYXUSD', 2, {
    positionId: '118',
    closeReason: 'TIMEOUT',
    expectedSide: 'BUY',
    expectedProductId: 123,
    strategy: 'SCALPING'
  }), /invalid_request/);
  assert.equal(harness.posts.length, 0);
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
    deploymentBoundaryMs: Date.parse('2026-11-12T03:00:00.000Z'),
    enrolledPositionIds: new Set(['118']),
    now: () => Date.parse('2026-11-12T03:45:00.000Z'),
    log: state.log
  }));

  assert.equal(state.rows.find(row => row.id === 118).status, 'OPEN');
  assert.equal(state.rows.find(row => row.id === 118).requested_exit_reason, 'TIMEOUT');
  assert.equal(state.rows.find(row => row.id === 119).requested_exit_reason, undefined);
  assert.ok(state.logs.some(row => row.level === 'ERROR' && row.message.includes('position remains OPEN')));
  assert.equal(harness.posts.length, 1);
});

test('historical enrollment is position-scoped and empty list is fail-safe', () => {
  const deploymentBoundaryMs = Date.parse('2026-11-12T03:00:00.000Z');
  const enrolled = parseEnrolledPositionIds('118, 120');
  assert.equal(isExitLifecycleEnrolled({ id: 118, opened_at: '2026-11-06T00:00:00.000Z' }, { deploymentBoundaryMs, enrolledPositionIds: enrolled }), true);
  assert.equal(isExitLifecycleEnrolled({ id: 119, opened_at: '2026-11-06T00:00:00.000Z' }, { deploymentBoundaryMs, enrolledPositionIds: enrolled }), false);
  assert.equal(isExitLifecycleEnrolled({ id: 118, opened_at: '2026-11-06T00:00:00.000Z' }, { deploymentBoundaryMs, enrolledPositionIds: new Set() }), false);
  assert.equal(isExitLifecycleEnrolled({ id: 121, opened_at: '2026-11-12T03:01:00.000Z' }, { deploymentBoundaryMs, enrolledPositionIds: new Set() }), true);
  assert.equal(isExitLifecycleEnrolled({ id: 122, opened_at: '2026-11-06T00:00:00.000Z' }, { deploymentBoundaryMs: null, enrolledPositionIds: new Set() }), false);
});

test('SPYXUSD #118 is explicitly enrolled while PAXGUSD #119 stays untouched', async () => {
  const state = makeCanonicalDb();
  const calls = [];
  const executor = { async closePosition(symbol, qty, options) {
    calls.push({ symbol, qty, options });
    return { id: 700 + Number(options.positionId), client_order_id: 'stable-' + options.positionId };
  }};
  const common = {
    database: state.database, executor,
    deploymentBoundaryMs: Date.parse('2026-11-12T03:00:00.000Z'),
    enrolledPositionIds: parseEnrolledPositionIds('118'),
    now: () => Date.parse('2026-11-12T03:45:00.000Z'), log: state.log
  };
  const spyx = {
    origin: 'ENGINE', strategy: 'SCALPING', symbol: 'SPYXUSD',
    execution_id: 'spx-entry-118', client_order_id: 'spx-entry-118',
    entry_order_id: 'spx-entry-118', opened_at: '2026-11-06T00:00:00.000Z'
  };
  await closeTrackedPosition({ ...common, position: spyx, symbol: 'SPYXUSD', productId: 123, qty: 2, side: 'BUY', reason: 'TIMEOUT' });
  assert.equal(state.rows.find(row => row.id === 118).requested_exit_reason, 'TIMEOUT');
  const paxg = {
    origin: 'ENGINE', strategy: 'SCALPING', symbol: 'PAXGUSD',
    execution_id: 'paxg-entry-119', client_order_id: 'paxg-entry-119',
    entry_order_id: 'paxg-entry-119', opened_at: '2026-11-06T00:00:00.000Z'
  };
  const skipped = await closeTrackedPosition({ ...common, position: paxg, symbol: 'PAXGUSD', productId: 456, qty: 1, side: 'SELL', reason: 'TIMEOUT' });
  assert.deepEqual(skipped, { skipped: true, reason: 'LEGACY_POSITION_NOT_ENROLLED' });
  assert.equal(state.rows.find(row => row.id === 119).requested_exit_reason, undefined);
  assert.deepEqual(calls.map(call => call.symbol), ['SPYXUSD']);
  assert.equal(calls[0].options.positionId, '118');
});
test('historical position not in explicit list remains OPEN', async () => {
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
    deploymentBoundaryMs: Date.parse('2026-11-12T03:00:00.000Z'),
    enrolledPositionIds: new Set(), log: state.log
  });
  assert.deepEqual(result, { skipped: true, reason: 'LEGACY_POSITION_NOT_ENROLLED' });
  assert.equal(invoked, false);
  assert.equal(state.rows.find(row => row.id === 118).requested_exit_reason, undefined);
});

test('filled close order is reused on later timeout retry without duplicate POST', async () => {
  const harness = createExchangeHarness({ filledClose: true });
  const options = {
    positionId: '118', closeReason: 'TIMEOUT',
    expectedSide: 'BUY', expectedProductId: 123, strategy: 'SCALPING'
  };
  const first = await harness.executor.closePosition('SPYXUSD', 2, options);
  assert.equal(first.state, 'FILLED');
  assert.equal(first.unfilled_size, 0);
  const laterRetry = await harness.executor.closePosition('SPYXUSD', 2, options);
  assert.equal(laterRetry.id, first.id);
  assert.equal(laterRetry.client_order_id, first.client_order_id);
  assert.equal(harness.posts.length, 1);
  assert.ok(harness.logs.some(row => row.message.includes('no duplicate POST sent')));
});

test('worker restart reads the same persisted deployment enrollment boundary', () => {
  const settingsRow = [{ exit_lifecycle_deploy_boundary_utc: '2026-11-12T06:11:00.000Z' }];
  const firstWorkerBoundary = resolveExitLifecycleBoundary(settingsRow);
  const restartedWorkerBoundary = resolveExitLifecycleBoundary(settingsRow);
  assert.equal(firstWorkerBoundary, Date.parse('2026-11-12T06:11:00.000Z'));
  assert.equal(restartedWorkerBoundary, firstWorkerBoundary);
});

test('position opened before DB boundary requires explicit canonical ID enrollment', () => {
  const boundary = resolveExitLifecycleBoundary([{ exit_lifecycle_deploy_boundary_utc: '2026-11-12T06:11:00.000Z' }]);
  assert.equal(isExitLifecycleEnrolled({ id: 118, opened_at: '2026-11-12T06:10:59.000Z' }, { deploymentBoundaryMs: boundary, enrolledPositionIds: new Set() }), false);
  assert.equal(isExitLifecycleEnrolled({ id: 118, opened_at: '2026-11-12T06:10:59.000Z' }, { deploymentBoundaryMs: boundary, enrolledPositionIds: new Set(['118']) }), true);
});

test('filled close with exchange-flat confirmation marks canonical position CLOSED with original order reference', async () => {
  const state = makeCanonicalDb();
  const order = { id: 501, state: 'FILLED', unfilled_size: 0, client_order_id: buildCloseClientOrderId('118', 'TIMEOUT'), exchange_position_flat: true, average_fill_price: '101.25' };
  const result = await closeTrackedPosition({
    database: state.database,
    executor: { closePosition: async () => order },
    position: {
      origin: 'ENGINE', strategy: 'SCALPING', symbol: 'SPYXUSD',
      execution_id: 'spx-entry-118', client_order_id: 'spx-entry-118',
      entry_order_id: 'spx-entry-118', opened_at: '2026-11-06T00:00:00.000Z'
    },
    symbol: 'SPYXUSD', productId: 123, qty: 2, side: 'BUY', reason: 'TIMEOUT',
    deploymentBoundaryMs: Date.parse('2026-11-12T03:00:00.000Z'),
    enrolledPositionIds: new Set(['118']), log: state.log
  });
  const closed = state.rows.find(row => row.id === 118);
  assert.equal(result.positionClosed, true);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.close_order_id, 501);
  assert.equal(Object.hasOwn(closed, 'exit_order_id'), false);
  assert.equal(closed.exit_price, '101.25');
  assert.equal(closed.exit_reason, 'TIMEOUT');
  assert.equal(closed.close_reason, 'TIMEOUT');
});
