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
import { calculateNormalizedScores } from '../worker/strategy.mjs';

const TARGETS = [
  { key: '0-<40', min: 0, max: 40, targetPct: 60 },
  { key: '40-<70', min: 40, max: 70, targetPct: 30 },
  { key: '70-<85', min: 70, max: 85, targetPct: 8 },
  { key: '85-100', min: 85, max: 100, targetPct: 2 }
];

function usage() {
  console.error('Usage: node scripts/score-distribution.mjs [--days=7] [--compare] [--database | <scores.json>]');
  console.error('When no JSON path is supplied, database mode requires DATABASE_URL and performs read-only analysis.');
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

function featureFailureReasons(row) {
  const details = detailsOf(row);
  const reasons = [];
  const side = String(row?.side || '').trim().toUpperCase();
  if (details.candlesFresh === false || String(details.candlesFresh).toLowerCase() === 'false') {
    reasons.push('insufficient_candle_history');
  }
  if (side !== 'BUY' && side !== 'SELL') reasons.push('missing_directional_side');
  const rsi = row?.rsi ?? details.rsi;
  if (validScore(rsi) === null) reasons.push('missing_or_invalid_rsi');
  const volume = row?.volumeSpike ?? row?.volume_spike;
  if (volume === null || volume === undefined || volume === '' || !Number.isFinite(Number(volume)) || Number(volume) < 0) {
    reasons.push('missing_or_invalid_volume_spike');
  }
  const ema = row?.emaDistanceAtr ?? row?.ema_distance_atr ?? details.emaDistanceAtr;
  if (ema === null || ema === undefined || ema === '' || !Number.isFinite(Number(ema)) || Number(ema) < 0) {
    reasons.push('missing_or_invalid_ema_distance');
  }
  return reasons;
}

function normalizationForRows(rows) {
  const storedValues = rows.map(storedNormalizedFrom);
  const values = [...storedValues];
  const reasonsByIndex = new Map();
  const groups = new Map();

  for (let index = 0; index < rows.length; index++) {
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
      if (values[index] !== null) continue;
      const symbol = String(rows[index]?.symbol || '').trim().toUpperCase();
      if (calculated.has(symbol)) {
        values[index] = calculated.get(symbol);
        continue;
      }
      const reasons = featureFailureReasons(rows[index]);
      if (!reasons.includes('missing_directional_side') &&
          !reasons.includes('missing_or_invalid_rsi') &&
          !reasons.includes('missing_or_invalid_volume_spike') &&
          !reasons.includes('missing_or_invalid_ema_distance')) {
        reasons.push('insufficient_same_strategy_cycle_universe');
      }
      reasonsByIndex.set(index, reasons.length ? reasons : ['unscorable_normalization_inputs']);
    }
  }

  // Rows missing a symbol/strategy cannot enter a batch. Keep them visible in diagnostics.
  for (let index = 0; index < rows.length; index++) {
    if (values[index] !== null || reasonsByIndex.has(index)) continue;
    if (!rows[index] || typeof rows[index] !== 'object' || !rows[index].symbol || !rows[index].strategy) {
      reasonsByIndex.set(index, ['missing_symbol_or_strategy']);
    } else {
      reasonsByIndex.set(index, ['insufficient_same_strategy_cycle_universe']);
    }
  }
  return { values, storedValues, reasonsByIndex };
}

function missingNormalizationSummary(rows, result) {
  const reasonCounts = {};
  const stageCounts = {};
  const strategyCounts = {};
  const symbols = new Map();
  let missingCount = 0;

  for (let index = 0; index < rows.length; index++) {
    if (result.values[index] !== null) continue;
    missingCount += 1;
    const row = rows[index] || {};
    const stage = String(row.stage || '[NO STAGE]').trim().toUpperCase();
    const strategy = String(row.strategy || '[NO STRATEGY]').trim().toUpperCase();
    stageCounts[stage] = (stageCounts[stage] || 0) + 1;
    strategyCounts[strategy] = (strategyCounts[strategy] || 0) + 1;
    const reasons = result.reasonsByIndex.get(index) || ['unscorable_normalization_inputs'];
    for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    const symbol = String(row.symbol || '[NO SYMBOL]').trim().toUpperCase();
    if (!symbols.has(symbol)) symbols.set(symbol, { symbol, missingRows: 0, reasons: {}, stages: {} });
    const item = symbols.get(symbol);
    item.missingRows += 1;
    item.stages[stage] = (item.stages[stage] || 0) + 1;
    for (const reason of reasons) item.reasons[reason] = (item.reasons[reason] || 0) + 1;
  }

  const sortObject = object => Object.fromEntries(Object.entries(object).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const sortedSymbols = [...symbols.values()].sort((a, b) => b.missingRows - a.missingRows || a.symbol.localeCompare(b.symbol));
  return {
    count: missingCount,
    byReason: sortObject(reasonCounts),
    byStage: sortObject(stageCounts),
    byStrategy: sortObject(strategyCounts),
    symbols: sortedSymbols.slice(0, 50).map(item => ({
      ...item,
      reasons: sortObject(item.reasons),
      stages: sortObject(item.stages)
    }))
  };
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

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of valid) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const mean = sum / valid.length;
  let squaredDeviation = 0;
  for (const value of valid) squaredDeviation += (value - mean) ** 2;
  const populationStdDev = Math.sqrt(squaredDeviation / valid.length);

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
      mean: Number(mean.toFixed(4)),
      median: Number(median(valid).toFixed(4)),
      populationStdDev: Number(populationStdDev.toFixed(4)),
      min,
      max
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

function compareIndexes(rows, indexes, originalValues, normalizedValues) {
  const usable = indexes.filter(index => originalValues[index] !== null);
  const matched = usable.filter(index => normalizedValues[index] !== null);
  const original = scoreDistribution(usable.map(index => originalValues[index]));
  const normalized = scoreDistribution(usable.map(index => normalizedValues[index]).filter(value => value !== null));
  const samePopulationOriginal = scoreDistribution(matched.map(index => originalValues[index]));
  const samePopulationNormalized = scoreDistribution(matched.map(index => normalizedValues[index]));
  return {
    rowCount: indexes.length,
    original,
    normalized,
    samePopulation: {
      count: matched.length,
      original: samePopulationOriginal,
      normalized: samePopulationNormalized
    }
  };
}

function buildReport(rows, {
  source = 'JSON input',
  generatedAt = new Date().toISOString(),
  requestedDays = 7,
  compareRequested = false
} = {}) {
  const originalValues = rows.map(scoreFrom);
  const normalization = normalizationForRows(rows);
  const normalizedValues = normalization.values;
  const originalScores = originalValues.filter(value => value !== null);
  const normalizedScoreValues = normalizedValues.filter(value => value !== null);
  const matchedIndexes = rows.map((row, index) => index)
    .filter(index => originalValues[index] !== null && normalizedValues[index] !== null);
  const original = scoreDistribution(originalScores);
  const normalized = scoreDistribution(normalizedScoreValues);
  const originalMatched = scoreDistribution(matchedIndexes.map(index => originalValues[index]));
  const normalizedMatched = scoreDistribution(matchedIndexes.map(index => normalizedValues[index]));
  const confirmedIndexes = rows.map((row, index) =>
    String(row?.stage || '').trim().toUpperCase() === 'CONFIRMED' && originalValues[index] !== null ? index : -1
  ).filter(index => index >= 0);
  const allIndexes = rows.map((row, index) => originalValues[index] !== null ? index : -1)
    .filter(index => index >= 0);
  const allComparison = compareIndexes(rows, allIndexes, originalValues, normalizedValues);
  const confirmedComparison = compareIndexes(rows, confirmedIndexes, originalValues, normalizedValues);
  const times = rows.map(row => Date.parse(row?.captured_at ?? row?.capturedAt ?? ''))
    .filter(Number.isFinite);
  const earliest = times.length ? times.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null;
  const latest = times.length ? times.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null;
  const storedCount = normalization.storedValues.filter(value => value !== null).length;
  const replayedCount = normalizedScoreValues.length - storedCount;
  const coveragePct = rows.length ? Number((normalizedScoreValues.length / rows.length * 100).toFixed(2)) : null;
  const storedCoveragePct = rows.length ? Number((storedCount / rows.length * 100).toFixed(2)) : null;
  const missingNormalization = missingNormalizationSummary(rows, normalization);

  return {
    source,
    generatedAt,
    requestedDays,
    compareRequested,
    observedRange: {
      earliest: earliest === null ? null : new Date(earliest).toISOString(),
      latest: latest === null ? null : new Date(latest).toISOString(),
      observedHours: earliest !== null && latest !== null
        ? Number(((latest - earliest) / 3600000).toFixed(2))
        : 0,
      observedDays: earliest !== null && latest !== null
        ? Number(((latest - earliest) / 86400000).toFixed(3))
        : 0
    },
    count: original.count,
    totalRows: rows.length,
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
    coverage: {
      totalRows: rows.length,
      rowsWithOriginalScore: original.count,
      rowsWithStoredNormalizedScore: storedCount,
      storedCoveragePct,
      rowsWithNormalizedScore: normalizedScoreValues.length,
      coveragePct,
      replayedNormalizedRows: Math.max(0, replayedCount),
      missingNormalizedRows: missingNormalization.count,
      definition: 'rowsWithNormalizedScore includes an existing stored normalizedScore or a successful historical same-strategy-cycle replay; storedCoveragePct counts persisted values only'
    },
    samePopulation: {
      count: matchedIndexes.length,
      original: originalMatched,
      normalized: normalizedMatched
    },
    comparison: {
      allSignals: allComparison,
      confirmedOnly: confirmedComparison
    },
    confirmedOnly: confirmedComparison,
    byStrategyDistribution: perStrategy(rows, originalValues, normalizedValues),
    missingNormalization,
    coverageNote: 'Coverage is naturally lower because non-directional (WATCH/SETUP) signals do not receive a normalized score.',
    note: source === 'PostgreSQL public.dd_signals'
      ? 'Read-only database report for the requested lookback. Existing stored normalizedScore is preferred; otherwise historical scores are replayed per captured_at+strategy using deduplicated dd_signals. Replay coverage is diagnostic, not exact live per-scan reconstruction. The actual observedRange must be checked to verify whether the database contains the full requested period.'
      : 'Offline descriptive analysis only. Stored normalized values are preferred; missing values are replayed from available same-strategy-cycle feature rows. Missing features/direction are not inferred.'
  };
}

async function loadDatabaseRows(days) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured; cannot run the read-only database diagnostic.');
  }
  let pool;
  let closePool;
  try {
    ({ pool, closePool } = await import('../src/ledger/pg-adapter.mjs'));
    const query = [
      'SELECT captured_at, symbol, strategy, stage, side, score, rsi, trend, volume_spike, details,',
      "       details->>'emaDistanceAtr' AS ema_distance_atr,",
      "       details->>'normalizedScore' AS stored_normalized_score",
      'FROM public.dd_signals',
      'WHERE captured_at >= NOW() - ($1::int * INTERVAL \'1 day\')',
      "  AND strategy IN ('MOMENTUM', 'SCALPING')",
      'ORDER BY captured_at ASC, strategy ASC, symbol ASC'
    ].join('\n');
    const result = await pool.query(query, [days]);
    return result.rows;
  } finally {
    if (typeof closePool === 'function') await closePool();
  }
}

function parseArguments(argv) {
  let days = 7;
  let compareRequested = false;
  let databaseRequested = false;
  let inputPath = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--compare') {
      compareRequested = true;
      continue;
    }
    if (arg === '--database') {
      databaseRequested = true;
      continue;
    }
    if (arg.startsWith('--days=')) {
      days = Number(arg.slice('--days='.length));
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new Error('--days must be an integer between 1 and 3650');
      }
      continue;
    }
    if (arg === '--days') {
      days = Number(argv[++index]);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new Error('--days must be followed by an integer between 1 and 3650');
      }
      continue;
    }
    if (arg.startsWith('--')) throw new Error('Unknown option: ' + arg);
    if (inputPath) throw new Error('Only one JSON input path may be supplied');
    inputPath = arg;
  }
  if (databaseRequested && inputPath) throw new Error('Choose either --database mode or a JSON input path, not both');
  return { days, compareRequested, databaseRequested: databaseRequested || !inputPath, inputPath, help: false };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const { days, compareRequested, databaseRequested, inputPath } = options;
  let rows;
  let source = 'JSON input';
  if (databaseRequested) {
    rows = await loadDatabaseRows(days);
    source = 'PostgreSQL public.dd_signals';
  } else {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    } catch (error) {
      throw new Error('Cannot read/parse JSON input "' + inputPath + '": ' + error.message);
    }
    rows = rowsFrom(parsed);
  }
  if (!rows.length) throw new Error('No dd_signals rows or valid JSON input rows were found.');

  const output = buildReport(rows, {
    source,
    requestedDays: days,
    compareRequested
  });
  if (!output.count) throw new Error('No finite scores within 0-100');
  console.log(JSON.stringify(output, null, 2));
  console.error('[score-distribution] Read ' + rows.length + ' MOMENTUM/SCALPING rows; no database writes performed.');
  console.error('[score-distribution] Requested ' + days + ' days; observed ' + output.observedRange.observedHours + ' hours (' + output.observedRange.observedDays + ' days) from ' + output.observedRange.earliest + ' to ' + output.observedRange.latest + '.');
  console.error('[score-distribution] Persisted normalizedScore coverage: ' + output.coverage.rowsWithStoredNormalizedScore + '/' + output.coverage.totalRows + ' (' + output.coverage.storedCoveragePct + '%). Replay/effective coverage: ' + output.coverage.rowsWithNormalizedScore + '/' + output.coverage.totalRows + ' (' + output.coverage.coveragePct + '%).');
  console.error('[score-distribution] Missing normalization reasons: ' + JSON.stringify(output.missingNormalization.byReason));
  console.error('[score-distribution] Coverage note: ' + output.coverageNote);
  console.error('[score-distribution] Symbols with most missing normalized scores: ' + JSON.stringify(output.missingNormalization.symbols.slice(0, 20)));
  console.error('[score-distribution] 85+ comparison (same population): original ' + output.samePopulation.original.atLeast85.actualPct + '% vs normalized ' + output.samePopulation.normalized.atLeast85.actualPct + '%; CONFIRMED-only original ' + output.confirmedOnly.samePopulation.original.atLeast85.actualPct + '% vs normalized ' + output.confirmedOnly.samePopulation.normalized.atLeast85.actualPct + '%.');
  if (output.observedRange.observedHours < days * 24 * 0.95) {
    console.error('[score-distribution] WARNING: observed data does not span the requested lookback; do not treat this as a full ' + days + '-day sample.');
  }
}

main().catch(error => {
  const message = String(error?.message || error)
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_CONNECTION_STRING]')
    .slice(0, 400);
  console.error('score-distribution: ' + message);
  process.exitCode = 1;
});
