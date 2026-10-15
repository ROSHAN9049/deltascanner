#!/usr/bin/env node
/**
 * Read-only diagnostic for Delta's BTC hourly candle history.
 *
 * Usage:
 *   node scripts/test-btc-1h.mjs [--symbol=BTCUSD] [--limit=250]
 *
 * This script only calls the public market-data candles endpoint. It does not
 * start the worker, connect to the database, or submit/modify any orders.
 * Exit code stays zero for diagnostic verdicts so the workflow can report API
 * limitations as structured data instead of treating them as CI failures.
 */

function parseArgs(argv) {
  const values = { symbol: 'BTCUSD', limit: '250' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--symbol' || arg === '--limit') {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      values[key] = value;
      i++;
      continue;
    }
    if (arg.startsWith('--symbol=')) {
      values.symbol = arg.slice('--symbol='.length);
      continue;
    }
    if (arg.startsWith('--limit=')) {
      values.limit = arg.slice('--limit='.length);
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  const symbol = String(values.symbol || '').trim().toUpperCase();
  const limit = Number(values.limit);
  if (!/^[A-Z0-9_-]+$/.test(symbol)) throw new Error('Invalid symbol format');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('--limit must be an integer from 1 through 1000');
  }
  return { symbol, limit };
}

function safeError(error) {
  let message = String(error?.message || error || 'Unknown fetch error');
  // Never surface connection strings, credentials, or long token-like values.
  for (const name of ['DATABASE_URL', 'SUPABASE_DB_URL', 'DELTA_TESTNET_API_KEY', 'DELTA_TESTNET_API_SECRET']) {
    const value = process.env[name];
    if (value) message = message.split(value).join('[REDACTED]');
  }
  message = message
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_CONNECTION_STRING]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_HEX]')
    .replace(/(api[-_ ]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  return message.slice(0, 300);
}

function timestampMs(candle) {
  const raw = candle?.time ?? candle?.timestamp ?? candle?.t;
  if (typeof raw === 'string' && !/^\d+(?:\.\d+)?$/.test(raw.trim())) {
    const parsedDate = Date.parse(raw);
    return Number.isFinite(parsedDate) ? parsedDate : null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value : value * 1000;
}

function makeSummary({ symbol, limit, candles = [], error = null }) {
  const candleCount = candles.length;
  const timestamps = candles
    .map(timestampMs)
    .filter(value => value !== null)
    .sort((a, b) => a - b);

  const first = timestamps.length ? timestamps[0] : null;
  const last = timestamps.length ? timestamps[timestamps.length - 1] : null;
  const durationHours = first !== null && last !== null
    ? Number(((last - first) / 3600000).toFixed(2))
    : 0;
  const gapsMinutes = timestamps.slice(1)
    .map((timestamp, index) => (timestamp - timestamps[index]) / 60000)
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const middleGap = Math.floor(gapsMinutes.length / 2);
  const medianSpacingMinutes = gapsMinutes.length
    ? Number((gapsMinutes.length % 2
      ? gapsMinutes[middleGap]
      : (gapsMinutes[middleGap - 1] + gapsMinutes[middleGap]) / 2).toFixed(2))
    : null;

  // For N candles, hourly candle starts should span approximately N - 1 hours.
  // Both the span and the median adjacent-candle spacing must indicate 1h data.
  const expectedDurationHours = Math.max(0, candleCount - 1);
  const toleranceHours = Math.max(0.25, expectedDurationHours * 0.02);
  const durationMatch = timestamps.length >= 2 &&
    medianSpacingMinutes !== null &&
    Math.abs(medianSpacingMinutes - 60) <= 5 &&
    Math.abs(durationHours - expectedDurationHours) <= toleranceHours;

  let verdict;
  if (error) verdict = 'FETCH_FAILED';
  else if (candleCount < 200) verdict = 'INSUFFICIENT';
  else if (durationMatch) verdict = 'PASS';
  else verdict = 'WRONG_RESOLUTION';

  const summary = {
    symbol,
    requestedResolution: '1h',
    requestedLimit: limit,
    candleCount,
    firstTimestamp: first === null ? null : new Date(first).toISOString(),
    lastTimestamp: last === null ? null : new Date(last).toISOString(),
    durationHours,
    expectedDurationHours,
    medianSpacingMinutes,
    durationMatch,
    verdict
  };
  if (error) summary.error = safeError(error);
  return summary;
}

async function main() {
  let symbol = 'BTCUSD';
  let limit = 250;
  let parseError = null;

  try {
    ({ symbol, limit } = parseArgs(process.argv.slice(2)));
  } catch (error) {
    parseError = error;
  }

  if (parseError) {
    console.log(JSON.stringify(makeSummary({
      symbol, limit, error: parseError
    }), null, 2));
    return;
  }

  try {
    // Dynamic import lets a missing adapter/module be reported as FETCH_FAILED
    // with a clear message instead of crashing before the diagnostic can print.
    const { DeltaAdapter } = await import('../worker/delta-adapter.mjs');
    if (typeof DeltaAdapter !== 'function') {
      throw new Error('DeltaAdapter export is unavailable from worker/delta-adapter.mjs');
    }

    const adapter = new DeltaAdapter();
    const response = await adapter.candles(symbol, '1h', limit);
    if (!Array.isArray(response)) {
      throw new Error('DeltaAdapter.candles returned a non-array response');
    }

    console.log(JSON.stringify(makeSummary({ symbol, limit, candles: response }), null, 2));
  } catch (error) {
    console.log(JSON.stringify(makeSummary({ symbol, limit, error }), null, 2));
  }
}

await main();
