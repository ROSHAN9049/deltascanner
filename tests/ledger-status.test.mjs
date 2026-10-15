import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registerLedgerStatusRoute = require('../src/routes/ledger-status.cjs');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function createFakeApp() {
  const routes = {};
  return {
    routes,
    post(path, ...handlers) { routes[`POST ${path}`] = handlers; },
    get(path, ...handlers) { routes[`GET ${path}`] = handlers; }
  };
}

function createFakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

function makeHarness({
  getGlobalCount = async () => 3,
  reconcileWithSnapshot = async () => ({ isSynced: true, matched: 3, onlyInLedger: [], onlyInSnapshot: [] }),
  getSnapshot = async () => [
    { symbol: 'BTCUSD', side: 'LONG' },
    { symbol: 'ETHUSD', side: 'SHORT' },
    { symbol: 'SOLUSD', side: 'LONG' }
  ],
  logger = silentLogger
} = {}) {
  const app = createFakeApp();
  const positionLedger = { getGlobalCount, reconcileWithSnapshot };
  const tradetronAPI = { getSnapshot };
  registerLedgerStatusRoute(app, { positionLedger, tradetronAPI, logger });
  return {
    app,
    positionLedger,
    tradetronAPI,
    statusHandler: app.routes['GET /api/ledger/status']?.at(-1),
    healthHandler: app.routes['GET /api/ledger/health']?.at(-1)
  };
}

describe('Ledger status API routes', () => {
  test('registers GET /api/ledger/status', () => {
    const { app } = makeHarness();
    assert.ok(app.routes['GET /api/ledger/status']);
  });

  test('returns 200 with synced data', async () => {
    const { statusHandler } = makeHarness({
      getGlobalCount: async () => 3,
      getSnapshot: async () => [
        { symbol: 'BTCUSD', side: 'LONG' },
        { symbol: 'ETHUSD', side: 'SHORT' },
        { symbol: 'SOLUSD', side: 'LONG' }
      ],
      reconcileWithSnapshot: async () => ({
        isSynced: true,
        matched: 3,
        onlyInLedger: [],
        onlyInSnapshot: []
      })
    });
    const res = createFakeRes();
    await statusHandler({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ledgerCount, 3);
    assert.strictEqual(res.body.isSynced, true);
  });

  test('returns 200 with snapshotError when snapshot fetch fails', async () => {
    const { statusHandler } = makeHarness({
      getSnapshot: async () => { throw new Error('timeout'); }
    });
    const res = createFakeRes();
    await statusHandler({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.snapshotError, 'timeout');
    assert.strictEqual(res.body.isSynced, null);
  });

  test('returns 500 when ledger count fails', async () => {
    const { statusHandler } = makeHarness({
      getGlobalCount: async () => { throw new Error('ledger unavailable'); }
    });
    const res = createFakeRes();
    await statusHandler({}, res);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, 'Ledger count unavailable');
  });

  test('registers GET /api/ledger/health', () => {
    const { app } = makeHarness();
    assert.ok(app.routes['GET /api/ledger/health']);
  });

  test('health returns 503 when ledger count fails', async () => {
    const { healthHandler } = makeHarness({
      getGlobalCount: async () => { throw new Error('database unavailable'); }
    });
    const res = createFakeRes();
    await healthHandler({}, res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.ok, false);
  });
});
