import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaAdapter, optionTickerRequestOptions } from '../worker/delta-adapter.mjs';

function captureRequest(adapter) {
  let captured = null;
  adapter.request = async (method, path, params, body, auth, options) => {
    captured = { method, path, params, body, auth, options };
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


test('optionTickers() requests the filtered option chain using the mode-specific market-data host', async () => {
  const adapter = new DeltaAdapter();
  const getRequest = captureRequest(adapter);
  await adapter.optionTickers('BTC');
  const request = getRequest();
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/v2/tickers');
  assert.deepEqual(request.params, {
    contract_types: 'call_options,put_options',
    underlying_asset_symbols: 'BTC'
  });
  assert.equal(request.auth, false);
  assert.deepEqual(request.options, optionTickerRequestOptions());
});

test('optionTicker() requests a single BTC/ETH option contract and rejects unsupported symbols', async () => {
  const adapter = new DeltaAdapter();
  const getRequest = captureRequest(adapter);
  await adapter.optionTicker('C-BTC-80000-311226');
  const request = getRequest();
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/v2/tickers/C-BTC-80000-311226');
  assert.equal(request.auth, false);
  assert.deepEqual(request.options, optionTickerRequestOptions());
  assert.throws(() => adapter.optionTicker('C-XAUT-4000-311226'), /Invalid BTC\/ETH Delta option contract symbol/);
});
