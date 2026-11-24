import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { recordPaperOptionEntry, refreshPaperOptionTrades } from '../worker/paper-options-ledger.mjs';

test('records one durable simulated LTP fill for a confirmed long option without an exchange order', async () => {
  const inserted = [];
  const database = {
    async select() { return []; },
    async insert(table, row) { inserted.push({ table, row }); }
  };
  const result = await recordPaperOptionEntry({
    database,
    ticker: {
      symbol: 'C-BTC-90000-311226', underlying: 'BTC',
      close: 125.5, strike_price: 90000, expiry_ms: Date.UTC(2026, 11, 31)
    },
    signal: { symbol: 'C-BTC-90000-311226', stage: 'CONFIRMED', ready: true, sl: 90, tp: 180 },
    strategy: 'OPTIONS_BUY',
    now: () => Date.UTC(2026, 10, 24, 12),
    dateKey: '2026-11-24'
  });
  assert.equal(result.recorded, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].table, 'dd_paper_trades');
  assert.equal(inserted[0].row.entry_price, 125.5);
  assert.equal(inserted[0].row.qty, 1);
  assert.equal(inserted[0].row.fill_type, 'SIMULATED_FILL');
  assert.equal(inserted[0].row.raw.paper_only, true);
  assert.equal(inserted[0].row.raw.contract_value, null);
});

test('does not paper-fill non-confirmed, unready, or short option signals', async () => {
  let inserts = 0;
  const database = { async select() { return []; }, async insert() { inserts += 1; } };
  for (const signal of [
    { stage: 'SETUP', ready: true },
    { stage: 'CONFIRMED', ready: false }
  ]) {
    const result = await recordPaperOptionEntry({
      database, ticker: { symbol: 'C-BTC-90000-311226', close: 100 },
      signal, strategy: 'OPTIONS_BUY'
    });
    assert.equal(result.recorded, false);
  }
  const short = await recordPaperOptionEntry({
    database, ticker: { symbol: 'C-BTC-90000-311226', close: 100 },
    signal: { stage: 'CONFIRMED', ready: true }, strategy: 'OPTIONS_SELL'
  });
  assert.equal(short.recorded, false);
  assert.equal(inserts, 0);
});

test('duplicate daily paper entries are idempotent', async () => {
  const database = {
    async select() { return []; },
    async insert() { throw Object.assign(new Error('duplicate key violates unique constraint'), { code: '23505' }); }
  };
  const result = await recordPaperOptionEntry({
    database, ticker: { symbol: 'P-BTC-80000-311226', close: 75 },
    signal: { stage: 'CONFIRMED', ready: true },
    strategy: 'OPTIONS_BUY', dateKey: '2026-11-24'
  });
  assert.equal(result.recorded, false);
  assert.equal(result.duplicate, true);
});

test('paper trade monitor updates premium points and closes only on SL/TP/expiry', async () => {
  const updates = [];
  const database = {
    async select() {
      return [
        { id: 1, symbol: 'C-BTC-90000-311226', strategy: 'OPTIONS_BUY', option_type: 'CALL', strike: 90000, qty: 1, entry_price: 100, stop_price: 80, take_profit_price: 130, expiry_at: null },
        { id: 2, symbol: 'P-BTC-80000-311226', strategy: 'OPTIONS_BUY', option_type: 'PUT', strike: 80000, qty: 2, entry_price: 50, stop_price: 40, take_profit_price: 70, expiry_at: null }
      ];
    },
    async update(table, query, patch) { updates.push({ table, query, patch }); }
  };
  const result = await refreshPaperOptionTrades({
    database,
    tickers: new Map([
      ['C-BTC-90000-311226', { close: 135 }],
      ['P-BTC-80000-311226', { close: 55 }]
    ]),
    now: () => Date.UTC(2026, 10, 24, 12)
  });
  assert.equal(result.updated, 2);
  assert.equal(result.closed, 1);
  assert.equal(updates[0].patch.status, 'CLOSED');
  assert.equal(updates[0].patch.exit_reason, 'TAKE_PROFIT');
  assert.equal(updates[0].patch.realized_pnl, 35);
  assert.equal(updates[1].patch.status, undefined);
  assert.equal(updates[1].patch.unrealized_pnl, 10);
});

test('records a defined-risk paper spread using short bid and hedge ask fills', async () => {
  const inserted = [];
  const database = {
    async select() { return []; },
    async insert(table, row) { inserted.push({ table, row }); }
  };
  const expiry = Date.UTC(2026, 11, 31);
  const result = await recordPaperOptionEntry({
    database,
    ticker: {
      symbol: 'C-BTC-90000-311226', underlying: 'BTC', option_type: 'CALL',
      strike_price: 90000, expiry_ms: expiry, bid: 100, ask: 110
    },
    hedgeTicker: {
      symbol: 'C-BTC-95000-311226', option_type: 'CALL',
      strike_price: 95000, expiry_ms: expiry, bid: 40, ask: 45
    },
    signal: {
      symbol: 'C-BTC-90000-311226', stage: 'CONFIRMED', ready: true,
      optionType: 'CALL', strike: 90000, hedgeSymbol: 'C-BTC-95000-311226',
      hedgeStrike: 95000, credit: 55, maxRiskPerSpread: 4945
    },
    strategy: 'OPTIONS_SELL', dateKey: '2026-11-24',
    now: () => Date.UTC(2026, 10, 24, 12)
  });
  assert.equal(result.recorded, true);
  assert.equal(inserted[0].row.side, 'SELL');
  assert.equal(inserted[0].row.entry_price, 55);
  assert.equal(inserted[0].row.current_price, 70);
  assert.equal(inserted[0].row.hedge_symbol, 'C-BTC-95000-311226');
  assert.equal(inserted[0].row.hedge_entry_price, 45);
  assert.equal(inserted[0].row.spread_width, 5000);
});

test('marks paper spreads to market and settles their defined-risk intrinsic value at expiry', async () => {
  const updates = [];
  const expiry = Date.UTC(2026, 10, 24, 12);
  const database = {
    async select() {
      return [{
        id: 9, symbol: 'C-BTC-90000-311026', strategy: 'OPTIONS_SELL',
        side: 'SELL', option_type: 'CALL', strike: 90000,
        hedge_symbol: 'C-BTC-95000-311026', qty: 1, entry_price: 55,
        expiry_at: new Date(expiry).toISOString()
      }];
    },
    async update(table, query, patch) { updates.push({ table, query, patch }); }
  };
  const tickers = new Map([
    ['C-BTC-90000-311026', { ask: 100, underlying_price: 96000 }],
    ['C-BTC-95000-311026', { bid: 50, strike_price: 95000 }]
  ]);
  const result = await refreshPaperOptionTrades({
    database, tickers, now: () => expiry + 1
  });
  assert.equal(result.updated, 1);
  assert.equal(result.closed, 1);
  assert.equal(updates[0].patch.status, 'CLOSED');
  assert.equal(updates[0].patch.exit_reason, 'EXPIRY');
  assert.equal(updates[0].patch.exit_price, 5000);
  assert.equal(updates[0].patch.realized_pnl, -4945);
});

test('PAPER_ONLY option candidates are visibly marked and cannot invoke Testnet preview', async () => {
  const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /const paperOnly = d\.paperOnly === true/);
  assert.match(main, /disabled=\{actionDisabled \|\| paperOnly/);
  assert.match(main, /PAPER_ONLY · NO ORDER/);
});
