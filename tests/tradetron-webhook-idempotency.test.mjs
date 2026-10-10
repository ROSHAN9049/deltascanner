import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DELTA_ENVIRONMENT = 'SIGNAL_ONLY';
process.env.SUPABASE_URL = 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_unit_test_only';
process.env.TRADETRON_WEBHOOK_SECRET = 'unit-test-webhook-secret';

const { default: webhook, numberValue, resolveGrossPnl, tradetronOpenPositionQuery } =
  await import('../api/tradetron/webhook.js?unit-test-idempotency');

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function makeResponse(status = 204) {
  return new Response(null, { status });
}

function makeResponseCollector() {
  return {
    code: 200,
    body: null,
    setHeader() { return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('missing numeric fields stay missing, so absent PnL uses the calculated fallback', () => {
  assert.equal(numberValue([], ['qty']), null);
  assert.equal(numberValue([{ qty: '' }], ['qty']), null);
  assert.equal(numberValue([{ qty: '12.5' }], ['qty']), 12.5);
  assert.equal(numberValue([], ['fees'], 0), 0);
  assert.equal(resolveGrossPnl(null, 17.25), 17.25);
  assert.equal(resolveGrossPnl(undefined, -3.5), -3.5);
  assert.equal(resolveGrossPnl(0, 17.25), 0);
  assert.equal(resolveGrossPnl('4.25', 17.25), 4.25);
});

test('Tradetron position reconciliation is restricted to Tradetron-owned rows', () => {
  assert.equal(
    tradetronOpenPositionQuery('BTCUSD'),
    'symbol=eq.BTCUSD&origin=eq.TRADETRON&qty=gt.0&order=updated_at.desc&limit=1'
  );
});

test('a failed fill event can be retried, while a successfully processed retry is not applied twice', async () => {
  const eventRows = new Map();
  const calls = { eventPosts: 0, positionPosts: 0, positionInserts: 0, infoLogs: 0 };
  let failFirstPositionInsert = true;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/rest/v1/')[1] || '';
    const method = String(init.method || 'GET').toUpperCase();

    if (table === 'dd_tradetron_events' && method === 'POST') {
      calls.eventPosts += 1;
      const incoming = JSON.parse(init.body);
      if (eventRows.has(incoming.event_id)) return jsonResponse([]);
      eventRows.set(incoming.event_id, {
        ...incoming,
        sync_status: 'RECEIVED',
        processing_started_at: null,
        processed_at: null,
        sync_result: null,
        sync_error: null
      });
      return jsonResponse([{ event_id: incoming.event_id }], 201);
    }

    if (table === 'dd_tradetron_events' && method === 'PATCH') {
      const idFilter = url.searchParams.get('event_id') || '';
      const eventId = idFilter.startsWith('eq.') ? idFilter.slice(3) : '';
      const row = eventRows.get(eventId);
      if (!row) return jsonResponse([]);

      const statusFilter = url.searchParams.get('sync_status') || '';
      const startedFilter = url.searchParams.get('processing_started_at') || '';
      const currentStarted = row.processing_started_at || '';
      let match = false;
      if (statusFilter === 'in.(RECEIVED,ERROR)') {
        match = ['RECEIVED', 'ERROR'].includes(row.sync_status);
      } else if (statusFilter === 'eq.PROCESSING') {
        match = row.sync_status === 'PROCESSING';
        if (startedFilter.startsWith('lt.')) {
          match = match && Date.parse(currentStarted) < Date.parse(startedFilter.slice(3));
        } else if (startedFilter.startsWith('eq.')) {
          match = match && currentStarted === startedFilter.slice(3);
        }
      }
      if (!match) return jsonResponse([]);

      Object.assign(row, JSON.parse(init.body));
      return jsonResponse([row]);
    }

    if (table === 'dd_tradetron_events' && method === 'GET') {
      const idFilter = url.searchParams.get('event_id') || '';
      const eventId = idFilter.startsWith('eq.') ? idFilter.slice(3) : '';
      const row = eventRows.get(eventId);
      return jsonResponse(row ? [{
        sync_status: row.sync_status,
        processed_at: row.processed_at,
        sync_result: row.sync_result
      }] : []);
    }

    if (table === 'dd_engine_logs' && method === 'POST') {
      const row = JSON.parse(init.body);
      if (row.level === 'INFO') calls.infoLogs += 1;
      return makeResponse(201);
    }

    if (table === 'dd_orders' && method === 'GET') return jsonResponse([]);
    if (table === 'dd_signals' && method === 'GET') return jsonResponse([]);
    if (table === 'dd_market_cache' && method === 'GET') {
      return jsonResponse([{ symbol: 'BTCUSD', product_id: 1, contract_value: 1, mark_price: 100, price: 100 }]);
    }
    if (table === 'dd_positions' && method === 'GET') return jsonResponse([]);
    if (table === 'dd_positions' && method === 'POST') {
      calls.positionPosts += 1;
      if (failFirstPositionInsert) {
        failFirstPositionInsert = false;
        return jsonResponse({ message: 'mock transient database failure' }, 500);
      }
      calls.positionInserts += 1;
      return makeResponse(201);
    }
    if (table === 'dd_orders' && method === 'PATCH') return makeResponse(204);

    return jsonResponse([]);
  };

  const request = {
    method: 'POST',
    headers: {
      authorization: 'Bearer unit-test-webhook-secret',
      'content-type': 'application/json'
    },
    query: {},
    url: '/api/tradetron/webhook',
    body: {
      event_id: 'evt-idempotency-1',
      event_type: 'ORDER_FILLED',
      execution_id: 'exec-idempotency-1',
      symbol: 'BTCUSD',
      side: 'BUY',
      qty: 1,
      price: 100,
      product_id: 1
    }
  };

  const failedResponse = makeResponseCollector();
  await webhook(request, failedResponse);
  assert.equal(failedResponse.code, 400);
  assert.equal(eventRows.get('evt-idempotency-1')?.sync_status, 'ERROR');

  const retryResponse = makeResponseCollector();
  await webhook(request, retryResponse);
  assert.equal(retryResponse.code, 200);
  assert.equal(retryResponse.body.position_sync.action, 'created_from_fill');
  assert.equal(eventRows.get('evt-idempotency-1')?.sync_status, 'PROCESSED');

  const duplicateResponse = makeResponseCollector();
  await webhook(request, duplicateResponse);
  assert.equal(duplicateResponse.code, 200);
  assert.equal(duplicateResponse.body.duplicate, true);
  assert.equal(calls.eventPosts, 3);
  assert.equal(calls.positionPosts, 2);
  assert.equal(calls.positionInserts, 1);
  assert.equal(calls.infoLogs, 1);
});
