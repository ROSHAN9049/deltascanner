import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createDeltaPositionReconciler,
  DELTA_POSITION_RECONCILE_INTERVAL_MS
} from '../worker/execution/delta-reconciler.mjs';

function runtime({ openRows = [], exchangePositions = [], envMode = 'testnet', apiError = null } = {}) {
  const rows = openRows.map(row => ({ status: 'OPEN', ...row }));
  const updates = [];
  const inserts = [];
  const logs = [];
  let apiCalls = 0;
  const database = {
    async select(table, query) {
      if (table !== 'dd_delta_positions') return [];
      const symbolMatch = query.match(/symbol=eq\.([^&]+)/);
      if (symbolMatch) {
        const symbol = decodeURIComponent(symbolMatch[1]);
        return rows.filter(row => row.status === 'OPEN' && row.symbol === symbol).map(row => ({ ...row }));
      }
      if (query.includes('status=eq.OPEN')) {
        return rows.filter(row => row.status === 'OPEN').map(row => ({ ...row }));
      }
      return [];
    },
    async updateReturning(table, query, patch) {
      const idMatch = query.match(/id=eq\.([^&]+)/);
      const row = rows.find(item => String(item.id) === decodeURIComponent(idMatch?.[1] || '') &&
        (!query.includes('status=eq.OPEN') || item.status === 'OPEN'));
      if (!row) return [];
      Object.assign(row, patch);
      updates.push({ table, query, patch: { ...patch } });
      return [{ ...row }];
    },
    async update(table, query, patch) {
      return this.updateReturning(table, query, patch);
    },
    async insert(table, row) {
      const saved = { id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1, ...row };
      rows.push(saved);
      inserts.push({ table, row: { ...saved } });
      return [];
    },
    async log(level, message, data) {
      logs.push({ level, message, data });
    }
  };
  const executor = {
    async getOpenPositions() {
      apiCalls += 1;
      if (apiError) throw apiError;
      return exchangePositions;
    }
  };
  return { rows, updates, inserts, logs, database, executor, apiCalls: () => apiCalls, env: { DELTA_EXECUTION_MODE: envMode } };
}

const fixedNow = () => Date.parse('2026-10-26T00:00:00.000Z');

test('reconciler refreshes mark and unrealized P&L when quantity and side match', async () => {
  const rt = runtime({
    openRows: [{
      id: 1,
      symbol: 'XAUTUSD',
      qty: 37,
      side: 'BUY',
      entry_price: 3871.87,
      current_price: 4000,
      unrealized_pnl: -6.73
    }],
    exchangePositions: [{
      symbol: 'XAUTUSD',
      qty: 37,
      side: 'BUY',
      entry_price: 3871.87,
      current_price: 4050,
      unrealized_pnl: 6.34,
      product_id: 181689
    }]
  });
  rt.executor.getProductMetadata = async () => ({
    symbol: 'XAUTUSD',
    contract_value: '0.001',
    notional_type: 'vanilla'
  });

  const reconciler = createDeltaPositionReconciler({
    env: rt.env, database: rt.database,
    executor: rt.executor, now: fixedNow
  });

  await reconciler.reconcile();

  assert.equal(rt.rows[0].qty, 37);
  assert.equal(rt.rows[0].side, 'BUY');
  assert.equal(rt.rows[0].current_price, 4050);
  assert.equal(rt.rows[0].unrealized_pnl, 6.34);
  assert.equal(rt.updates.length, 1);
  assert.ok(!rt.logs.some(row =>
    row.message.includes('quantity/side mismatch')
  ));
  assert.ok(!rt.logs.some(row => row.data?.event === 'upl_mismatch'));
});

test('reconciler logs upl_mismatch when local vanilla P&L has opposite sign', async () => {
  const rt = runtime({
    openRows: [{
      id: 1,
      symbol: 'XAUTUSD',
      qty: 37,
      side: 'BUY',
      entry_price: 3871.87,
      current_price: 4000,
      unrealized_pnl: -6.73
    }],
    exchangePositions: [{
      symbol: 'XAUTUSD',
      qty: 37,
      side: 'BUY',
      entry_price: 3871.87,
      current_price: 4050,
      unrealized_pnl: -6.73
    }]
  });
  rt.executor.getProductMetadata = async () => ({
    symbol: 'XAUTUSD',
    contract_value: '0.001',
    notional_type: 'vanilla'
  });

  const reconciler = createDeltaPositionReconciler({
    env: rt.env, database: rt.database,
    executor: rt.executor, now: fixedNow
  });

  await reconciler.reconcile();

  const warning = rt.logs.find(row => row.data?.event === 'upl_mismatch');
  assert.ok(warning);
  assert.equal(warning.data.symbol, 'XAUTUSD');
  assert.ok(warning.data.localUpl > 0);
  assert.equal(warning.data.exchangeUpl, -6.73);
  assert.ok(warning.data.driftPct > 5);
});

test('reconciler is Testnet-only and never calls the exchange API in disabled mode', async () => {
  const rt = runtime({ envMode: 'disabled', openRows: [{ id: 1, symbol: 'BTCUSD', qty: 1, side: 'BUY' }] });
  const reconciler = createDeltaPositionReconciler({ env: rt.env, database: rt.database, executor: rt.executor, now: fixedNow });
  await assert.rejects(reconciler.reconcile(), /DELTA_EXECUTION_MODE must be testnet/);
  assert.equal(rt.apiCalls(), 0);
  assert.equal(rt.updates.length, 0);
  assert.equal(rt.inserts.length, 0);
});

test('missing exchange positions are marked CLOSED_EXTERNALLY without fabricating realized P&L', async () => {
  const rt = runtime({
    openRows: [{ id: 1, symbol: 'BTCUSD', qty: 2, side: 'BUY', realized_pnl: null, unrealized_pnl: -4 }],
    exchangePositions: []
  });
  const reconciler = createDeltaPositionReconciler({
    env: rt.env, database: rt.database, executor: rt.executor, now: fixedNow
  });
  const summary = await reconciler.reconcile();
  assert.equal(summary.zombiePositions, 1);
  assert.equal(summary.markedClosedExternally, 1);
  assert.equal(rt.rows[0].status, 'CLOSED_EXTERNALLY');
  assert.equal(rt.rows[0].closed_at, '2026-10-26T00:00:00.000Z');
  assert.equal(rt.rows[0].unrealized_pnl, 0);
  assert.equal(rt.rows[0].realized_pnl, null);
  assert.ok(rt.logs.some(row => row.message.includes('Found 1 zombie positions. Marked 1 as CLOSED_EXTERNALLY.')));
});

test('REST reconciliation persists close-fill details only when they are verifiable', async () => {
  const rt = runtime({
    openRows: [{
      id: 1, symbol: 'BTCUSD', qty: 1, side: 'BUY',
      entry_price: 100, opened_at: '2026-10-28T00:00:00.000Z',
      current_price: 105, unrealized_pnl: 5, realized_pnl: null
    }],
    exchangePositions: []
  });
  rt.executor.getRecentCloseDetails = async () => ({
    exit_price: 106,
    fees: 0.2,
    fee_currency: 'USD',
    realized_pnl: 6,
    close_order_id: '9001',
    stop_order_type: 'take_profit_order',
    client_order_id: 'DDM-BTCUSD-entry',
    close_order_history_found: true
  });

  const reconciler = createDeltaPositionReconciler({
    env: rt.env, database: rt.database, executor: rt.executor, now: fixedNow
  });
  await reconciler.reconcile();

  assert.equal(rt.rows[0].status, 'CLOSED');
  assert.equal(rt.rows[0].exit_price, 106);
  assert.equal(rt.rows[0].fees, 0.2);
  assert.equal(rt.rows[0].fee_currency, 'USD');
  assert.equal(rt.rows[0].realized_pnl, 6);
  assert.equal(rt.rows[0].exit_reason, 'take_profit_order');
  assert.equal(rt.rows[0].close_order_id, '9001');
});

test('quantity and side mismatches sync local DB to the exchange; missing DB rows are hydrated', async () => {
  const rt = runtime({
    openRows: [
      { id: 1, symbol: 'ETHUSD', qty: 5, side: 'BUY', realized_pnl: 0 },
      { id: 2, symbol: 'BTCUSD', qty: 1, side: 'SELL', realized_pnl: 0 }
    ],
    exchangePositions: [
      { symbol: 'ETHUSD', qty: 2, side: 'SELL', entry_price: 3000, current_price: 3020, unrealized_pnl: 2 },
      { symbol: 'SOLUSD', qty: 3, side: 'BUY', entry_price: 100, current_price: 101, unrealized_pnl: 1, product_id: 22 }
    ]
  });
  const reconciler = createDeltaPositionReconciler({
    env: rt.env, database: rt.database, executor: rt.executor, now: fixedNow
  });
  const summary = await reconciler.reconcile();
  assert.equal(summary.zombiePositions, 1);
  assert.equal(summary.markedClosedExternally, 1);
  assert.equal(summary.quantityMismatches, 1);
  assert.equal(summary.hydratedPositions, 1);
  const eth = rt.rows.find(row => row.symbol === 'ETHUSD');
  assert.equal(eth.qty, 2);
  assert.equal(eth.side, 'SELL');
  assert.equal(eth.current_price, 3020);
  assert.equal(rt.rows.find(row => row.symbol === 'BTCUSD').status, 'CLOSED_EXTERNALLY');
  const sol = rt.rows.find(row => row.symbol === 'SOLUSD');
  assert.equal(sol.status, 'OPEN');
  assert.equal(sol.qty, 3);
  assert.equal(sol.side, 'BUY');
  assert.equal(rt.inserts.length, 1);
  assert.ok(rt.logs.some(row => row.level === 'WARN' && row.message.includes('quantity/side mismatch')));
});

test('exchange API failure never closes local rows', async () => {
  const rt = runtime({
    openRows: [{ id: 1, symbol: 'BTCUSD', qty: 1, side: 'BUY' }],
    apiError: new Error('Delta API unavailable')
  });
  const reconciler = createDeltaPositionReconciler({
    env: rt.env, database: rt.database, executor: rt.executor, now: fixedNow
  });
  await assert.rejects(reconciler.reconcile(), /Delta API unavailable/);
  assert.equal(rt.rows[0].status, 'OPEN');
  assert.equal(rt.updates.length, 0);
});

test('startup reconciliation runs immediately and uses a five-minute interval', async () => {
  assert.equal(DELTA_POSITION_RECONCILE_INTERVAL_MS, 5 * 60 * 1000);
  const rt = runtime();
  const reconciler = createDeltaPositionReconciler({
    env: rt.env, database: rt.database, executor: rt.executor, now: fixedNow
  });
  await reconciler.start();
  assert.equal(rt.apiCalls(), 1);
  assert.ok(rt.logs.some(row => row.message.includes('Found 0 zombie positions. Marked 0 as CLOSED_EXTERNALLY.')));
  await reconciler.stop();
});

test('worker wires reconciler after private API validation and stops it during shutdown', async () => {
  const index = await readFile(new URL('../worker/index.mjs', import.meta.url), 'utf8');
  const tracker = await readFile(new URL('../worker/execution/delta-tracker.mjs', import.meta.url), 'utf8');
  assert.match(index, /import \{ createDeltaPositionReconciler \} from '\.\/execution\/delta-reconciler\.mjs'/);
  assert.match(index, /await reconciler\.start\(\)/);
  assert.match(index, /reconcilerToStop\?\.stop\(\)/);
  assert.doesNotMatch(tracker, /this\.reconcileTimer = setInterval/);
  assert.doesNotMatch(tracker, /async reconcilePositions\(\)/);
});

test('external-closure schema and dashboard queries preserve the audit marker', async () => {
  const migration = await readFile(new URL('../db/migrations/20261026120000_delta_position_external_close.sql', import.meta.url), 'utf8');
  const api = await readFile(new URL('../api/engine/state.js', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(migration, /status IN \('OPEN', 'CLOSED', 'CLOSED_EXTERNALLY'\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ/i);
  assert.match(api, /status=in\.\(CLOSED,CLOSED_EXTERNALLY\)/);
  assert.match(ui, /CLOSED EXTERNALLY/);
  assert.match(ui, /P&amp;L NOT VERIFIED/);
});

test('malformed REST snapshots are not treated as an empty account by the executor', async () => {
  const { createDeltaExecutor, DELTA_TESTNET_REST_BASE, DELTA_TESTNET_PRIVATE_WS_URL } =
    await import('../worker/execution/delta-executor.mjs');
  const executor = createDeltaExecutor({
    env: {
      DELTA_EXECUTION_MODE: 'testnet',
      DELTA_TESTNET_API_KEY: 'demo-key-not-real',
      DELTA_TESTNET_API_SECRET: 'demo-secret-not-real',
      DELTA_TESTNET_REST_BASE,
      DELTA_TESTNET_WS_URL: DELTA_TESTNET_PRIVATE_WS_URL
    },
    fetchImpl: async () => new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(executor.getOpenPositions(), /malformed/);
});

test('migration runner includes nullable Delta close details migration after external close migration', async () => {
  const runner = await readFile(new URL('../scripts/apply-all-migrations.mjs', import.meta.url), 'utf8');
  const externalCloseIndex = runner.indexOf("'db/migrations/20261026120000_delta_position_external_close.sql'");
  const closeDetailsIndex = runner.indexOf("'db/migrations/20261029110000_delta_position_close_details.sql'");
  assert.ok(externalCloseIndex >= 0);
  assert.ok(closeDetailsIndex > externalCloseIndex);
});
