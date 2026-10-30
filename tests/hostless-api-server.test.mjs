import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostlessApiServer } from '../server/hostless-api.mjs';

async function withServer(run) {
  const server = createHostlessApiServer({
    allowedOrigins: ['https://dashboard.example'],
    handlers: {
      '/api/health': async (req, res) => res.status(200).json({ success: true, query: req.query, method: req.method }),
      '/api/engine/toggle': async (req, res) => res.status(200).json({ success: true, body: req.body })
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await run(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Hostless API exposes a JSON health check', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/healthz');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type')?.includes('application/json'), true);
    assert.equal(body.success, true);
    assert.equal(body.service, 'dealdost-hostless-api');
  });
});

test('Hostless API routes requests with query parameters and credentialed CORS', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/health?source=dashboard', { headers: { Origin: 'https://dashboard.example' } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.query.source, 'dashboard');
    assert.equal(body.method, 'GET');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://dashboard.example');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  });
});

test('Hostless API parses JSON mutation bodies', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/engine/toggle', {
      method: 'POST',
      headers: { Origin: 'https://dashboard.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoTrade: false })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.body, { autoTrade: false });
  });
});

test('Hostless API rejects untrusted origins and returns JSON for unknown routes', async () => {
  await withServer(async base => {
    const blocked = await fetch(base + '/api/health', { headers: { Origin: 'https://attacker.example' } });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).success, false);
    const missing = await fetch(base + '/api/not-a-route');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('content-type')?.includes('application/json'), true);
  });
});

test('Hostless API answers credentialed CORS preflight', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/engine/session', {
      method: 'OPTIONS',
      headers: { Origin: 'https://dashboard.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, DELETE, OPTIONS');
  });
});
