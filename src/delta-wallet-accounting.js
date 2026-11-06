const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const valueAsNumber = Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : null;
};

function addByAsset(target, asset, amount) {
  const key = String(asset || '').trim().toUpperCase() || 'UNKNOWN';
  target[key] = (target[key] || 0) + amount;
}

/**
 * Summarize the signed exchange wallet ledger without combining assets or
 * pretending an incomplete page is an account-wide total.
 *
 * Commission and liquidation fee debits are displayed as positive costs.
 * Funding and commission rebates retain Delta's signed cashflow convention:
 * positive means credited to the wallet, negative means debited.
 */
export function summarizeDeltaWalletTransactions(rows, expectedCount) {
  const source = Array.isArray(rows) ? rows : [];
  const expected = numberOrNull(expectedCount);
  const complete = expected !== null &&
    Number.isSafeInteger(expected) &&
    expected >= 0 &&
    expected === source.length;

  const commissionPaidByAsset = {};
  const commissionAdjustmentsByAsset = {};
  const fundingNetByAsset = {};
  const liquidationFeesPaidByAsset = {};
  let invalidAmounts = 0;

  for (const row of source) {
    const amount = numberOrNull(row?.amount);
    if (amount === null) {
      invalidAmounts += 1;
      continue;
    }
    const asset = row?.asset_symbol;
    const type = String(row?.transaction_type || '').trim().toLowerCase();
    if (type === 'commission') {
      addByAsset(commissionPaidByAsset, asset, Math.max(0, -amount));
      addByAsset(commissionAdjustmentsByAsset, asset, Math.max(0, amount));
    } else if (type === 'commission_rebate') {
      addByAsset(commissionAdjustmentsByAsset, asset, amount);
    } else if (type === 'funding') {
      addByAsset(fundingNetByAsset, asset, amount);
    } else if (type === 'liquidation_fee') {
      addByAsset(liquidationFeesPaidByAsset, asset, Math.max(0, -amount));
    }
  }

  const totals = complete && invalidAmounts === 0
    ? {
        commissionPaidByAsset,
        commissionAdjustmentsByAsset,
        fundingNetByAsset,
        liquidationFeesPaidByAsset
      }
    : null;

  return {
    complete: complete && invalidAmounts === 0,
    loadedRows: source.length,
    expectedRows: expected,
    invalidAmounts,
    totals
  };
}
