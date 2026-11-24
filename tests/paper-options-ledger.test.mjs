import test from 'node:test';
import assert from 'node:assert/strict';
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
        { id: 1, symbol: 'C-BTC-90000-311226', qty: 1, entry_price: 100, stop_price: 80, take_profit_price: 130, expiry_at: null },
        { id: 2, symbol: 'P-BTC-80000-311226', qty: 2, entry_price: 50, stop_price: 40, take_profit_price: 70, expiry_at: null }
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
