import assert from 'node:assert/strict';
import { calculateStaticImbalance, parseDurationArg } from './ofi-collector.mjs';
import { readdir, readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOKAHEAD_MS = 300000;
export const LOOKAHEAD_TOLERANCE_MS = 5000;
export const ROUND_TRIP_COST_PCT = 0.25;
export const BUY_PRESSURE_THRESHOLD = 0.25;
export const SELL_PRESSURE_THRESHOLD = -0.25;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampOf(row) {
  const numericTimestamp = finite(row.timestampMs);
  if (numericTimestamp !== null && numericTimestamp > 0) return numericTimestamp;
  const parsedIso = Date.parse(row.observedAt || '');
  return Number.isFinite(parsedIso) ? parsedIso : null;
}

export function classifyImbalance(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value > BUY_PRESSURE_THRESHOLD) return 'High Buy Pressure';
  if (value < SELL_PRESSURE_THRESHOLD) return 'High Sell Pressure';
  return 'Neutral';
}

function createMetric(group, symbol = null) {
  return {
    group, symbol, selected: 0, observations: 0,
    marketReturnSumPct: 0, directionalGrossSumPct: 0, netDirectionalSumPct: 0,
    wins: 0, up: 0, down: 0, flat: 0
  };
}

function isUsablePriceRow(row) {
  return row && row.bookFresh !== false
    && finite(row.staticImbalance) !== null
    && finite(row.midPrice) !== null
    && finite(row.midPrice) > 0;
}

function lowerBoundTimestamp(rows, targetTimestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].timestampMs < targetTimestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function findForwardPriceRow(rows, selectedRow, horizonMs, toleranceMs) {
  const targetTimestamp = selectedRow.timestampMs + horizonMs;
  let index = lowerBoundTimestamp(rows, targetTimestamp);
  while (index < rows.length && rows[index].timestampMs <= targetTimestamp + toleranceMs) {
    if (isUsablePriceRow(rows[index])) return rows[index];
    index += 1;
  }
  return null;
}

function selectNonOverlapping(rows, horizonMs) {
  const selected = [];
  let nextEligibleAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.timestampMs < nextEligibleAt) continue;
    selected.push(row);
    nextEligibleAt = row.timestampMs + horizonMs;
  }
  return selected;
}

function addOutcome(metric, row, future) {
  metric.observations += 1;
  const startPrice = finite(row.midPrice);
  const futurePrice = finite(future.midPrice);
  const marketReturnPct = ((futurePrice - startPrice) / startPrice) * 100;
  metric.marketReturnSumPct += marketReturnPct;
  if (marketReturnPct > 0) metric.up += 1;
  else if (marketReturnPct < 0) metric.down += 1;
  else metric.flat += 1;

  if (metric.group === 'High Buy Pressure' || metric.group === 'High Sell Pressure') {
    const directionalGrossReturnPct = metric.group === 'High Buy Pressure' ? marketReturnPct : -marketReturnPct;
    const netDirectionalReturnPct = directionalGrossReturnPct - ROUND_TRIP_COST_PCT;
    metric.directionalGrossSumPct += directionalGrossReturnPct;
    metric.netDirectionalSumPct += netDirectionalReturnPct;
    if (netDirectionalReturnPct > 0) metric.wins += 1;
    return { marketReturnPct, directionalGrossReturnPct, netDirectionalReturnPct };
  }
  return { marketReturnPct, directionalGrossReturnPct: null, netDirectionalReturnPct: null };
}

function buildImbalanceDiagnostics(rows) {
  const diagnostics = new Map();
  for (const row of rows) {
    if (!isUsablePriceRow(row)) continue;
    const symbol = row.symbol;
    if (!diagnostics.has(symbol)) {
      diagnostics.set(symbol, {
        symbol, freshBookRows: 0, maxPositiveImbalance: null,
        sampledBuyOver030: 0, sampledBuyOver025: 0,
        sampledSellBelow030: 0, sampledSellBelow025: 0
      });
    }
    const item = diagnostics.get(symbol);
    const imbalance = finite(row.staticImbalance);
    item.freshBookRows += 1;
    if (imbalance > 0) {
      item.maxPositiveImbalance = item.maxPositiveImbalance === null
        ? imbalance : Math.max(item.maxPositiveImbalance, imbalance);
    }
    if (imbalance > 0.3) item.sampledBuyOver030 += 1;
    if (imbalance > BUY_PRESSURE_THRESHOLD) item.sampledBuyOver025 += 1;
    if (imbalance < -0.3) item.sampledSellBelow030 += 1;
    if (imbalance < SELL_PRESSURE_THRESHOLD) item.sampledSellBelow025 += 1;
  }
  return [...diagnostics.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export function calculateBacktest(rows, options = {}) {
  const horizonMs = Number.isFinite(options.horizonMs) ? options.horizonMs : LOOKAHEAD_MS;
  const toleranceMs = Number.isFinite(options.toleranceMs) ? options.toleranceMs : LOOKAHEAD_TOLERANCE_MS;
  const sessions = new Map();
  for (const row of rows) {
    const timestampMs = timestampOf(row);
    const symbol = String(row.symbol || '').toUpperCase();
    if (timestampMs === null || !symbol) continue;
    const sessionId = String(row.sessionId || 'legacy-session');
    const key = sessionId + '|' + symbol;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push({ ...row, timestampMs, symbol, sessionId });
  }

  const outcomes = [];
  const groups = ['High Buy Pressure', 'High Sell Pressure', 'Neutral'];
  const overallMetrics = new Map(groups.map(group => [group, createMetric(group)]));
  const symbolMetrics = new Map();
  const getSymbolMetric = (symbol, group) => {
    const key = symbol + '|' + group;
    if (!symbolMetrics.has(key)) symbolMetrics.set(key, createMetric(group, symbol));
    return symbolMetrics.get(key);
  };

  for (const sessionRowsUnsorted of sessions.values()) {
    const sessionRows = sessionRowsUnsorted.sort((left, right) => left.timestampMs - right.timestampMs);
    const usableRows = sessionRows.filter(isUsablePriceRow);
    const directionalRows = usableRows.filter(row => classifyImbalance(finite(row.staticImbalance)) !== 'Neutral');
    const neutralRows = usableRows.filter(row => classifyImbalance(finite(row.staticImbalance)) === 'Neutral');

    // Buy and sell candidates share one stream, so directional trade windows cannot overlap.
    const selectedDirectional = selectNonOverlapping(directionalRows, horizonMs);
    // Neutral observations form a separate non-overlapping control series, not executable trades.
    const selectedNeutral = selectNonOverlapping(neutralRows, horizonMs);
    const selected = selectedDirectional.map(row => ({
      row, group: classifyImbalance(finite(row.staticImbalance)), isDirectional: true
    })).concat(selectedNeutral.map(row => ({ row, group: 'Neutral', isDirectional: false })));

    for (const item of selected) {
      const { row, group } = item;
      const overall = overallMetrics.get(group);
      const bySymbol = getSymbolMetric(row.symbol, group);
      overall.selected += 1;
      bySymbol.selected += 1;
      const future = findForwardPriceRow(sessionRows, row, horizonMs, toleranceMs);
      if (!future) continue;
      const values = addOutcome(overall, row, future);
      addOutcome(bySymbol, row, future);
      outcomes.push({
        symbol: row.symbol, sessionId: row.sessionId,
        timestampMs: row.timestampMs, futureTimestampMs: future.timestampMs, group,
        imbalance: finite(row.staticImbalance), startPrice: finite(row.midPrice), futurePrice: finite(future.midPrice),
        marketReturnPct: values.marketReturnPct,
        directionalGrossReturnPct: values.directionalGrossReturnPct,
        netDirectionalReturnPct: values.netDirectionalReturnPct,
        isWin: values.netDirectionalReturnPct !== null && values.netDirectionalReturnPct > 0
      });
    }
  }

  return {
    outcomes,
    selectedDirectionalSignalCount: groups.slice(0, 2).reduce(
      (total, group) => total + overallMetrics.get(group).selected, 0
    ),
    selectedNeutralReferenceCount: overallMetrics.get('Neutral').selected,
    directionalSignalsWithoutForwardPrice: groups.slice(0, 2).reduce(
      (total, group) => total + overallMetrics.get(group).selected - overallMetrics.get(group).observations, 0
    ),
    neutralReferencesWithoutForwardPrice:
      overallMetrics.get('Neutral').selected - overallMetrics.get('Neutral').observations,
    overall: groups.map(group => overallMetrics.get(group)),
    bySymbol: [...symbolMetrics.values()].sort((left, right) =>
      left.symbol.localeCompare(right.symbol) || groups.indexOf(left.group) - groups.indexOf(right.group)),
    imbalanceDiagnostics: buildImbalanceDiagnostics(rows)
  };
}

function pct(value, count, digits = 1) {
  return count > 0 ? (value / count * 100).toFixed(digits) + '%' : 'N/A';
}

function average(value, count) {
  return count > 0 ? (value / count).toFixed(4) + '%' : 'N/A';
}

function directionalWinRate(metric) {
  return metric.group === 'Neutral' ? 'N/A (control, no direction)' : pct(metric.wins, metric.observations);
}

function formatMetricRow(metric, includeSymbol = false) {
  const name = includeSymbol ? metric.symbol + ' · ' + metric.group : metric.group;
  const isDirectional = metric.group !== 'Neutral';
  return '| ' + name + ' | ' + metric.selected + ' | ' + metric.observations + ' | '
    + average(metric.marketReturnSumPct, metric.observations) + ' | '
    + (isDirectional ? average(metric.directionalGrossSumPct, metric.observations) : 'N/A')
    + ' | ' + (isDirectional ? average(metric.netDirectionalSumPct, metric.observations) : 'N/A')
    + ' | ' + directionalWinRate(metric) + ' | '
    + pct(metric.up, metric.observations) + ' / '
    + pct(metric.down, metric.observations) + ' / '
    + pct(metric.flat, metric.observations) + ' |';
}

export function buildMarkdownSummary({ fileName, totalRows, analyzedRows, sessionId, result }) {
  const diagnostics = result.imbalanceDiagnostics;
  const totalFresh = diagnostics.reduce((total, item) => total + item.freshBookRows, 0);
  const maxPositive = diagnostics.reduce((best, item) =>
    item.maxPositiveImbalance === null ? best : Math.max(best, item.maxPositiveImbalance), Number.NEGATIVE_INFINITY);
  const maxPositiveText = Number.isFinite(maxPositive) ? maxPositive.toFixed(6) : 'N/A (no positive imbalance)';
  const lines = [
    '# OFI 5-minute non-overlapping backtest (after costs)',
    '',
    '- Data file: ' + fileName,
    '- Analyzed collection session: ' + (sessionId || 'legacy session'),
    '- Rows read from daily archive file: ' + totalRows,
    '- Rows in analyzed session: ' + analyzedRows,
    '- Fresh-book 1-second observations in analyzed session: ' + totalFresh,
    '- Maximum positive static imbalance seen in sampled data: ' + maxPositiveText,
    '- Selection: first available directional high-pressure signal, then skip the next 300 seconds per symbol/session.',
    '- Neutral rows are sampled separately as a non-overlapping control series; they are not executable trades.',
    '- Look-ahead: 300 seconds; accepted target time: 300–305 seconds after the selected observation.',
    '- Directional thresholds: buy > +' + BUY_PRESSURE_THRESHOLD.toFixed(2) + '; sell < ' + SELL_PRESSURE_THRESHOLD.toFixed(2) + '.',
    '- Trading cost assumption: 0.10% entry fee + 0.10% exit fee + 0.05% slippage = ' + ROUND_TRIP_COST_PCT.toFixed(2) + '% round trip.',
    '- A directional win requires net directional return > 0, i.e. gross move in the forecast direction strictly greater than 0.25%.',
    '- Independent directional candidates selected: ' + result.selectedDirectionalSignalCount,
    '- Directional outcomes with a complete 5-minute forward price: ' + (result.selectedDirectionalSignalCount - result.directionalSignalsWithoutForwardPrice),
    '- Directional candidates without a complete 5-minute forward price: ' + result.directionalSignalsWithoutForwardPrice,
    '- Neutral control observations selected: ' + result.selectedNeutralReferenceCount,
    '- Neutral references without a complete 5-minute forward price: ' + result.neutralReferencesWithoutForwardPrice,
    '',
    '## Results by group',
    '',
    '| Group | Selected non-overlapping rows | Completed outcomes | Avg market return | Avg gross directional return | Avg net directional return | True win rate after costs | Price up / down / flat |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...result.overall.map(metric => formatMetricRow(metric)),
    '',
    '## Results by symbol and group',
    '',
    '| Symbol · Group | Selected rows | Completed outcomes | Avg market return | Avg gross directional return | Avg net directional return | True win rate after costs | Price up / down / flat |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...result.bySymbol.map(metric => formatMetricRow(metric, true)),
    '',
    '## Buy-pressure diagnostic',
    '',
    '- Maximum positive imbalance in analyzed 1-second samples: ' + maxPositiveText,
    '',
    '| Symbol | Fresh sampled books | Max positive imbalance | Count > +0.30 (old buy threshold) | Count > +0.25 (new buy threshold) | Count < -0.30 | Count < -0.25 |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...diagnostics.map(item => '| ' + item.symbol + ' | ' + item.freshBookRows + ' | '
      + (item.maxPositiveImbalance === null ? 'N/A' : item.maxPositiveImbalance.toFixed(6))
      + ' | ' + item.sampledBuyOver030 + ' | ' + item.sampledBuyOver025
      + ' | ' + item.sampledSellBelow030 + ' | ' + item.sampledSellBelow025 + ' |'),
    '',
    '## Interpretation limits',
    '',
    '- True win rate counts only completed directional trades whose forecast-direction move exceeds 0.25%; neutral control rows have no directional win rate.',
    '- Five-minute outcome windows do not overlap within each symbol/session directional trade stream. Neutral controls use their own non-overlapping stream and are not counted as trades.',
    '- Cost assumptions are fixed approximations; this does not model actual exchange fee tier, spread crossing, order-book execution, market impact, funding or latency.',
    '- This is midpoint-based research, not evidence of executable or statistically significant profitability. Interpret the 55% bar together with independent trade count and per-symbol consistency.',
    ''
  ];
  return lines.join('\n');
}

export async function findLatestDataFile(dataDir = resolve(process.cwd(), 'data')) {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const candidates = entries
    .filter(entry => entry.isFile() && /^ofi-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left));
  if (!candidates.length) throw new Error('No data/ofi-YYYY-MM-DD.jsonl files found');
  return resolve(dataDir, candidates[0]);
}

export async function runBacktest() {
  const filePath = await findLatestDataFile();
  const fileName = filePath.split(/[\\/]/).at(-1);
  const content = await readFile(filePath, 'utf8');
  const allRows = [];
  let malformedLines = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') allRows.push(row);
    } catch {
      malformedLines += 1;
    }
  }

  // A daily archive can contain several manual runs; evaluate only the latest session.
  const sessionId = allRows.at(-1)?.sessionId || null;
  const rows = sessionId ? allRows.filter(row => String(row.sessionId || '') === sessionId) : allRows;
  const result = calculateBacktest(rows);
  const summary = buildMarkdownSummary({
    fileName, totalRows: allRows.length, analyzedRows: rows.length, sessionId, result
  });
  const diagnostic = malformedLines ? '\nMalformed lines skipped: ' + malformedLines + '\n' : '';
  process.stdout.write(summary + diagnostic);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + diagnostic, 'utf8');
  }
  return { filePath, rows: rows.length, malformedLines, result, summary };
}

async function runSelfTests() {
  const imbalance = calculateStaticImbalance([[99, 5], [100, 10]], [[102, 3], [101, 2]]);
  assert.equal(imbalance.bestBid, 100);
  assert.equal(imbalance.bestAsk, 101);
  assert.equal(imbalance.bidVolume, 15);
  assert.equal(imbalance.askVolume, 5);
  assert.equal(imbalance.staticImbalance, 0.5);
  assert.equal(parseDurationArg(['--duration=14400']), 14400);
  assert.equal(classifyImbalance(0.25), 'Neutral');
  assert.equal(classifyImbalance(-0.25), 'Neutral');
  assert.equal(classifyImbalance(0.251), 'High Buy Pressure');
  assert.equal(classifyImbalance(-0.251), 'High Sell Pressure');
  assert.throws(() => parseDurationArg(['--duration=86401']), /Duration/);

  const base = 1800000000000;
  const row = (sessionId, offset, price, staticImbalance) => ({
    sessionId, timestampMs: base + offset, symbol: 'BTCUSD',
    bookFresh: true, midPrice: price, staticImbalance
  });
  const result = calculateBacktest([
    row('non-overlap', 0, 100, 0.26),
    row('non-overlap', 1000, 100.2, -0.40),
    row('non-overlap', 299000, 100.8, -0.40),
    row('non-overlap', 300000, 101, -0.26),
    row('non-overlap', 600000, 100.3, 0),
    row('non-overlap', 900000, 100, 0),
    row('non-overlap', 1200000, 99.5, 0)
  ]);
  assert.equal(result.selectedDirectionalSignalCount, 2);
  assert.equal(result.overall.find(metric => metric.group === 'High Buy Pressure').selected, 1);
  assert.equal(result.overall.find(metric => metric.group === 'High Sell Pressure').selected, 1);
  assert.equal(result.overall.find(metric => metric.group === 'High Buy Pressure').wins, 1);
  assert.equal(result.overall.find(metric => metric.group === 'High Sell Pressure').wins, 1);
  assert.equal(result.overall.find(metric => metric.group === 'Neutral').observations, 2);

  const costBoundary = calculateBacktest([
    row('cost-boundary', 0, 100, 0.26),
    row('cost-boundary', 300000, 100.249, 0)
  ]);
  const buyMetric = costBoundary.overall.find(metric => metric.group === 'High Buy Pressure');
  assert.equal(buyMetric.observations, 1);
  assert.equal(buyMetric.wins, 0, 'gross move below 0.25% must not count as a win after costs');

  const costFreeWin = calculateBacktest([
    row('cost-win', 0, 100, -0.26),
    row('cost-win', 300000, 99.7, 0)
  ]);
  const sellMetric = costFreeWin.overall.find(metric => metric.group === 'High Sell Pressure');
  assert.equal(sellMetric.observations, 1);
  assert.equal(sellMetric.wins, 1);
  console.log('[OFI] Research self-tests passed: non-overlap, symmetric thresholds, cost boundary and after-cost win rate.');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    await runSelfTests();
    return;
  }
  await runBacktest();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[OFI] Backtest failed: ' + String(error?.stack || error));
    process.exitCode = 1;
  });
}
