import test from 'node:test';
import assert from 'node:assert/strict';
import previewHandler from '../api/options/preview.js';
import executeHandler from '../api/options/execute.js';
import { HOSTLESS_API_ROUTES } from '../server/hostless-api.mjs';

function responseMock() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

test('Hostless API exposes authenticated Options preview and execution routes', () => {
  assert.equal(HOSTLESS_API_ROUTES['/api/options/preview'], previewHandler);
  assert.equal(HOSTLESS_API_ROUTES['/api/options/execute'], executeHandler);
});

test('Options preview rejects unauthenticated requests before accessing the executor', async () => {
  const res = responseMock();
  await previewHandler({ method: 'POST', headers: {}, body: { symbol: 'C-BTC-80000-311226' } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.success, false);
  assert.equal(res.payload.error, 'Unauthorized');
  assert.equal(res.headers['Cache-Control'], 'no-store, no-cache, max-age=0, must-revalidate');
});

test('Options execution rejects unauthenticated requests before placing orders', async () => {
  const res = responseMock();
  await executeHandler({ method: 'POST', headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.success, false);
  assert.equal(res.payload.error, 'Unauthorized');
});

test('Options endpoints reject non-POST requests', async () => {
  const preview = responseMock();
  const execute = responseMock();
  await previewHandler({ method: 'GET', headers: {} }, preview);
  await executeHandler({ method: 'GET', headers: {} }, execute);
  assert.equal(preview.statusCode, 405);
  assert.equal(execute.statusCode, 405);
});
