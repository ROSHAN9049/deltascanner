import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaAdapter } from '../worker/delta-adapter.mjs';

function captureRequest(adapter) {
  let captured = null;
  adapter.request = async (method, path, params, body, auth) => {
    captured = { method, path, params, body, auth };
    return [];
  };
  return () => captured;
}

test('candles() builds correct request window for 1h resolution', async () => {
  const adapter = new DeltaAdapter();
  const getRequest = captureRequest(adapter);
  const limit = 250;

  await adapter.candles('BTCUSD', '1h', limit);

  const request = getRequest();
  assert.ok(request, 'candles() should call request()');
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/v2/history/candles');
  assert.equal(request.params.symbol, 'BTCUSD');
  assert.equal(request.params.resolution, '1h');
  assert.ok(
    request.params.end - request.params.start >= 250 * 3600,
    '1h request window should cover at least 250 hours (900,000 seconds)'
  );
});

test('candles() preserves 1m, 5m, 15m behavior', async (t) => {
  const secondsByResolution = {
    '1m': 60,
    '5m': 300,
    '15m': 900
  };
  const limit = 250;

  for (const [resolution, seconds] of Object.entries(secondsByResolution)) {
    await t.test(resolution, async () => {
      const adapter = new DeltaAdapter();
      const getRequest = captureRequest(adapter);

      await adapter.candles('BTCUSD', resolution, limit);

      const request = getRequest();
      assert.ok(request, 'candles() should call request()');
      assert.equal(request.params.resolution, resolution);
      assert.equal(
        request.params.end - request.params.start,
        seconds * (limit + 3),
        `${resolution} request window should remain seconds × (limit + 3)`
      );
    });
  }
});

test('optionProducts() requests live call and put option contracts from the configured environment', async () => {
  const adapter = new DeltaAdapter();
  const getRequest = captureRequest(adapter);
  await adapter.optionProducts();
  const request = getRequest();
  assert.ok(request, 'optionProducts() should call request()');
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/v2/products');
  assert.equal(request.params.contract_types, 'call_options,put_options');
  assert.equal(request.params.states, 'live');
  assert.equal(request.params.page_size, 100);
  assert.equal(request.auth, false);
});
