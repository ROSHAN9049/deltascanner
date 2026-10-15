#!/usr/bin/env node
/**
 * Read-only offline score-distribution report.
 *
 * Usage:
 *   node scripts/score-distribution.mjs path/to/scores.json
 *
 * Input may be a JSON array of numbers or objects with a score field, or an
 * object wrapping the rows in scores/signals/rows/data. This script does not
 * connect to the worker, exchange, database, or any order API.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeStats } from '../src/indicators/ta.mjs';

const TARGETS = [
  { key: '0-<40', min: 0, max: 40, targetPct: 60 },
  { key: '40-<70', min: 40, max: 70, targetPct: 30 },
  { key: '70-<85', min: 70, max: 85, targetPct: 8 },
  { key: '85-100', min: 85, max: 100, targetPct: 2 }
];

function usage() {
  console.error('Usage: node scripts/score-distribution.mjs <scores.json>');
  console.error('JSON may be an array of scores/rows or an object with scores, signals, rows, or data.');
}

function rowsFrom(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return [];
  for (const key of ['scores', 'signals', 'rows', 'data']) {
    if (Array.isArray(input[key])) return input[key];
  }
  return [];
}

function scoreFrom(row) {
  const candidate = typeof row === 'number' || typeof row === 'string'
    ? row
    : row && typeof row === 'object'
      ? row.score ?? row.details?.score ?? row.signal?.score
      : null;
  if (candidate === null || candidate === undefined || candidate === '') return null;
  const score = Number(candidate);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || inputPath === '--help' || inputPath === '-h') {
    usage();
    process.exitCode = inputPath ? 0 : 2;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read/parse JSON input "${inputPath}": ${error.message}`);
  }
  const rows = rowsFrom(parsed);
  if (!rows.length) {
    throw new Error('Input JSON must be an array or contain an array in scores, signals, rows, or data.');
  }

  const scoredRows = [];
  let skipped = 0;
  for (let index = 0; index < rows.length; index++) {
    const score = scoreFrom(rows[index]);
    if (score === null) {
      skipped++;
      continue;
    }
    const row = rows[index] && typeof rows[index] === 'object' ? rows[index] : {};
    scoredRows.push({ row, score, index });
  }
  if (!scoredRows.length) {
    throw new Error('No finite scores within 0-100 were found in the input.');
  }

  const values = scoredRows.map(item => item.score);
  const stats = computeStats(values);
  const bands = Object.fromEntries(TARGETS.map(target => {
    const count = values.filter(value => value >= target.min && (
      target.max === 100 ? value <= target.max : value < target.max
    )).length;
    const actualPct = count / values.length * 100;
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

  const output = {
    inputFile: path.resolve(inputPath),
    generatedAt: new Date().toISOString(),
    scoreScale: '0-100',
    count: values.length,
    skippedRows: skipped,
    statistics: {
      mean: Number(stats.mean.toFixed(4)),
      median: Number(median(values).toFixed(4)),
      populationStdDev: Number(stats.stddev.toFixed(4)),
      min: stats.min,
      max: stats.max
    },
    targetProfile: '60% scores <40; 30% 40-<70; 8% 70-<85; 2% 85-100',
    bands,
    byStrategy: groupedCounts(scoredRows.map(item => item.row), 'strategy'),
    byStage: groupedCounts(scoredRows.map(item => item.row), 'stage'),
    note: 'Offline descriptive analysis only; target-band deltas are calibration diagnostics, not a trading instruction.'
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  console.error('score-distribution:', error.message);
  process.exitCode = 1;
});
