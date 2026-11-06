import { indiaDateKey } from './date-utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfIndiaDay(timestamp) {
  const key = indiaDateKey(new Date(timestamp));
  return Date.parse(key + 'T00:00:00+05:30');
}

/**
 * Filters canonical Delta position lifecycle rows to the selected Analytics window.
 * Custom "to" dates are inclusive in India local time.
 */
export function filterDeltaTradesByPeriod(rows, period = 'ALL', fromDate = '', toDate = '', now = Date.now()) {
  const source = Array.isArray(rows) ? rows : [];
  const selected = String(period || 'ALL').toUpperCase();
  if (selected === 'ALL') return source;

  let startMs = null;
  let endMs = null;
  if (selected === 'TODAY') {
    startMs = startOfIndiaDay(now);
  } else if (selected === '7D') {
    startMs = now - 7 * DAY_MS;
  } else if (selected === '30D') {
    startMs = now - 30 * DAY_MS;
  } else if (selected === 'CUSTOM') {
    if (fromDate) {
      const parsed = Date.parse(String(fromDate) + 'T00:00:00+05:30');
      if (Number.isFinite(parsed)) startMs = parsed;
    }
    if (toDate) {
      const parsed = Date.parse(String(toDate) + 'T00:00:00+05:30');
      if (Number.isFinite(parsed)) endMs = parsed + DAY_MS;
    }
  } else {
    return source;
  }

  return source.filter(row => {
    const closedAt = Date.parse(row?.closed_at || '');
    if (!Number.isFinite(closedAt)) return false;
    if (startMs !== null && closedAt < startMs) return false;
    if (endMs !== null && closedAt >= endMs) return false;
    return true;
  });
}
