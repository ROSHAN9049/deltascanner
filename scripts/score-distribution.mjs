#!/usr/bin/env node
/**
 * Read-only score-distribution report.
 *
 * Offline:
 *   node scripts/score-distribution.mjs path/to/scores.json
 * Database:
 *   DATABASE_URL=... node scripts/score-distribution.mjs --database
 *
 * Database mode reads only dd_signals from the last seven days. For historical
 * rows that predate normalizedScore persistence, the score is replayed from
 * captured_at/strategy groups. dd_signals is deduplicated history, not a full
 * per-cycle universe snapshot, so this historical replay is an estimate.
 */
import fs from 'node:fs/promises';
import { computeStats } from '../src/indicators/ta.mjs';
import { calculateNormalizedScores } from '../worker/strategy.mjs';

const TARGETS = [
  { key: '0-<40', min: 0, max: 40, targetPct: 60 },
  { key: '40-<70', min: 40, max: 70, targetPct: 30 },
  { key: '70-<85', min: 70, max: 85, targetPct: 8 },
  { key: '85-100', min: 85, max: 100, targetPct: 2 }
];

function usage() {
  console.error('Usage: node scripts/score-distribution.mjs <scores.json> OR --database');
  console.error('Database mode requires DATABASE_URL and queries dd_signals read-only for the last seven days.');
}

function rowsFrom(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return [];
  for (const key of ['scores', 'signals', 'rows', 'data']) {
    if (Array.isArray(input[key])) return input[key];
  }
  return [];
}

function detailsOf(row) {
  let details = row && typeof row === 'object' ? row.details : null;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { details = {}; }
  }
  return details && typeof details === 'object' && !Array.isArray(details) ? details : {};
}

function validScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}

function scoreFrom(row) {
  const candidate = typeof row === 'number' || typeof row === 'string'
    ? row
    : row && typeof row === 'object'
      ? row.score ?? detailsOf(row).score ?? row.signal?.score
      : null;
  return validScore(candidate);
}

function storedNormalizedFrom(row) {
  if (!row || typeof row !== 'object') return null;
  const details = detailsOf(row);
  return validScore(row.normalizedScore ?? row.normalized_score ??
    row.stored_normalized_score ?? details.normalizedScore);
}

function normalizedFeatureRow(row) {
  const details = detailsOf(row);
  return {
    symbol: row?.symbol,
    side: row?.side,
    strategy: row?.strategy,
    rsi: row?.rsi ?? details.rsi,
    trend: row?.trend ?? row?.confirmTrend ?? row?.confirm_trend,
    volumeSpike: row?.volumeSpike ?? row?.volume_spike,
    emaDistanceAtr: row?.emaDistanceAtr ?? row?.ema_distance_atr ?? details.emaDistanceAtr,
    details
  };
}

function normalizedScoresForRows(rows) {
  const result = Array(rows.length).fill(null);
  const groups = new Map();

  for (let index = 0; index < rows.length; index++) {
    result[index] = storedNormalizedFrom(rows[index]);
    const row = rows[index];
    if (!row || typeof row !== 'object' || !row.symbol) continue;
    const strategy = String(row.strategy || '').trim().toUpperCase();
    const timestamp = String(row.captured_at ?? row.capturedAt ?? '');
    if (!strategy) continue;
    const key = timestamp ? timestamp + '|' + strategy : 'strategy-only|' + strategy;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }

  for (const indexes of groups.values()) {
    const universe = indexes.map(index => normalizedFeatureRow(rows[index]));
    const calculated = calculateNormalizedScores(universe);
    for (const index of indexes) {
      if (result[index] !== null) continue;
      const symbol = String(rows[index]?.symbol || '').trim().toUpperCase();
      result[index] = calculated.has(symbol) ? calculated.get(symbol) : null;
    }
  }
  return result;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function scoreDistribution(values) {
  const valid = values.filter(value => Number.isFinite(value));
  if (!valid.length) {
    return {
      count: 0, statistics: null, bands: {},
      atLeast85: { count: 0, actualPct: null },
      greaterThan85: { count: 0, actualPct: null },
      greaterThan80: { count: 0, actualPct: null }
    };
  }

  const stats = computeStats(valid);
  const bands = Object.fromEntries(TARGETS.map(target => {
    const count = valid.filter(value => value >= target.min && (
      target.max === 100 ? value <= target.max : value < target.max
    )).length;
    const actualPct = count / valid.length * 100;
    return [target.key, {
      minInclusive: target.min,
      maxExclusive: target.max === 100 ? null : target.max,
      maxInclusive: target.max === 100 ? target.max : null,
      count,
      actualPct: Number(actualPct.toFixed(2)),
      targetPct: target.targetPct,
      deltaPercentagePoints: Number((actualPct - target.targetPct).toFixed(2))
    }];
  }));

  const pct = predicate => {
    const count = valid.filter(predicate).length;
    return { count, actualPct: Number((count / valid.length * 100).toFixed(2)) };
  };
  return {
    count: valid.length,
    statistics: {
      mean: Number(stats.mean.toFixed(4)),
      median: Number(median(valid).toFixed(4)),
      populationStdDev: Number(stats.stddev.toFixed(4)),
      min: stats.min,
      max: stats.max
    },
    bands,
    atLeast85: pct(value => value >= 85),
    greaterThan85: pct(value => value > 85),
    greaterThan80: pct(value => value > 80)
  };
}

function groupedCounts(rows, property) {
  const counts = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const label = String(row[property] ?? '').trim().toUpperCase();
    if (!label) continue;
    counts[label] = (counts[label] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function perStrategy(rows, originalValues, normalizedValues) {
  const strategies = [...new Set(rows
    .filter(row => row && typeof row === 'object')
    .map(row => String(row.strategy || '').trim().toUpperCase())
    .filter(Boolean))].sort();
  return Object.fromEntries(strategies.map(strategy => {
    const indexes = rows.map((row, index) =>
      String(row?.strategy || '').trim().toUpperCase() === strategy ? index : -1
    ).filter(index => index >= 0);
    const original = scoreDistribution(indexes.map(index => originalValues[index]).filter(value => value !== null));
    const normalized = scoreDistribution(indexes.map(index => normalizedValues[index]).filter(value => value !== null));
    const matchedIndexes = indexes.filter(index =>
      originalValues[index] !== null && normalizedValues[index] !== null
    );
    return [strategy, {
      originalCount: original.count,
      normalizedCount: normalized.count,
      originalAtLeast85Pct: original.atLeast85.actualPct,
      originalGreaterThan80Pct: original.greaterThan80.actualPct,
      normalizedAtLeast85Pct: normalized.atLeast85.actualPct,
      normalizedGreaterThan80Pct: normalized.greaterThan80.actualPct,
      matchedCount: matchedIndexes.length,
      originalAtLeast85PctSamePopulation: scoreDistribution(matchedIndexes.map(index => originalValues[index])).atLeast85.actualPct,
      normalizedAtLeast85PctSamePopulation: scoreDistribution(matchedIndexes.map(index => normalizedValues[index])).atLeast85.actualPct
    }];
  }));
}

function buildReport(rows, { source = 'JSON input', generatedAt = new Date().toISOString(), requestedDays = null } = {}) {
  const originalValues = rows.map(scoreFrom);
  const normalizedValues = normalizedScoresForRows(rows);
  const originalScores = originalValues.filter(value => value !== null);
  const normalizedScores = normalizedValues.filter(value => value !== null);
  const matchedIndexes = rows.map((row, index) => index)
    .filter(index => originalValues[index] !== null && normalizedValues[index] !== null);
  const original = scoreDistribution(originalScores);
  const normalized = scoreDistribution(normalizedScores);
  const originalMatched = scoreDistribution(matchedIndexes.map(index => originalValues[index]));
  const normalizedMatched = scoreDistribution(matchedIndexes.map(index => normalizedValues[index]));
  const times = rows.map(row => Date.parse(row?.captured_at ?? row?.capturedAt ?? ''))
    .filter(Number.isFinite);
  const earliest = times.length ? times.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null;
  const latest = times.length ? times.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null;

  return {
    source,
    generatedAt,
    requestedDays,
    observedRange: {
      earliest: earliest === null ? null : new Date(earliest).toISOString(),
      latest: latest === null ? null : new Date(latest).toISOString(),
      observedHours: earliest !== null && latest !== null
        ? Number(((latest - earliest) / 3600000).toFixed(2))
        : 0
    },
    count: original.count,
    skippedRows: rows.length - original.count,
    scoreScale: '0-100',
    statistics: original.statistics,
    bands: original.bands,
    targetProfile: '60% scores <40; 30% 40-<70; 8% 70-<85; 2% 85-100',
    byStrategy: groupedCounts(rows.filter((row, index) => originalValues[index] !== null), 'strategy'),
    byStage: groupedCounts(rows.filter((row, index) => originalValues[index] !== null), 'stage'),
    original,
    normalized: {
      ...normalized,
      coveragePct: original.count ? Number((normalized.count / original.count * 100).toFixed(2)) : null,
      targetAtLeast85Pct: 2
    },
    samePopulation: {
      count: matchedIndexes.length,
      original: originalMatched,
      normalized: normalizedMatched
    },
    byStrategyDistribution: perStrategy(rows, originalValues, normalizedValues),
    note: source === 'PostgreSQL public.dd_signals'
      ? 'Read-only last-seven-day report. Historical normalized values are replayed per captured_at+strategy from deduplicated dd_signals whenever details.normalizedScore was not stored. This table is not a complete per-scan universe snapshot; the replay is diagnostic, not an exact live reconstruction.'
      : 'Offline descriptive analysis only. Normalized scores are read from normalizedScore/details.normalizedScore when present or replayed from available same-strategy feature rows. Missing features are not inferred.'
  };
}

async function loadDatabaseRows() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured; cannot run the read-only database diagnostic.');
  }
  let pool;
  let closePool;
  try {
    ({ pool, closePool } = await import('../src/ledger/pg-adapter.mjs'));
    const query = [
      'SELECT captured_at, symbol, strategy, stage, side, score, rsi, trend, volume_spike,',
      "       details->>'emaDistanceAtr' AS ema_distance_atr,",
      "       details->>'normalizedScore' AS stored_normalized_score",
      'FROM public.dd_signals',
      "WHERE captured_at >= NOW() - INTERVAL '7 days'",
      "  AND strategy IN ('MOMENTUM', 'SCALPING')",
      'ORDER BY captured_at ASC, strategy ASC, symbol ASC'
    ].join('\n');
    const result = await pool.query(query);
    return result.rows;
  } finally {
    if (typeof closePool === 'function') await closePool();
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--help' || arg === '-h') {
    usage();
    process.exitCode = arg ? 0 : 2;
    return;
  }

  let rows;
  let source = 'JSON input';
  let requestedDays = null;
  if (arg === '--database') {
    rows = await loadDatabaseRows();
    source = 'PostgreSQL public.dd_signals';
    requestedDays = 7;
  } else {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(arg, 'utf8'));
    } catch (error) {
      throw new Error('Cannot read/parse JSON input "' + arg + '": ' + error.message);
    }
    rows = rowsFrom(parsed);
  }
  if (!rows.length) throw new Error('No dd_signals rows or valid JSON input rows were found.');

  const output = buildReport(rows, { source, requestedDays });
  if (!output.count) throw new Error('No finite scores within 0-100');
  console.log(JSON.stringify(output, null, 2));
  if (source === 'PostgreSQL public.dd_signals') {
    console.error('Read ' + rows.length + ' Momentum/Scalping dd_signals rows; no database writes performed.');
  }
}

main().catch(error => {
  const message = String(error?.message || error)
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_CONNECTION_STRING]')
    .slice(0, 400);
  console.error('score-distribution: ' + message);
  process.exitCode = 1;
});
