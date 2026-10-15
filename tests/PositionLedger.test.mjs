import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

process.env.TRADETRON_WEBHOOK_SECRET = 'test-secret-32-bytes-long-here';

const require = createRequire(import.meta.url);
const { PositionLedger } = require('../src/ledger/PositionLedger.cjs');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

class MockDb {
  constructor() {
    this.rows = [];
    this.queries = [];
    this.shouldThrow = null;
  }

  async query(sql, params = []) {
    this.queries.push({ sql: sql.trim(), params });
    if (this.shouldThrow) {
      const err = this.shouldThrow;
      this.shouldThrow = null;
      throw err;
    }

    const s = sql.trim().toLowerCase();

    // Idempotency check on position_ledger
    if (s.includes('from position_ledger') && s.includes('webhook_event_id = $1')) {
      const found = this.rows.filter(r => r.webhook_event_id === params[0]);
      return { rows: found.slice(0, 1), rowCount: found.length ? 1 : 0 };
    }

    // Idempotency check on webhook_events
    if (s.includes('from webhook_events') && s.includes("status = 'processed'")) {
      return { rows: [], rowCount: 0 };
    }

    // INSERT into position_ledger
    if (s.startsWith('insert into position_ledger')) {
      const row = {
        id: this.rows.length + 1,
        tradetron_order_id: params[0],
        webhook_event_id: params[1],
        symbol: params[2],
        side: params[3],
        qty: params[4],
        entry_price: params[5],
        entry_time: params[6],
        status: params[7],
        fees_usd: params[8],
        exit_price: null,
        exit_time: null,
        gross_pnl_usd: null,
        net_pnl_usd: null,
        funding_usd: 0
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // UPDATE position_ledger (exit)
    if (s.startsWith('update position_ledger')) {
      const orderId = params[0];
      const row = this.rows.find(
        r => r.tradetron_order_id === orderId && r.status === 'OPEN'
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'CLOSED';
      row.exit_price = params[1];
      row.exit_time = params[2];
      row.gross_pnl_usd = params[3];
      row.net_pnl_usd = params[4];
      row.fees_usd = (row.fees_usd || 0) + (params[5] || 0);
      row.funding_usd = params[6] ?? 0;
      return { rows: [row], rowCount: 1 };
    }

    // COUNT open positions
    if (s.includes('count(*)') && s.includes("status = 'open'")) {
      const cnt = this.rows.filter(r => r.status === 'OPEN').length;
      return { rows: [{ cnt }], rowCount: 1 };
    }

    // SELECT * from position_ledger WHERE status = 'OPEN'
    if (s.includes('from position_ledger') && s.includes("status = 'open'")) {
      const open = this.rows.filter(r => r.status === 'OPEN');
      return { rows: open, rowCount: open.length };
    }

    // SELECT * by tradetron_order_id
    if (s.includes('from position_ledger') && s.includes('tradetron_order_id = $1')) {
      const found = this.rows.filter(r => r.tradetron_order_id === params[0]);
      return { rows: found.slice(0, 1), rowCount: found.length ? 1 : 0 };
    }

    // Upsert system_meta
    if (s.startsWith('insert into system_meta')) {
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

function makeLedger(db = new MockDb()) {
  return { db, ledger: new PositionLedger(db, { logger: silentLogger }) };
}

function entryEvent(overrides = {}) {
  return {
    id: 'evt-1',
    type: 'ENTRY_FILLED',
    orderId: 'ord-1',
    symbol: 'BTCUSD',
    side: 'LONG',
    qty: 1,
    price: 50000,
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

function exitEvent(overrides = {}) {
  return {
    id: 'evt-2',
    type: 'EXIT_FILLED',
    parentOrderId: 'ord-1',
    symbol: 'BTCUSD',
    price: 51000,
    timestamp: new Date().toISOString(),
    grossPnl: 100,
    netPnl: 95,
    fees: 5,
    funding: 0,
    ...overrides
  };
}

describe('PositionLedger signature verification', () => {
  test('verifySignature returns true for a valid signature', () => {
    const rawBody = '{"test":true}';
    const expected = crypto.createHmac('sha256', 'test-secret-32-bytes-long-here')
      .update(rawBody).digest('hex');
    const { ledger } = makeLedger();
    assert.strictEqual(ledger.verifySignature(rawBody, expected), true);
  });

  test('verifySignature returns false for an invalid signature', () => {
    const rawBody = '{"test":true}';
    const { ledger } = makeLedger();
    assert.strictEqual(ledger.verifySignature(rawBody, '0'.repeat(64)), false);
  });

  test('verifySignature returns false when header is missing', () => {
    const { ledger } = makeLedger();
    const rawBody = '{"test":true}';
    assert.strictEqual(ledger.verifySignature(rawBody, undefined), false);
    assert.strictEqual(ledger.verifySignature(rawBody, null), false);
    assert.strictEqual(ledger.verifySignature(rawBody, ''), false);
  });

  test('verifySignature returns false when body is tampered', () => {
    const rawBody = 'original';
    const validSignature = crypto.createHmac('sha256', 'test-secret-32-bytes-long-here')
      .update(rawBody).digest('hex');
    const { ledger } = makeLedger();
    assert.strictEqual(ledger.verifySignature('tampered', validSignature), false);
  });

  test('verifySignature throws when secret is missing', () => {
    const original = process.env.TRADETRON_WEBHOOK_SECRET;
    try {
      delete process.env.TRADETRON_WEBHOOK_SECRET;
      const { ledger } = makeLedger();
      assert.throws(
        () => ledger.verifySignature('body', 'abc'),
        /TRADETRON_WEBHOOK_SECRET/
      );
    } finally {
      if (original === undefined) delete process.env.TRADETRON_WEBHOOK_SECRET;
      else process.env.TRADETRON_WEBHOOK_SECRET = original;
    }
  });
});

describe('PositionLedger idempotency', () => {
  test('onWebhook ignores duplicate entry events', async () => {
    const { db, ledger } = makeLedger();
    const event = entryEvent();
    await ledger.onWebhook(event);
    assert.strictEqual(db.rows.length, 1);

    const result = await ledger.onWebhook(event);
    assert.strictEqual(db.rows.length, 1);
    assert.deepStrictEqual(result, { success: true, processed: false, duplicate: true });
  });
});

describe('PositionLedger entry and exit flow', () => {
  test('onWebhook creates OPEN position for ENTRY_FILLED', async () => {
    const { db, ledger } = makeLedger();
    await ledger.onWebhook(entryEvent());
    assert.strictEqual(db.rows[0].status, 'OPEN');
    assert.strictEqual(db.rows[0].symbol, 'BTCUSD');
  });

  test('onWebhook closes position for EXIT_FILLED', async () => {
    const { db, ledger } = makeLedger();
    await ledger.onWebhook(entryEvent());
    await ledger.onWebhook(exitEvent());
    assert.strictEqual(db.rows[0].status, 'CLOSED');
    assert.strictEqual(db.rows[0].net_pnl_usd, 95);
  });

  test('handleExit preserves zero P&L (does not turn into null)', async () => {
    const { db, ledger } = makeLedger();
    await ledger.onWebhook(entryEvent());
    await ledger.onWebhook(exitEvent({ netPnl: 0, grossPnl: 0 }));
    assert.strictEqual(db.rows[0].net_pnl_usd, 0);
    assert.notStrictEqual(db.rows[0].net_pnl_usd, null);
    assert.notStrictEqual(db.rows[0].net_pnl_usd, undefined);
  });

  test('handleExit throws for unknown order', async () => {
    const { ledger } = makeLedger();
    await assert.rejects(
      ledger.onWebhook(exitEvent({ parentOrderId: 'nonexistent' })),
      /unknown\/closed order/
    );
  });

  test('onWebhook records PARTIAL fill', async () => {
    const { db, ledger } = makeLedger();
    await ledger.onWebhook(entryEvent({
      id: 'evt-partial',
      type: 'PARTIAL_FILL',
      orderId: 'ord-partial'
    }));
    assert.strictEqual(db.rows[0].status, 'PARTIAL');
  });
});

describe('PositionLedger reconciliation', () => {
  test('reconcileWithSnapshot detects full desync', async () => {
    const { ledger } = makeLedger();
    const result = await ledger.reconcileWithSnapshot([
      { symbol: 'BTCUSD', side: 'LONG' },
      { symbol: 'ETHUSD', side: 'SHORT' }
    ]);
    assert.strictEqual(result.isSynced, false);
    assert.strictEqual(result.onlyInSnapshot.length, 2);
    assert.strictEqual(result.onlyInLedger.length, 0);
  });

  test('reconcileWithSnapshot detects synced state', async () => {
    const { ledger } = makeLedger();
    await ledger.onWebhook(entryEvent());
    const result = await ledger.reconcileWithSnapshot([
      { symbol: 'BTCUSD', side: 'LONG' }
    ]);
    assert.strictEqual(result.isSynced, true);
    assert.strictEqual(result.matched, 1);
  });

  test('reconcileWithSnapshot detects onlyInLedger', async () => {
    const { ledger } = makeLedger();
    await ledger.onWebhook(entryEvent());
    const result = await ledger.reconcileWithSnapshot([]);
    assert.ok(result.onlyInLedger.includes('BTCUSD:LONG'));
    assert.strictEqual(result.onlyInSnapshot.length, 0);
  });

  test('reconcileWithSnapshot rejects non-array input', async () => {
    const { ledger } = makeLedger();
    await assert.rejects(ledger.reconcileWithSnapshot({}), /must be an array/);
  });
});

describe('PositionLedger validation', () => {
  test('onWebhook rejects malformed event (missing id)', async () => {
    const { ledger } = makeLedger();
    await assert.rejects(
      ledger.onWebhook({ type: 'ENTRY_FILLED' }),
      /Invalid webhook event/
    );
  });

  test('handleEntry rejects invalid side', async () => {
    const { ledger } = makeLedger();
    await assert.rejects(
      ledger.onWebhook(entryEvent({ side: 'BUY' })),
      /Invalid side/
    );
  });
});
