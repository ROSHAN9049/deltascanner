import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLastNonZeroPnlContext } from '../src/tradetron-pnl-context.js';

test('shows the most recent nonzero raw P&L with India date and time', () => {
  const result = formatLastNonZeroPnlContext([
    { reported_pnl: -1273.94, currency_code: 'USD', captured_at: '2026-10-17T02:35:00.000Z' },
    { reported_pnl: -1280.42, currency_code: 'USD', captured_at: '2026-10-17T02:40:00.000Z' },
    { reported_pnl: 0, currency_code: 'USD', captured_at: '2026-10-17T02:45:00.000Z' }
  ]);
  assert.equal(result, 'Last non-zero: -$1,280 (17/10 8:10 am)');
});

test('ignores missing, zero, and invalid P&L rows', () => {
  assert.equal(formatLastNonZeroPnlContext([
    { reported_pnl: 0, currency_code: 'USD', captured_at: '2026-10-17T02:45:00Z' },
    { reported_pnl: null, currency_code: 'USD', captured_at: '2026-10-17T02:40:00Z' },
    { reported_pnl: -10, currency_code: 'USD', captured_at: 'invalid' }
  ]), null);
});

test('keeps non-USD API currency explicit and does not apply conversion', () => {
  assert.equal(
    formatLastNonZeroPnlContext([{ reported_pnl: -12.5, currency_code: 'INR', captured_at: '2026-10-17T02:40:00Z' }]),
    'Last non-zero: -INR 12.5 (17/10 8:10 am)'
  );
});
