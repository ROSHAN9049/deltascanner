import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Import-only smoke tests must never contact a database. A dummy URL allows
// pg.Pool to be constructed when this script runs without local DB variables;
// no query is issued by this file.
process.env.DATABASE_URL ||= 'postgresql://smoke:smoke@127.0.0.1:5432/smoke';

const require = createRequire(import.meta.url);
const { PositionLedger } = require('../src/ledger/PositionLedger.cjs');

const [
  ledgerModule,
  webhookModule,
  routeModule,
  pgAdapter,
  snapshotAdapter,
  ledgerServer,
  deltaOptionsExecutor
] = await Promise.all([
  import('../src/ledger/index.mjs'),
  import('../src/webhooks/index.mjs'),
  import('../src/routes/index.mjs'),
  import('../src/ledger/pg-adapter.mjs'),
  import('../src/adapters/tradetron-snapshot-adapter.mjs'),
  import('../src/server/ledger-server.mjs'),
  import('../worker/execution/delta-options-executor.mjs')
]);

describe('module-load smoke tests', () => {
  test('all ESM wrappers import without error', () => {
    assert.strictEqual(typeof ledgerModule.PositionLedger, 'function');
    assert.strictEqual(typeof webhookModule.default, 'function');
    assert.strictEqual(typeof routeModule.default, 'function');
  });

  test('PositionLedger class is constructible with a fake db', () => {
    const ledger = new PositionLedger({ query: async () => ({ rows: [], rowCount: 0 }) }, {
      logger: { info() {}, warn() {}, error() {} }
    });
    assert.ok(ledger instanceof PositionLedger);
  });

  test('registerTradetronWebhook is a function', () => {
    assert.strictEqual(typeof webhookModule.default, 'function');
  });

  test('registerLedgerStatusRoute is a function', () => {
    assert.strictEqual(typeof routeModule.default, 'function');
  });

  test('tradetronAPI adapter exports getSnapshot', () => {
    assert.strictEqual(typeof snapshotAdapter.tradetronAPI.getSnapshot, 'function');
  });

  test('pg-adapter exports db and closePool without connecting', () => {
    assert.strictEqual(typeof pgAdapter.db.query, 'function');
    assert.strictEqual(typeof pgAdapter.closePool, 'function');
  });

  test('ledger-server exports createApp and main', () => {
    assert.strictEqual(typeof ledgerServer.createApp, 'function');
    assert.strictEqual(typeof ledgerServer.main, 'function');
  });

  test('Delta Options executor module loads without opening a private connection', () => {
    assert.strictEqual(typeof deltaOptionsExecutor.createDeltaOptionsExecutor, 'function');
    assert.strictEqual(typeof deltaOptionsExecutor.assertDeltaOptionsTestnetConfiguration, 'function');
  });
});
