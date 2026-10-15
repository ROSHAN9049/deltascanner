import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registerTradetronWebhook = require('../src/webhooks/tradetron-handler.cjs');
const { logWebhookEvent } = registerTradetronWebhook._internal;

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

function createFakeDb() {
  const events = [];
  const queries = [];
  return {
    events,
    queries,
    async query(sql, params = []) {
      queries.push({ sql: sql.trim(), params });
      const normalized = sql.trim().toLowerCase();
      if (normalized.startsWith('insert into webhook_events')) {
        const existing = events.find(row => row.event_id === params[0]);
        if (!existing) {
          events.push({
            event_id: params[0],
            event_type: params[1],
            symbol: params[2],
            raw_payload: params[3],
            signature_valid: params[4],
            status: params[5],
            error_message: params[6]
          });
        }
        return { rows: [], rowCount: existing ? 0 : 1 };
      }

      if (normalized.startsWith('update webhook_events')) {
        const eventId = normalized.includes('where event_id = $1') ? params[0] : params[1];
        const row = events.find(item => item.event_id === eventId);
        if (row) {
          if (normalized.includes('set status = \'processed\'')) {
            row.status = 'PROCESSED';
          } else if (normalized.includes('set status = \'failed\'')) {
            row.status = 'FAILED';
            row.error_message = params[0];
          }
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

function makeHarness({
  verifySignature = () => true,
  onWebhook = async () => ({ success: true, processed: true }),
  logger = silentLogger
} = {}) {
  const app = createFakeApp();
  const db = createFakeDb();
  const positionLedger = { verifySignature, onWebhook };
  registerTradetronWebhook(app, { db, positionLedger, logger });
  const handlers = app.routes['POST /webhook/tradetron'];
  return { app, db, positionLedger, handler: handlers.at(-1), handlers };
}

function makeRequest(body, signature = crypto.createHmac('sha256', 'unit-test').update(body).digest('hex')) {
  return {
    headers: { 'x-tradetron-signature': signature },
    body: Buffer.from(body, 'utf8')
  };
}

const validEvent = JSON.stringify({
  id: 'evt-1',
  type: 'ENTRY_FILLED',
  orderId: 'ord-1',
  symbol: 'BTCUSD',
  side: 'LONG',
  qty: 1,
  price: 50000,
  timestamp: new Date().toISOString()
});

describe('Tradetron webhook route', () => {
  test('registers POST /webhook/tradetron', () => {
    const { app } = makeHarness();
    assert.ok(app.routes['POST /webhook/tradetron']);
  });

  test('returns 400 for invalid JSON', async () => {
    const { handler } = makeHarness();
    const res = createFakeRes();
    await handler(makeRequest('not json'), res);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'Invalid JSON' });
  });

  test('returns 401 for signature failure', async () => {
    const { handler } = makeHarness({ verifySignature: () => false });
    const res = createFakeRes();
    await handler(makeRequest(validEvent, 'abc'), res);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: 'Unauthorized' });
  });

  test('returns 500 when signature verification throws', async () => {
    const { handler } = makeHarness({
      verifySignature: () => { throw new Error('no secret'); }
    });
    const res = createFakeRes();
    await handler(makeRequest(validEvent), res);
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { error: 'Signature verification unavailable' });
  });

  test('returns 200 on successful processing', async () => {
    const { handler } = makeHarness({
      verifySignature: () => true,
      onWebhook: async () => ({ success: true, processed: true })
    });
    const res = createFakeRes();
    await handler(makeRequest(validEvent), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
  });

  test('returns 500 when processing fails', async () => {
    const { handler } = makeHarness({
      verifySignature: () => true,
      onWebhook: async () => { throw new Error('boom'); }
    });
    const res = createFakeRes();
    await handler(makeRequest(validEvent), res);
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { error: 'Processing failed' });
  });

  test('logWebhookEvent uses ON CONFLICT DO NOTHING', async () => {
    const db = createFakeDb();
    await logWebhookEvent(db, {
      event_id: 'evt-idempotent',
      event_type: 'ENTRY_FILLED',
      symbol: 'BTCUSD',
      raw_payload: { ok: true },
      signature_valid: true,
      status: 'RECEIVED',
      error_message: null
    });
    assert.ok(db.queries.length >= 1);
    assert.match(db.queries[0].sql, /on conflict\s*\(event_id\)\s*do nothing/i);
  });
});
