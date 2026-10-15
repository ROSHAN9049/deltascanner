import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ledger-server imports pg-adapter; set a harmless placeholder before the
// dynamic import so tests can compose the app without connecting to a database.
process.env.DATABASE_URL ||= 'postgresql://http-test:http-test@127.0.0.1:5432/http-test';
process.env.TRADETRON_WEBHOOK_SECRET = 'test-secret';

const { createApp } = await import('../src/server/ledger-server.mjs');

const fakeLedger = {
  verifySignature(body, signature) {
    const expected = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
    if (typeof signature !== 'string' || signature.length !== expected.length) return false;
    const actualBytes = Buffer.from(signature, 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    return actualBytes.length === expectedBytes.length &&
      crypto.timingSafeEqual(actualBytes, expectedBytes);
  },
  async onWebhook() {
    return { success: true, processed: true };
  },
  async getGlobalCount() {
    return 0;
  },
  async reconcileWithSnapshot(snapshot) {
    const onlyInSnapshot = snapshot.map(item => `${item.symbol}:${item.side}`);
    return {
      ledgerCount: 0,
      snapshotCount: snapshot.length,
      matched: 0,
      onlyInLedger: [],
      onlyInSnapshot,
      isSynced: onlyInSnapshot.length === 0,
      checkedAt: new Date().toISOString()
    };
  }
};

const fakeDb = {
  async query() {
    return { rows: [], rowCount: 1 };
  }
};
const fakeLogger = { info() {}, warn() {}, error() {} };

let server;
let baseUrl;
let closePool;

function signatureFor(body) {
  return crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
}

function entryBody() {
  return JSON.stringify({
    id: 'http-test-event',
    type: 'ENTRY_FILLED',
    orderId: 'http-test-order',
    symbol: 'BTCUSD',
    side: 'LONG',
    qty: 1,
    price: 50000,
    timestamp: new Date().toISOString()
  });
}

async function postWebhook(body, signature) {
  const headers = { 'content-type': 'application/json' };
  if (signature !== undefined) headers['x-tradetron-signature'] = signature;
  return fetch(`${baseUrl}/webhook/tradetron`, {
    method: 'POST',
    headers,
    body
  });
}

describe('Optional ledger server HTTP integration', () => {
  before(async () => {
    const app = createApp({
      db: fakeDb,
      positionLedger: fakeLedger,
      tradetronAPI: { getSnapshot: async () => [] },
      logger: fakeLogger
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
    const pgAdapter = await import('../src/ledger/pg-adapter.mjs');
    closePool = pgAdapter.closePool;
    if (closePool) await closePool();
  });

  test('POST /webhook/tradetron returns 401 for missing signature', async () => {
    const body = entryBody();
    const response = await postWebhook(body);
    assert.strictEqual(response.status, 401);
  });

  test('POST /webhook/tradetron returns 400 for invalid JSON', async () => {
    const response = await postWebhook('not json', 'invalid-signature');
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.strictEqual(body.error, 'Invalid JSON');
  });

  test('POST /webhook/tradetron returns 401 for invalid signature', async () => {
    const body = entryBody();
    const response = await postWebhook(body, '0'.repeat(64));
    assert.strictEqual(response.status, 401);
  });

  test('POST /webhook/tradetron returns 200 for valid signature', async () => {
    const body = entryBody();
    const response = await postWebhook(body, signatureFor(body));
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.duplicate, false);
  });

  test('GET /api/ledger/health returns 200 with count', async () => {
    const response = await fetch(`${baseUrl}/api/ledger/health`);
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.ledgerCount, 0);
  });

  test('GET /api/ledger/status returns 200 with reconciliation', async () => {
    const response = await fetch(`${baseUrl}/api/ledger/status`);
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.ledgerCount, 0);
    assert.strictEqual(payload.snapshotCount, 0);
    assert.strictEqual(payload.isSynced, true);
  });

  test('unknown route returns 404', async () => {
    const response = await fetch(`${baseUrl}/nonexistent`);
    assert.strictEqual(response.status, 404);
  });
});
