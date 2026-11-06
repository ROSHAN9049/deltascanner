import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDeltaWalletTransactions } from '../src/delta-wallet-accounting.js';

test('wallet accounting preserves signed funding and separates commissions from rebates', () => {
  const result = summarizeDeltaWalletTransactions([
    { transaction_type: 'commission', amount: '-0.12', asset_symbol: 'USD' },
    { transaction_type: 'commission', amount: '-0.08', asset_symbol: 'USD' },
    { transaction_type: 'commission_rebate', amount: '0.01', asset_symbol: 'USD' },
    { transaction_type: 'funding', amount: '-0.21', asset_symbol: 'USD' },
    { transaction_type: 'funding', amount: '0.05', asset_symbol: 'BTC' },
    { transaction_type: 'liquidation_fee', amount: '-0.04', asset_symbol: 'USD' }
  ], 6);

  assert.equal(result.complete, true);
  assert.deepEqual(result.totals.commissionPaidByAsset, { USD: 0.2 });
  assert.deepEqual(result.totals.commissionAdjustmentsByAsset, { USD: 0.01 });
  assert.deepEqual(result.totals.fundingNetByAsset, { USD: -0.21, BTC: 0.05 });
  assert.deepEqual(result.totals.liquidationFeesPaidByAsset, { USD: 0.04 });
});

test('wallet accounting never combines separate settlement assets', () => {
  const result = summarizeDeltaWalletTransactions([
    { transaction_type: 'commission', amount: '-0.2', asset_symbol: 'USD' },
    { transaction_type: 'commission', amount: '-0.3', asset_symbol: 'BTC' }
  ], 2);
  assert.equal(result.complete, true);
  assert.deepEqual(result.totals.commissionPaidByAsset, { USD: 0.2, BTC: 0.3 });
});

test('wallet accounting withholds totals when the result page is incomplete or a value is missing', () => {
  assert.deepEqual(
    summarizeDeltaWalletTransactions([
      { transaction_type: 'funding', amount: '-0.2', asset_symbol: 'USD' }
    ], 2),
    {
      complete: false,
      loadedRows: 1,
      expectedRows: 2,
      invalidAmounts: 0,
      totals: null
    }
  );
  assert.equal(
    summarizeDeltaWalletTransactions([
      { transaction_type: 'commission', amount: null, asset_symbol: 'USD' }
    ], 1).complete,
    false
  );
});
