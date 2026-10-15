#!/usr/bin/env node
/**
 * Compare legacy BTC 5m/15m trend labels with the shadow BTC 1h regime.
 *
 * Usage:
 *   node scripts/btc-regime-compare.mjs [path/to/scores.json]
 *
 * The input is a JSON export of dd_signal_cache rows. To evaluate agreement
 * over multiple days, combine snapshots from different days before running
 * this script; dd_signal_cache itself stores only each symbol's latest row.
 * This tool is read-only and never changes the feature flag or worker behavior.
 */
import fs from 'node:fs';
import path from 'node:path';

function detailsOf(row) {
  if (row?.details && typeof row.details === 'object' && !Array.isArray(row.details)) {
    return row.details;
  }
  if (typeof row?.details === 'string') {
    try {
      const parsed = JSON.parse(row.details);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function rowsFrom(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') {
    for (const key of ['rows', 'data', 'scores', 'signals']) {
      if (Array.isArray(input[key])) return input[key];
    }
  }
  throw new Error('Input JSON must be an array or an object containing rows/data/scores/signals');
}

function normalizeTrend(value) {
  const trend = String(value || '').trim().toUpperCase();
  return ['BULL', 'BEAR', 'FLAT'].includes(trend) ? trend : null;
}

function legacyLabel(row, details) {
  const trend5m = normalizeTrend(
    details.btcTrend5m ?? details.btc_trend_5m ?? details.btcTrend ?? row.btc_trend_5m ?? row.btc_trend ?? row.btcTrend
  );
  const trend15m = normalizeTrend(
    details.btcTrend15m ?? details.btc_trend_15m ?? details.btcConfirmTrend ??
    details.btc_confirm_trend ?? row.btc_trend_15m ?? row.btc_confirm_trend ?? row.btcConfirmTrend
  );
  if (!trend5m || !trend15m) return null;
  if (trend5m === 'BULL' && trend15m === 'BULL') return 'BULL';
  if (trend5m === 'BEAR' && trend15m === 'BEAR') return 'BEAR';
  return 'FLAT/MIXED';
}

function shadowLabel(regime) {
  const value = String(regime || '').trim().toUpperCase();
  if (value === 'BULL_LOW_VOL' || value === 'BULL_HIGH_VOL') return 'BULL';
  if (value === 'BEAR_LOW_VOL' || value === 'BEAR_HIGH_VOL') return 'BEAR';
  if (value === 'NEUTRAL' || value === 'CHOPPY') return 'FLAT/MIXED';
  return null;
}

function formatPct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) + '%' : '—';
}

function markdownTable(rows) {
  const header = '| Symbol | Strategy | Legacy | Live-1h | Match? | BTC ATR% |';
  const separator = '|---|---|---|---|---|---:|';
  const body = rows.map(row =>
    '| ' + row.symbol + ' | ' + row.strategy + ' | ' + row.legacy +
    ' | ' + row.regime + ' | ' + (row.match ? 'YES' : 'NO') +
    ' | ' + formatPct(row.atrPct) + ' |'
  );
  return [header, separator, ...body].join('\n');
}

function main() {
  const inputPath = path.resolve(process.argv[2] || 'scores.json');
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (error) {
    console.error('Unable to read/parse JSON input:', String(error?.message || error));
    process.exitCode = 1;
    return;
  }

  let rows;
  try {
    rows = rowsFrom(input);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const entries = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
    .map(row => {
      const details = detailsOf(row);
      const regime = String(details.btcRegime || '').trim().toUpperCase();
      return {
        symbol: String(row.symbol || '—'),
        strategy: String(row.strategy || '—'),
        legacy: legacyLabel(row, details),
        regime,
        shadow: shadowLabel(regime),
        atrPct: details.btcAtrPct,
        computedAt: Date.parse(details.btcRegimeComputedAt || '') || null
      };
    });

  const distribution = new Map();
  for (const entry of entries) {
    if (!entry.regime) continue;
    distribution.set(entry.regime, (distribution.get(entry.regime) || 0) + 1);
  }

  const comparable = entries.filter(entry => entry.legacy !== null && entry.shadow !== null)
    .map(entry => ({ ...entry, match: entry.legacy === entry.shadow }));
  const agreements = comparable.filter(entry => entry.match).length;
  const disagreements = comparable.filter(entry => !entry.match);
  const agreementRate = comparable.length ? (agreements / comparable.length) * 100 : null;
  const computedTimes = entries.map(entry => entry.computedAt).filter(Number.isFinite);
  const observedDays = computedTimes.length >= 2
    ? (Math.max(...computedTimes) - Math.min(...computedTimes)) / 86400000
    : 0;

  console.log('BTC 5m/15m vs live-1h shadow regime comparison');
  console.log('Input:', inputPath);
  console.log('Rows read:', entries.length);
  console.log('Rows with both comparable values:', comparable.length);
  console.log('');
  console.log(markdownTable(comparable.slice(0, 50)));
  console.log('');
  console.log('Agreement:', agreementRate === null ? 'N/A' : agreementRate.toFixed(2) + '%');
  console.log('Agreement count:', agreements + '/' + comparable.length);
  console.log('Disagreements:', disagreements.length);
  console.log('');
  console.log('Disagreement list (top 20):');
  if (!disagreements.length) {
    console.log('None');
  } else {
    console.log(markdownTable(disagreements.slice(0, 20)));
  }
  console.log('');
  console.log('Shadow regime distribution:');
  if (!distribution.size) console.log('No rows with btcRegime found.');
  else {
    for (const [regime, count] of [...distribution.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      console.log('- ' + regime + ': ' + count);
    }
  }
  console.log('');
  console.log('Observed timestamp span:', observedDays.toFixed(2) + ' days');
  console.log('Recommended action:');
  if (agreementRate === null) {
    console.log('Keep shadow mode. No rows had both legacy BTC trends and a comparable live-1h regime; verify that details.btcTrend5m and details.btcTrend15m are present.');
  } else if (agreementRate > 90 && observedDays >= 7) {
    console.log('Agreement exceeds 90% across at least 7 days. Ready for manual review only; do not flip the source automatically.');
  } else if (agreementRate > 90) {
    console.log('Agreement exceeds 90%, but the observed data spans less than 7 days. Continue shadow mode until the 7-day window is met, then request manual approval.');
  } else {
    console.log('Agreement is 90% or lower. Keep shadow mode and review disagreements; do not switch the live source.');
  }
}

main();
