import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaOptionsOrderLedger } from '../worker/execution/delta-options-order-ledger.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const INPUT = {
  groupId: '0dbf8d7e-5a2c-4be1-a9d7-0f4a2d380101',
  legId: 12,
  legRole: 'LONG_PREMIUM',
  intent: 'ENTRY',
  attemptNo: 1,
  productId: 101,
  symbol: 'C-BTC-90000-311026',
  side: 'BUY',
  requestedQty: 3,
  limitPrice: 125.5,
  reduceOnly: false,
  clientOrderId: 'DDO-ABCD12345678-LP-1'
};

function createMemoryDatabase() {
  const rows = new Map();
  const legs = new Map([[
    String(INPUT.legId),
    {
      id: INPUT.legId,
      group_id: INPUT.groupId,
      leg_role: INPUT.legRole,
      product_id: INPUT.productId,
      symbol: INPUT.symbol,
      side: INPUT.side,
      requested_qty: INPUT.requestedQty,
      filled_qty: 0,
      exit_filled_qty: 0,
      order_state: 'RESERVED'
    }
  ]]);
  const fills = new Map();
  let nextId = 1;
  return {
    rows,
    legs,
    fills,
    async select(table, query) {
      if (table === 'dd_options_execution_legs') {
        const idMatch = query.match(/id=eq\.([^&]+)/);
        const groupMatch = query.match(/group_id=eq\.([^&]+)/);
        const leg = idMatch ? legs.get(decodeURIComponent(idMatch[1])) : null;
        return leg && (!groupMatch || leg.group_id === decodeURIComponent(groupMatch[1]))
          ? [{ ...leg }]
          : [];
      }
      assert.equal(table, 'dd_options_execution_orders');
      const clientMatch = query.match(/client_order_id=eq\.([^&]+)/);
      if (clientMatch) {
        const row = rows.get(decodeURIComponent(clientMatch[1]));
        return row ? [{ ...row }] : [];
      }
      const groupMatch = query.match(/group_id=eq\.([^&]+)/);
      if (groupMatch) {
        return [...rows.values()]
          .filter(row => row.group_id === decodeURIComponent(groupMatch[1]))
          .map(row => ({ ...row }));
      }
      throw new Error('Unexpected query: ' + query);
    },
    async updateReturning(table, query, patch) {
      assert.equal(table, 'dd_options_execution_orders');
      const clientMatch = query.match(/client_order_id=eq\.([^&]+)/);
      const exchangeMatch = query.match(/exchange_order_id=eq\.([^&]+)/);
      const stateMatch = query.match(/order_state=eq\.([^&]+)/);
      const clientId = clientMatch ? decodeURIComponent(clientMatch[1]) : null;
      const row = clientId ? rows.get(clientId) : null;
      if (!row ||
          (exchangeMatch && row.exchange_order_id !== decodeURIComponent(exchangeMatch[1])) ||
          (stateMatch && row.order_state !== decodeURIComponent(stateMatch[1]))) return [];
      Object.assign(row, patch);
      return [{ ...row }];
    },
    async rpc(name, args) {
      if (name === 'reserve_dd_options_order_attempt') {
        const leg = [...legs.values()].find(row =>
          row.group_id === args.p_group_id &&
          row.leg_role === args.p_leg_role
        );
        if (!leg) throw new Error('missing leg');
        if (rows.has(args.p_client_order_id)) throw new Error('duplicate client order ID');
        const intent = args.p_intent;
        const side = intent === 'ENTRY'
          ? leg.side
          : leg.side === 'BUY' ? 'SELL' : 'BUY';
        const qty = intent === 'ENTRY'
          ? Number(leg.requested_qty) - Number(leg.filled_qty || 0)
          : Number(leg.filled_qty || 0) - Number(leg.exit_filled_qty || 0);
        if (!(qty > 0)) throw new Error('no unmatched leg quantity');
        const id = nextId++;
        const row = {
          id,
          group_id: args.p_group_id,
          leg_id: leg.id,
          leg_role: leg.leg_role,
          intent,
          attempt_no: args.p_attempt_no,
          product_id: leg.product_id,
          symbol: leg.symbol,
          side,
          requested_qty: qty,
          filled_qty: 0,
          limit_price: args.p_limit_price,
          reduce_only: intent !== 'ENTRY',
          order_state: 'RESERVED',
          exchange_order_id: null,
          client_order_id: args.p_client_order_id,
          acknowledged_filled_qty: null,
          average_fill_price: null,
          commission: null,
          commission_currency: null,
          raw: { reservation: true }
        };
        rows.set(row.client_order_id, row);
        return {
          order_attempt_id: id,
          group_id: row.group_id,
          leg_id: row.leg_id,
          leg_role: row.leg_role,
          intent: row.intent,
          attempt_no: row.attempt_no,
          product_id: row.product_id,
          symbol: row.symbol,
          side: row.side,
          qty: row.requested_qty,
          limit_price: row.limit_price,
          reduce_only: row.reduce_only,
          client_order_id: row.client_order_id,
          order_state: 'RESERVED'
        };
      }
      if (name === 'record_dd_options_order_ack') {
        const row = [...rows.values()].find(value => value.id === args.p_order_attempt_id);
        if (!row) throw new Error('unknown attempt');
        const inputState = String(args.p_order_state || 'UNKNOWN').toUpperCase();
        const mismatch = args.p_ack_filled_qty > row.requested_qty ||
          args.p_ack_filled_qty < Number(row.filled_qty || 0) ||
          ['UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(inputState);
        row.exchange_order_id = args.p_exchange_order_id ?? row.exchange_order_id;
        row.acknowledged_filled_qty = args.p_ack_filled_qty;
        row.order_state = mismatch ? 'RECONCILIATION_REQUIRED' : inputState;
        row.raw = { ...(row.raw || {}), ...(args.p_raw || {}) };
        return { reconciliation_required: mismatch, order_attempt_id: row.id, order_state: row.order_state };
      }
      if (name === 'record_dd_options_execution_fill') {
        const row = [...rows.values()].find(value => value.id === args.p_order_attempt_id);
        if (!row) throw new Error('unknown attempt');
        const existing = fills.get(args.p_exchange_fill_id);
        if (existing) {
          return existing.order_attempt_id === row.id
            ? { duplicate: true, order_attempt_id: row.id }
            : { collision: true, reconciliation_required: true, order_attempt_id: row.id };
        }
        const fill = {
          order_attempt_id: row.id,
          size: Number(args.p_fill_qty),
          price: Number(args.p_fill_price),
          commission: args.p_commission === null ? null : Number(args.p_commission),
          commission_currency: args.p_commission_currency
        };
        fills.set(args.p_exchange_fill_id, fill);
        const related = [...fills.values()].filter(value => value.order_attempt_id === row.id);
        const totalQty = related.reduce((sum, value) => sum + value.size, 0);
        const notional = related.reduce((sum, value) => sum + value.size * value.price, 0);
        const currencies = [...new Set(related.map(value => value.commission_currency).filter(Boolean))];
        const allFeesKnown = related.length > 0 &&
          related.every(value => value.commission !== null && Boolean(value.commission_currency)) &&
          currencies.length === 1;
        const overfill = totalQty > Number(row.requested_qty) || currencies.length > 1;
        row.filled_qty = totalQty;
        row.average_fill_price = totalQty > 0 ? notional / totalQty : null;
        row.commission = allFeesKnown
          ? related.reduce((sum, value) => sum + value.commission, 0)
          : null;
        row.commission_currency = allFeesKnown ? currencies[0] : null;
        if (overfill) row.order_state = 'RECONCILIATION_REQUIRED';
        else if (totalQty >= Number(row.requested_qty)) row.order_state = 'FILLED';
        else if (totalQty > 0 && !['CANCELLED', 'REJECTED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(row.order_state)) {
          row.order_state = 'PARTIALLY_FILLED';
        }
        return {
          duplicate: false,
          order_attempt_id: row.id,
          order_filled_qty: totalQty,
          reconciliation_required: overfill
        };
      }
      throw new Error('Unexpected RPC: ' + name);
    }
  };
}
function makeAck(overrides = {}) {
  return {
    id: 7001,
    client_order_id: INPUT.clientOrderId,
    product_id: INPUT.productId,
    product_symbol: INPUT.symbol,
    side: 'buy',
    size: INPUT.requestedQty,
    state: 'open',
    unfilled_size: INPUT.requestedQty,
    ...overrides
  };
}

test('persists a complete immutable attempt before exchange submission and is idempotent', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  const first = await ledger.persistAttempt(INPUT);
  assert.equal(first.order_state, 'RESERVED');
  assert.equal(first.idempotent, false);
  assert.equal(database.rows.size, 1);

  const repeated = await ledger.persistAttempt(INPUT);
  assert.equal(repeated.idempotent, true);
  assert.equal(database.rows.size, 1);

  await assert.rejects(
    ledger.persistAttempt({ ...INPUT, side: 'SELL' }),
    /different immutable order attempt/
  );
  assert.equal(database.rows.size, 1);
});

test('attempts must match the same persisted leg and reverse side for reduce-only exits', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  await assert.rejects(
    ledger.persistAttempt({ ...INPUT, productId: 999 }),
    /conflicts with its persisted leg/
  );
  database.legs.get(String(INPUT.legId)).filled_qty = 2;
  await assert.rejects(
    ledger.persistAttempt({ ...INPUT, side: 'BUY', intent: 'EXIT', reduceOnly: true }),
    /conflicts with its persisted leg/
  );
  const exit = await ledger.persistAttempt({
    ...INPUT,
    intent: 'EXIT',
    attemptNo: 1,
    side: 'SELL',
    requestedQty: 2,
    reduceOnly: true,
    clientOrderId: 'DDO-ABCD12345678-CL-1'
  });
  assert.equal(exit.order_state, 'RESERVED');
  assert.equal(database.rows.size, 1);
});

test('refuses to submit without an exact persisted attempt and records a matching exchange acknowledgement', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  await assert.rejects(ledger.recordAcknowledgement(INPUT.clientOrderId, makeAck()), /without a persisted order attempt/);

  await ledger.persistAttempt(INPUT);
  const row = await ledger.recordAcknowledgement(INPUT.clientOrderId, makeAck());
  assert.equal(row.order_state, 'OPEN');
  assert.equal(row.exchange_order_id, '7001');
  assert.equal(row.raw.exchange_state, 'open');

  const repeated = await ledger.recordAcknowledgement(INPUT.clientOrderId, makeAck());
  assert.equal(repeated.idempotent, true);
});

test('closed IOC acknowledgement with remaining quantity is terminal cancellation, not a live submission', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  await ledger.persistAttempt(INPUT);
  const row = await ledger.recordAcknowledgement(
    INPUT.clientOrderId,
    makeAck({ state: 'closed', unfilled_size: 1 })
  );
  assert.equal(row.order_state, 'CANCELLED');
  assert.equal(Number(row.acknowledged_filled_qty), 1);
});

test('mismatched exchange acknowledgement locks the attempt for reconciliation', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  await ledger.persistAttempt(INPUT);
  await assert.rejects(
    ledger.recordAcknowledgement(INPUT.clientOrderId, makeAck({ product_id: 999 })),
    /did not match the durable order attempt/
  );
  assert.equal(database.rows.get(INPUT.clientOrderId).order_state, 'RECONCILIATION_REQUIRED');
});

test('ambiguous submit outcome is persisted and cannot be blindly retried', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  await ledger.persistAttempt(INPUT);
  const unknown = await ledger.markSubmissionUnknown(INPUT.clientOrderId, new Error('socket timeout'));
  assert.equal(unknown.order_state, 'RECONCILIATION_REQUIRED');
  assert.equal(unknown.raw.blind_retry_prohibited, true);

  const repeated = await ledger.markSubmissionUnknown(INPUT.clientOrderId, new Error('another timeout'));
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.raw.submission_error, 'socket timeout');
});

test('reconciles multi-page actual fills into exact quantity, VWAP and known commission', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  await ledger.persistAttempt(INPUT);
  await ledger.recordAcknowledgement(INPUT.clientOrderId, makeAck());
  const pages = [];
  const executor = {
    async getOptionFillsPage(args) {
      pages.push(args);
      if (!args.after) {
        return {
          rows: [{
            id: 'fill-1', order_id: '7001', product_id: 101,
            product_symbol: INPUT.symbol, side: 'buy',
            size: '1', price: '100', commission: '0.01',
            settling_asset_symbol: 'USD',
            created_at: String((NOW + 10_000) * 1000)
          }],
          after: 'next-page'
        };
      }
      return {
        rows: [
          {
            id: 'fill-2', order_id: '7001', product_id: 101,
            product_symbol: INPUT.symbol, side: 'buy',
            size: '2', price: '110', commission: '0.02',
            settling_asset_symbol: 'USD',
            created_at: String((NOW + 10_000) * 1000)
          },
          {
            id: 'fill-2', order_id: '7001', product_id: 101,
            product_symbol: INPUT.symbol, side: 'buy',
            size: '2', price: '110', commission: '0.02',
            settling_asset_symbol: 'USD',
            created_at: String((NOW + 10_000) * 1000)
          }
        ],
        after: null
      };
    }
  };
  const row = await ledger.reconcileFills(INPUT.clientOrderId, {
    executor, startTimeUs: NOW * 1000, endTimeUs: (NOW + 60_000) * 1000
  });
  assert.equal(pages.length, 2);
  assert.equal(row.order_state, 'FILLED');
  assert.equal(Number(row.filled_qty), 3);
  assert.ok(Math.abs(Number(row.average_fill_price) - (320 / 3)) < 1e-10);
  assert.equal(Number(row.commission), 0.03);
  assert.equal(row.commission_currency, 'USD');
  assert.deepEqual(row.raw.fill_reconciliation.fill_ids, ['fill-1', 'fill-2']);
  assert.equal(row.raw.fill_reconciliation.page_count, 2);
});

test('overfills and malformed matching fills never become a successful filled attempt', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  await ledger.persistAttempt(INPUT);
  await ledger.recordAcknowledgement(INPUT.clientOrderId, makeAck());
  const overfill = await ledger.reconcileFills(INPUT.clientOrderId, {
    executor: {
      async getOptionFillsPage() {
        return {
          rows: [{
            id: 'fill-over', order_id: '7001', product_id: 101,
            product_symbol: INPUT.symbol, side: 'buy',
            size: '4', price: '100', commission: '0.01',
            settling_asset_symbol: 'USD',
            created_at: String((NOW + 10_000) * 1000)
          }],
          after: null
        };
      }
    },
    startTimeUs: NOW * 1000,
    endTimeUs: (NOW + 60_000) * 1000
  });
  assert.equal(overfill.order_state, 'RECONCILIATION_REQUIRED');

  const nextDatabase = createMemoryDatabase();
  const nextLedger = createDeltaOptionsOrderLedger({ database: nextDatabase, now: () => NOW });
  await nextLedger.persistAttempt(INPUT);
  await nextLedger.recordAcknowledgement(INPUT.clientOrderId, makeAck());
  const malformed = await nextLedger.reconcileFills(INPUT.clientOrderId, {
    executor: {
      async getOptionFillsPage() {
        return {
          rows: [{
            id: 'bad-fill', order_id: '7001', product_id: 999,
            product_symbol: INPUT.symbol, side: 'buy',
            size: '1', price: '100', commission: '0.01',
            settling_asset_symbol: 'USD',
            created_at: String((NOW + 10_000) * 1000)
          }],
          after: null
        };
      }
    },
    startTimeUs: NOW * 1000,
    endTimeUs: (NOW + 60_000) * 1000
  });
  assert.equal(malformed.order_state, 'RECONCILIATION_REQUIRED');
});

test('fill reconciliation preserves unknown commission rather than treating missing fees as zero', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW });
  await ledger.persistAttempt(INPUT);
  await ledger.recordAcknowledgement(INPUT.clientOrderId, makeAck());
  const row = await ledger.reconcileFills(INPUT.clientOrderId, {
    executor: {
      async getOptionFillsPage() {
        return {
          rows: [{
            id: 'fill-no-fee', order_id: '7001', product_id: 101,
            product_symbol: INPUT.symbol, side: 'buy',
            size: '1', price: '100', created_at: String((NOW + 10_000) * 1000)
          }],
          after: null
        };
      }
    },
    startTimeUs: NOW * 1000,
    endTimeUs: (NOW + 60_000) * 1000
  });
  assert.equal(row.order_state, 'PARTIALLY_FILLED');
  assert.equal(row.commission, null);
  assert.equal(row.commission_currency, null);
  assert.equal(row.filled_qty, 1);
});

test('rejects an invalid option order symbol and an unbounded fills scan', async () => {
  const database = createMemoryDatabase();
  const ledger = createDeltaOptionsOrderLedger({ database, now: () => NOW, maxFillPages: 1 });
  await assert.rejects(
    ledger.persistAttempt({ ...INPUT, symbol: 'BTCUSD' }),
    /outside the automated BTC\/ETH contract format/
  );
  await ledger.persistAttempt(INPUT);
  await ledger.recordAcknowledgement(INPUT.clientOrderId, makeAck());

  let page = 0;
  const incomplete = await ledger.reconcileFills(INPUT.clientOrderId, {
    executor: {
      async getOptionFillsPage() {
        page += 1;
        return { rows: [], after: page === 1 ? 'more' : null };
      }
    },
    startTimeUs: NOW * 1000,
    endTimeUs: (NOW + 60_000) * 1000
  });
  assert.equal(incomplete.order_state, 'RECONCILIATION_REQUIRED');
});
