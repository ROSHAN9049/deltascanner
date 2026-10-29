import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDashboardRouteContext,
  TESTNET_ROUTE_CATALOG_MAX_AGE_MS
} from '../src/dashboard-route-state.js';

const now = 1_800_000_000_000;
const catalog = (patch = {}) => ({
  success: true,
  environment: 'DELTA_TESTNET',
  complete: true,
  checkedAt: new Date(now).toISOString(),
  cached: false,
  count: 2,
  result: [
    {
      id: 1, symbol: 'BTCUSD', contract_type: 'perpetual_futures',
      state: 'live', trading_status: 'operational',
      only_reduce_only_orders_allowed: false
    },
    {
      id: 2, symbol: 'ETHUSD', contract_type: 'perpetual_futures',
      state: 'live', trading_status: 'operational',
      only_reduce_only_orders_allowed: false
    }
  ],
  ...patch
});

const trustedInputs = patch => ({
  catalog: catalog(),
  executionMode: 'testnet',
  accountDataProtected: false,
  positions: [{ symbol: 'BTCUSD', qty: 1, status: 'OPEN' }],
  openPositionCount: 1,
  now,
  ...patch
});

test('verified fresh Testnet catalog and a consistent unlocked position ledger verify the route context', () => {
  const result = resolveDashboardRouteContext(trustedInputs());
  assert.equal(result.catalogFresh, true);
  assert.equal(result.routeDataVerified, true);
  assert.equal(result.entrySafetyTrusted, true);
  assert.deepEqual(result.routedSymbols, ['BTCUSD', 'ETHUSD']);
});

test('stale, incomplete, malformed, or unsuccessful product catalogs cannot verify a route', async t => {
  const cases = [
    ['stale', catalog({ checkedAt: new Date(now - TESTNET_ROUTE_CATALOG_MAX_AGE_MS - 1).toISOString() })],
    ['incomplete', catalog({ complete: false })],
    ['unsuccessful', catalog({ success: false })],
    ['count mismatch', catalog({ count: 99 })],
    ['missing products', catalog({ result: null })]
  ];
  for (const [name, value] of cases) {
    await t.test(name, () => {
      const result = resolveDashboardRouteContext(trustedInputs({ catalog: value }));
      assert.equal(result.routeDataVerified, false);
      assert.deepEqual(result.routedSymbols, []);
    });
  }
});

test('route is not verified unless the worker heartbeat confirms Testnet execution mode', () => {
  const result = resolveDashboardRouteContext(trustedInputs({ executionMode: 'disabled' }));
  assert.equal(result.catalogFresh, true);
  assert.equal(result.routeDataVerified, false);
  assert.equal(result.entrySafetyTrusted, false);
});

test('locked account data and missing or mismatched position counts fail closed', async t => {
  const cases = [
    ['account locked', { accountDataProtected: true }],
    ['positions missing', { positions: null }],
    ['count missing', { openPositionCount: null }],
    ['count mismatch', { openPositionCount: 0 }]
  ];
  for (const [name, patch] of cases) {
    await t.test(name, () => {
      const result = resolveDashboardRouteContext(trustedInputs(patch));
      assert.equal(result.entrySafetyTrusted, false);
    });
  }
});

test('malformed and non-tradable product rows are never treated as usable routes', () => {
  const routeCatalog = catalog({
    count: 4,
    result: [
      catalog().result[0],
      { id: 2, symbol: 'ETHUSD', contract_type: 'perpetual_futures', state: 'live', trading_status: 'operational', only_reduce_only_orders_allowed: true },
      { id: 3, symbol: 'BAD SYMBOL', contract_type: 'perpetual_futures', state: 'live', trading_status: 'operational', only_reduce_only_orders_allowed: false },
      { id: 4, symbol: 'HALTUSD', contract_type: 'perpetual_futures', state: 'live', trading_status: 'disrupted_cancel_only', only_reduce_only_orders_allowed: false }
    ]
  });
  const result = resolveDashboardRouteContext(trustedInputs({ catalog: routeCatalog }));
  assert.equal(result.routeDataVerified, true);
  assert.deepEqual(result.routedSymbols, ['BTCUSD']);
});
