const clean = value => String(value ?? '').trim();

function numericValue(value) {
  if (value === null || value === undefined || clean(value) === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function formatAmount(value, currencyCode) {
  const negative = value < 0;
  const amount = Math.abs(value);
  if (currencyCode === 'USD') {
    return (negative ? '-$' : '$') + amount.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  const formatted = amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return (negative ? '-' : '') + (currencyCode ? currencyCode + ' ' : '') + formatted;
}

/**
 * Describes the latest nonzero raw deployment-level P&L observation.
 * This is display context only; it does not infer realized trade P&L.
 */
export function formatLastNonZeroPnlContext(history = [], { timeZone = 'Asia/Kolkata' } = {}) {
  const selected = (Array.isArray(history) ? history : [])
    .map(row => ({ row, value: numericValue(row?.reported_pnl), timestamp: Date.parse(row?.captured_at || '') }))
    .filter(item => item.value !== null && item.value !== 0 && Number.isFinite(item.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  if (!selected) return null;

  const date = new Date(selected.timestamp);
  const formattedDate = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    timeZone
  }).format(date);
  const formattedTime = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone
  }).format(date).toLowerCase();
  const currencyCode = clean(selected.row?.currency_code).toUpperCase();

  return 'Last non-zero: ' + formatAmount(selected.value, currencyCode) +
    ' (' + formattedDate + ' ' + formattedTime + ')';
}
