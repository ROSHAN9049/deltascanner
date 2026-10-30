import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVerifiedDeltaClosedPnl } from '../server/delta-closed-pnl.js';

test('daily closed P&L includes only explicitly verified exchange close rows', () => {
  const result = summarizeVerifiedDeltaClosedPnl([
    { status: 'CLOSED', realized_pnl: '5.25', realized_pnl_verified: true },
    { status: 'CLOSED_EXTERNALLY', realized_pnl: '99', realized_pnl_verified: false }
  ], 2);

  assert.equal(result.complete, false);
  assert.equal(result.pnl, null);
});

test('daily closed P&L sums verified rows when the full snapshot is available', () => {
  const result = summarizeVerifiedDeltaClosedPnl([
    { status: 'CLOSED', realized_pnl: '5.25', realized_pnl_verified: true },
    { status: 'CLOSED_EXTERNALLY', realized_pnl: '-1.5', realized_pnl_verified: true }
  ], 2);

  assert.equal(result.complete, true);
  assert.equal(result.pnl, 3.75);
});

test('daily closed P&L is incomplete when verified values or rows are missing', () => {
  assert.deepEqual(
    summarizeVerifiedDeltaClosedPnl([
      { status: 'CLOSED', realized_pnl: null, realized_pnl_verified: true }
    ], 1),
    { complete: false, pnl: null }
  );
  assert.deepEqual(
    summarizeVerifiedDeltaClosedPnl([
      { status: 'CLOSED', realized_pnl: '2', realized_pnl_verified: true }
    ], 2),
    { complete: false, pnl: null }
  );
});

test('empty complete daily snapshot reports a verified zero', () => {
  assert.deepEqual(
    summarizeVerifiedDeltaClosedPnl([], 0),
    { complete: true, pnl: 0 }
  );
});
