const numberOrNull = value => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function walletRows(wallet) {
  const payload = wallet?.result ?? wallet;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.balances)) return payload.balances;
  return [];
}

function usdWallet(wallet) {
  return walletRows(wallet).filter(row =>
    String(row?.asset_symbol || row?.currency || row?.symbol || '').trim().toUpperCase() === 'USD'
  );
}

export function accountEquity(wallet) {
  const metaEquity = numberOrNull(wallet?.meta?.net_equity ?? wallet?.meta?.equity);
  if (metaEquity !== null && metaEquity > 0) return metaEquity;
  const rows = usdWallet(wallet);
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => {
    const balance = numberOrNull(row?.balance ?? row?.total_balance ?? row?.wallet_balance);
    const unrealized = numberOrNull(row?.unrealized_pnl) ?? 0;
    return sum + (balance ?? 0) + unrealized;
  }, 0);
  return total > 0 ? total : null;
}

// Delta's wallet/balances payload exposes the USD settlement wallet's
// available_balance as the amount available for trading. Do not add balances
// from Spot/other assets, and never substitute total equity for free margin.
export function accountAvailable(wallet) {
  const rows = usdWallet(wallet);
  if (!rows.length) return null;
  const values = rows.map(row => numberOrNull(row?.available_balance))
    .filter(value => value !== null && value >= 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function accountAvailableVerified(wallet) {
  return accountAvailable(wallet);
}
