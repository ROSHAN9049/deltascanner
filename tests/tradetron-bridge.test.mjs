import test from 'node:test';
import assert from 'node:assert/strict';
import { TradetronBridge, withSignalReservations } from '../server/tradetron.js';
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

function makeBridge(supportedSymbols = ['BTCUSD', 'ETHUSD']) {
  const bridge = new TradetronBridge({
    enabled: true,
    authToken: 'unit-test-token',
    supportedSymbols
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
  assert.equal(pairs.find(pair => pair[0] === 'BTCUSD_q')?.[1], 3);
  assert.equal(pairs.find(pair => pair[0] === 'BTCUSD_qty')?.[1], 3);
  assert.ok(indexOf('BTCUSD_q') < indexOf('BTCUSD_el'));
  assert.ok(indexOf('BTCUSD_ep') < indexOf('BTCUSD_el'));
  assert.equal(pairs.at(-1)?.[0], 'api_buy');
  assert.equal(pairs.at(-1)?.[1], 1);
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

test('unconfirmed Tradetron entry signals reserve slots until activity sync', () => {
  const positions = [{ symbol: 'BTCUSD', qty: 1, strategy: 'MOMENTUM', origin: 'TRADETRON' }];
  const rows = withSignalReservations(positions, [
    { symbol: 'BTCUSD', side: 'buy', size: 1, strategy: 'SCALPING', state: 'SIGNAL_SENT' },
    { symbol: 'ETHUSD', side: 'buy', size: 2, strategy: 'MOMENTUM', state: 'SIGNAL_SENT', execution_id: 'TT-ETH-1' },
    { symbol: 'SOLUSD', side: 'sell', size: 1, strategy: 'SCALPING', state: 'PENDING', execution_id: 'TT-SOL-1' },
    { symbol: 'ADAUSD', side: 'buy', size: 1, strategy: 'MOMENTUM', state: 'FAILED', execution_id: 'TT-ADA-1' }
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(row => row.origin === 'SIGNAL_RESERVATION').length, 2);
  assert.equal(rows.some(row => row.symbol === 'ADAUSD'), false);
  assert.equal(rows.find(row => row.symbol === 'ETHUSD')?.origin, 'SIGNAL_RESERVATION');
  assert.equal(rows.find(row => row.symbol === 'SOLUSD')?.side, 'SELL');
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
