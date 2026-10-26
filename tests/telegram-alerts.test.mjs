import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmedSignalTelegramNotifier } from '../worker/telegram-alerts.mjs';

function signal(overrides = {}) {
  return {
    symbol: 'BTCUSD',
    strategy: 'MOMENTUM',
    side: 'BUY',
    stage: 'CONFIRMED',
    ready: true,
    price: 64000,
    stop_price: 63200,
    tp_price: 66000,
    notional: 250,
    details: { normalizedScore: 84.25 },
    ...overrides
  };
}

function response(body = { ok: true }, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('Telegram notifications are silently disabled without both environment variables', async () => {
  let requestCount = 0;
  let lookupCount = 0;
  const notifier = createConfirmedSignalTelegramNotifier({
    env: { TELEGRAM_BOT_TOKEN: 'token-only' },
    database: { select: async () => { lookupCount += 1; return []; } },
    fetchImpl: async () => { requestCount += 1; return response(); }
  });

  assert.equal(notifier.isConfigured(), false);
  await notifier.observe([signal()]);
  assert.equal(requestCount, 0);
  assert.equal(lookupCount, 0);
});

test('sends the final-ready confirmed normalized signal fields to Telegram', async () => {
  const requests = [];
  const logs = [];
  const notifier = createConfirmedSignalTelegramNotifier({
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '1234' },
    database: { select: async () => [] },
    log: async (...args) => logs.push(args),
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return response();
    }
  });

  await notifier.observe([signal()]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.telegram.org/bottest-token/sendMessage');
  assert.equal(requests[0].body.chat_id, '1234');
  assert.match(requests[0].body.text, /Symbol: BTCUSD/);
  assert.match(requests[0].body.text, /Side: BUY/);
  assert.match(requests[0].body.text, /Normalized Score: 84\.25\/100/);
  assert.match(requests[0].body.text, /Entry: 64000/);
  assert.match(requests[0].body.text, /SL: 63200/);
  assert.match(requests[0].body.text, /TP: 66000/);
  assert.match(requests[0].body.text, /Notional: \$250\.00/);
  assert.match(requests[0].body.text, /Strategy: MOMENTUM/);
  assert.equal(logs.some(([level, message]) => level === 'INFO' && message === 'Telegram confirmed signal alert sent'), true);
});

test('ignores unconfirmed, not-ready, sub-80 normalized, and option rows', async () => {
  let requestCount = 0;
  const notifier = createConfirmedSignalTelegramNotifier({
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '1234' },
    database: { select: async () => [] },
    fetchImpl: async () => { requestCount += 1; return response(); }
  });

  await notifier.observe([
    signal({ stage: 'SETUP' }),
    signal({ symbol: 'ETHUSD', ready: false }),
    signal({ symbol: 'SOLUSD', details: { normalizedScore: 79.99 } }),
    signal({ symbol: 'BTC-26DEC-C-64000', strategy: 'OPTIONS_BUY' })
  ]);
  assert.equal(requestCount, 0);
});

test('deduplicates active confirmed alerts and restores successful sends after restart', async () => {
  let clock = Date.parse('2026-10-26T08:00:00.000Z');
  let requestCount = 0;
  const history = [];
  const database = { select: async () => history };
  const log = async (level, message, data) => {
    if (level === 'INFO' && message === 'Telegram confirmed signal alert sent') {
      history.push({ created_at: new Date(clock).toISOString(), message, data });
    }
  };
  const options = {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '1234' },
    database,
    log,
    now: () => clock,
    fetchImpl: async () => { requestCount += 1; return response(); }
  };
  const first = createConfirmedSignalTelegramNotifier(options);

  await first.observe([signal()]);
  await first.observe([signal()]);
  assert.equal(requestCount, 1);

  const restarted = createConfirmedSignalTelegramNotifier(options);
  await restarted.observe([signal()]);
  assert.equal(requestCount, 1);

  await restarted.observe([signal({ ready: false })]);
  clock += 25 * 60 * 60 * 1000;
  await restarted.observe([signal()]);
  assert.equal(requestCount, 2);
});

test('retries failed Telegram delivery only after the retry cooldown', async () => {
  let clock = Date.parse('2026-10-26T08:00:00.000Z');
  let requestCount = 0;
  const notifier = createConfirmedSignalTelegramNotifier({
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '1234' },
    database: { select: async () => [] },
    now: () => clock,
    fetchImpl: async () => {
      requestCount += 1;
      return requestCount === 1 ? response({ ok: false, description: 'temporary failure' }, 429) : response();
    }
  });

  await notifier.observe([signal()]);
  await notifier.observe([signal()]);
  assert.equal(requestCount, 1);
  clock += 5 * 60 * 1000;
  await notifier.observe([signal()]);
  assert.equal(requestCount, 2);
});
