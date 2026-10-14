function digits(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 12 ? n : fallback;
}

/** Return a finite number or null; never turn missing data into zero. */
export function safeNum(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

export function fmtMultiplier(value, precision = 2) {
  const n = safeNum(value);
  return n === null ? '—' : n.toFixed(digits(precision, 2)) + 'x';
}

export function fmtRsi(value, precision = 1) {
  const n = safeNum(value);
  return n === null ? '—' : n.toFixed(digits(precision, 1));
}

/**
 * Format a raw numeric price/amount without assuming any currency.
 * Currency conversion belongs only in an explicitly currency-aware caller.
 */
export function fmtPrice(value, precision = 8) {
  const n = safeNum(value);
  return n === null
    ? '—'
    : n.toLocaleString('en-IN', { maximumFractionDigits: digits(precision, 8) });
}

/**
 * Carry P&L provenance separately from presentation.
 * An amount is considered currency-verified only when the caller explicitly
 * marks it verified and supplies a three-letter currency code.
 */
export function fmtMoney(value, currency = null, source = 'UNKNOWN', verified = false) {
  const amount = safeNum(value);
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const currencyVerified = verified === true && /^[A-Z]{3}$/.test(code);
  return {
    amount,
    value: amount,
    currency: currencyVerified ? code : 'UNIT UNVERIFIED',
    source: typeof source === 'string' && source.trim() ? source.trim() : 'UNKNOWN',
    verified: currencyVerified,
    text: amount === null
      ? 'NO DATA'
      : currencyVerified
        ? code + ' ' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })
        : fmtPrice(amount, 2) + ' (unit unverified)'
  };
}

/** Delta selection evaluates absolute delta while still displaying its signed observation. */
export function assessDeltaRange(value, min, max) {
  const missing = value === null || value === undefined ||
    (typeof value === 'string' && value.trim() === '');
  if (missing) {
    return { status: 'MISSING', value: null, label: 'DELTA: NO DATA — BLOCKED' };
  }

  const delta = safeNum(value);
  if (delta === null) {
    return { status: 'INVALID', value: null, label: 'DELTA: INVALID — BLOCKED' };
  }

  const low = safeNum(min);
  const high = safeNum(max);
  if (low === null || high === null || low < 0 || high < low) {
    return { status: 'UNKNOWN', value: delta, label: 'DELTA RANGE: NOT AVAILABLE' };
  }

  const magnitude = Math.abs(delta);
  const range = low.toFixed(2) + '–' + high.toFixed(2);
  if (magnitude < low || magnitude > high) {
    return {
      status: 'OUTSIDE_RANGE',
      value: delta,
      label: 'DELTA: ' + delta.toFixed(2) + ' — OUTSIDE RANGE (' + range + ')'
    };
  }
  return {
    status: 'IN_RANGE',
    value: delta,
    label: 'DELTA: ' + delta.toFixed(2) + ' — IN RANGE (' + range + ')'
  };
}
