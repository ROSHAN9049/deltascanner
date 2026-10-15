import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradetronPayload, isTradetronResponseAccepted, SIGNAL_RESERVATION_TTL_MS, TradetronBridge, withSignalReservations } from '../server/tradetron.js';
import { isAuthenticatedWebhookRequest } from '../api/tradetron/webhook.js';

async function withoutThreeSecondReset(fn) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 3000) return { unref() {} };
    return originalSetTimeout(callback, delay, ...args);
  };
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

test('Tradetron request body uses the exact unnumbered and numbered key/value contract', () => {
  assert.deepEqual(buildTradetronPayload('unit-test-token', [
    ['AAPLXUSD_el', '1'],
    ['AAPLXUSD_ep', 345],
    ['AAPLXUSD_sl', 340],
    ['AAPLXUSD_tp', 350]
  ]), {
    'auth-token': 'unit-test-token',
    key: 'AAPLXUSD_el',
    value: '1',
    key1: 'AAPLXUSD_ep',
    value1: '345',
    key2: 'AAPLXUSD_sl',
    value2: '340',
    key3: 'AAPLXUSD_tp',
    value3: '350'
  });
  assert.throws(() => buildTradetronPayload('', [['AAPLXUSD_el', '1']]), /auth token is missing/);
  assert.throws(() => buildTradetronPayload('unit-test-token', []), /at least one variable pair/);
});

test('Tradetron response is successful only with an explicit acknowledgement', () => {
  assert.equal(isTradetronResponseAccepted(200, 'Ok'), true);
  assert.equal(isTradetronResponseAccepted(200, '{"success":true}'), true);
  assert.equal(isTradetronResponseAccepted(200, 'Invalid token'), false);
  assert.equal(isTradetronResponseAccepted(200, ''), false);
  assert.equal(isTradetronResponseAccepted(429, 'Ok'), false);
});

test('sendPairs posts numbered JSON pairs and rejects HTTP 200 error text', async () => {
  const bridge = new TradetronBridge({
    enabled: true,
    authToken: 'unit-test-token',
    supportedSymbols: ['AAPLXUSD']
  });
  bridge.baseUrl = 'https://tradetron.test';
  const originalFetch = globalThis.fetch;
  let capturedPayload = null;
  let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://tradetron.test/api?');
      capturedPayload = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => 'Ok' };
    };
    const accepted = await bridge.sendPairs([['AAPLXUSD_el', '1'], ['AAPLXUSD_ep', 345]]);
    assert.equal(accepted.ok, true);
    assert.deepEqual(capturedPayload, {
      'auth-token': 'unit-test-token',
      key: 'AAPLXUSD_el',
      value: '1',
      key1: 'AAPLXUSD_ep',
      value1: '345'
    });

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => 'Request rejected: unit-test-token' };
    };
    await assert.rejects(
      bridge.sendPairs([['AAPLXUSD_el', '1']]),
      error => {
        assert.match(error.message, /did not confirm acceptance/);
        assert.equal(error.message.includes('unit-test-token'), false);
        return true;
      }
    );
    assert.equal(calls, 1, 'a 200 error response must not be retried as though it were transient');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeBridge(supportedSymbols = ['BTCUSD', 'ETHUSD']) {
  const bridge = new TradetronBridge({
    enabled: true,
    authToken: 'unit-test-token',
    supportedSymbols
  });
  // These tests validate payload construction, not the live database-backed cap gate.
  bridge.checkGlobalPositionCap = async () => ({
    blocked: false,
    positionSafetyBlocked: false,
    globalPositionCapBlocked: false
  });
  let lastPairs = [];
  bridge.sendPairs = async pairs => {
    lastPairs = pairs;
    return { ok: true, body: 'accepted' };
  };
  return { bridge, getPairs: () => lastPairs };
}

test('futures entry writes the expected legacy quantity before raising its trigger', async () => {
  const { bridge, getPairs } = makeBridge();
  const result = await withoutThreeSecondReset(() => bridge.emitEntry({
    symbol: 'BTCUSD',
    side: 'BUY',
    qty: 3,
    entryPrice: 100,
    sl: 95,
    tp1: 105,
    tp: 110,
    executionId: 'TEST-ENTRY-1',
    strategy: 'MOMENTUM'
  }));
  const pairs = getPairs();
  const indexOf = key => pairs.findIndex(pair => pair[0] === key);
  assert.equal(result.ok, true);
  assert.equal(result.entryVariableKey, 'BTCUSD_el');
  assert.equal(result.globalTriggerKey, 'api_buy');
  assert.equal(result.triggerKey, 'api_buy');
  assert.equal(result.payloadVariableCount, pairs.length);
  assert.deepEqual(result.payloadVariableKeys, pairs.map(([key]) => key));
  assert.equal(pairs.find(pair => pair[0] === 'BTCUSD_q')?.[1], 3);
  assert.equal(pairs.find(pair => pair[0] === 'BTCUSD_qty')?.[1], 3);
  assert.ok(indexOf('BTCUSD_q') < indexOf('BTCUSD_el'));
  assert.ok(indexOf('BTCUSD_ep') < indexOf('BTCUSD_el'));
  assert.equal(pairs.at(-1)?.[0], 'api_buy');
  assert.equal(pairs.at(-1)?.[1], 1);
});

test('short entry diagnostics identify the symbol-specific short trigger', async () => {
  const { bridge } = makeBridge();
  const result = await withoutThreeSecondReset(() => bridge.emitEntry({
    symbol: 'BTCUSD',
    side: 'SELL',
    qty: 2,
    entryPrice: 100,
    sl: 105,
    tp1: 95,
    tp: 90,
    executionId: 'TEST-SHORT-ENTRY',
    strategy: 'MOMENTUM'
  }));
  assert.equal(result.entryVariableKey, 'BTCUSD_es');
  assert.equal(result.globalTriggerKey, 'api_sell');
  assert.ok(result.payloadVariableKeys.includes('BTCUSD_es'));
  assert.equal(result.payloadVariableCount, result.payloadVariableKeys.length);
});

test('Grid entry uses the existing futures signal bridge and stamps GRID engine metadata', async () => {
  const { bridge, getPairs } = makeBridge();
  const result = await withoutThreeSecondReset(() => bridge.emitEntry({
    symbol: 'ETHUSD',
    side: 'BUY',
    qty: 1,
    entryPrice: 2550,
    sl: 2470,
    tp1: 2560,
    tp: 2560,
    executionId: 'TTG-ETHUSD-6-test',
    strategy: 'GRID'
  }));
  assert.equal(result.ok, true);
  assert.equal(getPairs().find(pair => pair[0] === 'tt_engine')?.[1], 'GRID');
  assert.equal(getPairs().find(pair => pair[0] === 'ETHUSD_q')?.[1], 1);
  assert.equal(getPairs().at(-1)?.[0], 'api_buy');
  assert.equal(getPairs().at(-1)?.[1], 1);
});

test('long and short exits map to the existing symbol-specific exit flags', async () => {
  const { bridge, getPairs } = makeBridge();
  const long = await withoutThreeSecondReset(() => bridge.emitExit({
    symbol: 'BTCUSD', side: 'BUY', reason: 'STOP_LOSS', executionId: 'TEST-LONG'
  }));
  assert.equal(long.triggerKey, 'BTCUSD_xl');
  assert.equal(getPairs().find(pair => pair[0] === 'BTCUSD_xl')?.[1], 1);
  assert.equal(getPairs().find(pair => pair[0] === 'BTCUSD_xs')?.[1], 0);

  const short = await withoutThreeSecondReset(() => bridge.emitExit({
    symbol: 'ETHUSD', side: 'SELL', reason: 'TAKE_PROFIT', executionId: 'TEST-SHORT'
  }));
  assert.equal(short.triggerKey, 'ETHUSD_xs');
  assert.equal(getPairs().find(pair => pair[0] === 'ETHUSD_xs')?.[1], 1);
  assert.equal(getPairs().find(pair => pair[0] === 'ETHUSD_xl')?.[1], 0);
});

test('fixed basket allowlist rejects symbols not actually configured', () => {
  const { bridge } = makeBridge(['BTCUSD']);
  assert.equal(bridge.supportsFuturesSymbol('BTCUSD'), true);
  assert.equal(bridge.supportsFuturesSymbol('UNLISTEDUSD'), false);
});

test('only fresh unconfirmed Tradetron signals reserve symbols', () => {
  const now = Date.now();
  const recent = ageMs => new Date(now - ageMs).toISOString();
  const positions = [{ symbol: 'BTCUSD', qty: 1, strategy: 'MOMENTUM', origin: 'TRADETRON' }];
  const rows = withSignalReservations(positions, [
    { symbol: 'BTCUSD', side: 'buy', size: 1, strategy: 'SCALPING', state: 'SIGNAL_SENT', updated_at: recent(60_000) },
    { symbol: 'ETHUSD', side: 'buy', size: 2, strategy: 'MOMENTUM', state: 'SIGNAL_SENT', execution_id: 'TT-ETH-1', updated_at: recent(60_000) },
    { symbol: 'SOLUSD', side: 'sell', size: 1, strategy: 'SCALPING', state: 'PENDING', execution_id: 'TT-SOL-1', updated_at: recent(30_000) },
    { symbol: 'ADAUSD', side: 'buy', size: 1, strategy: 'MOMENTUM', state: 'FAILED', execution_id: 'TT-ADA-1', updated_at: recent(30_000) },
    { symbol: 'AVAXUSD', side: 'buy', size: 1, strategy: 'MOMENTUM', state: 'SIGNAL_SENT', execution_id: 'TT-AVAX-OLD', updated_at: recent(16 * 60_000) },
    { symbol: 'LINKUSD', side: 'buy', size: 1, strategy: 'MOMENTUM', state: 'PENDING', execution_id: 'TT-LINK-NO-TIME' },
    { symbol: 'BCHUSD', side: 'buy', size: 1, strategy: 'MOMENTUM', state: 'SIGNAL_SENT', execution_id: 'TT-BCH-FUTURE', updated_at: new Date(now + 60_000).toISOString() }
  ], { now });

  assert.equal(rows.length, 3);
  assert.equal(rows.filter(row => row.origin === 'SIGNAL_RESERVATION').length, 2);
  assert.equal(rows.some(row => row.symbol === 'ADAUSD'), false);
  assert.equal(rows.some(row => row.symbol === 'AVAXUSD'), false);
  assert.equal(rows.some(row => row.symbol === 'LINKUSD'), false);
  assert.equal(rows.some(row => row.symbol === 'BCHUSD'), false);
  assert.equal(rows.find(row => row.symbol === 'ETHUSD')?.origin, 'SIGNAL_RESERVATION');
  assert.equal(rows.find(row => row.symbol === 'SOLUSD')?.side, 'SELL');
});

test('signal reservations expire at the TTL boundary instead of persisting forever', () => {
  const now = Date.now();
  const rows = withSignalReservations([], [
    { symbol: 'BTCUSD', side: 'buy', state: 'SIGNAL_SENT', updated_at: new Date(now - SIGNAL_RESERVATION_TTL_MS + 1).toISOString() },
    { symbol: 'ETHUSD', side: 'buy', state: 'SIGNAL_SENT', updated_at: new Date(now - SIGNAL_RESERVATION_TTL_MS).toISOString() }
  ], { now, ttlMs: SIGNAL_RESERVATION_TTL_MS });
  assert.deepEqual(rows.map(row => row.symbol), ['BTCUSD']);
});

test('disabled bridge fails closed even if a token is present', () => {
  const bridge = new TradetronBridge({ enabled: false, authToken: 'unit-test-token' });
  assert.equal(bridge.isConfigured(), false);
});

test('webhook accepts a correct bearer header and rejects a wrong secret', () => {
  assert.equal(isAuthenticatedWebhookRequest({
    headers: { authorization: 'Bearer secret-for-test' }, url: '/api/tradetron/webhook'
  }, 'secret-for-test'), true);
  assert.equal(isAuthenticatedWebhookRequest({
    headers: { authorization: 'Bearer wrong-secret' }, url: '/api/tradetron/webhook'
  }, 'secret-for-test'), false);
});

test('webhook accepts the dedicated secret header and optional query fallback', () => {
  assert.equal(isAuthenticatedWebhookRequest({
    headers: { 'x-tradetron-webhook-secret': 'secret-for-test' }, url: '/api/tradetron/webhook'
  }, 'secret-for-test'), true);
  assert.equal(isAuthenticatedWebhookRequest({
    headers: {}, url: '/api/tradetron/webhook?secret=secret-for-test'
  }, 'secret-for-test'), true);
  assert.equal(isAuthenticatedWebhookRequest({
    headers: {}, url: '/api/tradetron/webhook'
  }, ''), false);
});
