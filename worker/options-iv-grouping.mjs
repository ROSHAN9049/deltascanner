const DAY_MS = 86_400_000;

const DELTA_BUCKETS = Object.freeze([
  { min: 0.10, max: 0.30, label: '0.10-0.30', includeMax: false },
  { min: 0.30, max: 0.40, label: '0.30-0.40', includeMax: false },
  { min: 0.40, max: 0.60, label: '0.40-0.60', includeMax: false },
  { min: 0.60, max: 0.80, label: '0.60-0.80', includeMax: true }
]);

export function deltaBucketFor(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const delta = Math.abs(parsed);
  const bucket = DELTA_BUCKETS.find(item =>
    delta >= item.min && (item.includeMax ? delta <= item.max : delta < item.max)
  );
  return bucket?.label ?? null;
}

export function dteBucketFor(value) {
  const dte = Number(value);
  if (!Number.isFinite(dte) || dte <= 0 || dte > 90) return null;
  if (dte <= 3) return '0-3';
  if (dte <= 10) return '4-10';
  return '11-90';
}

function dteFromOptionSymbol(symbol, now = Date.now()) {
  const match = String(symbol || '').toUpperCase().match(/^[CP]-[A-Z0-9]+-[0-9]+(?:\.[0-9]+)?-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const day = Number(match[1]), month = Number(match[2]), year = 2000 + Number(match[3]);
  const expiry = Date.UTC(year, month - 1, day, 12);
  const date = new Date(expiry);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const dte = (expiry - now) / DAY_MS;
  return dte > 0 ? dte : null;
}

export function buildIvHistoryGroup(ticker = {}, underlying, now = Date.now()) {
  const symbol = String(ticker.symbol || '').toUpperCase();
  const parsed = symbol.match(/^([CP])-/);
  const asset = String(underlying || ticker.underlying || '').trim().toUpperCase();
  const rawDelta = ticker.greeks?.delta ?? ticker.delta;
  const delta = Number(rawDelta);
  const dte = Number.isFinite(Number(ticker.dte)) && Number(ticker.dte) > 0
    ? Number(ticker.dte)
    : dteFromOptionSymbol(symbol, now);
  if (!asset || !parsed || !Number.isFinite(delta) || Math.abs(delta) < 0.01 || Math.abs(delta) > 1 || !dte) return null;
  const deltaBucket = deltaBucketFor(delta);
  const dteBucket = dteBucketFor(dte);
  if (!deltaBucket || !dteBucket) return null;
  return {
    underlying: asset,
    option_type: parsed[1] === 'C' ? 'CALL' : 'PUT',
    delta_bucket: deltaBucket,
    dte_bucket: dteBucket,
    delta_value: Math.abs(delta),
    dte
  };
}

export function ivHistoryGroupKey(row = {}) {
  const underlying = String(row.underlying || '').trim().toUpperCase();
  const optionType = String(row.option_type || '').trim().toUpperCase();
  const deltaBucket = String(row.delta_bucket || '').trim();
  const dteBucket = String(row.dte_bucket || '').trim();
  if (!underlying || !['CALL', 'PUT'].includes(optionType) || !deltaBucket || !dteBucket) return null;
  return [underlying, optionType, deltaBucket, dteBucket].join('|');
}

export function groupIvHistoryByBucket(rows = []) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = ivHistoryGroupKey(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}
