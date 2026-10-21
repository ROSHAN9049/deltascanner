import { readdir, readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOKAHEAD_MS = 300000;
export const LOOKAHEAD_TOLERANCE_MS = 5000;

function finite(value) {
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
  if (value > 0.3) return 'High Buy Pressure';
  if (value < -0.3) return 'High Sell Pressure';
  return 'Neutral';
}

function createMetric(group, symbol = null) {
  return {
    group,
    symbol,
    observations: 0,
    returnSumPct: 0,
    wins: 0,
    up: 0,
    down: 0,
    flat: 0
  };
}

function addOutcome(metric, changePct) {
  metric.observations += 1;
  metric.returnSumPct += changePct;
  if (changePct > 0) metric.up += 1;
  else if (changePct < 0) metric.down += 1;
  else metric.flat += 1;
  if (metric.group === 'High Buy Pressure' && changePct > 0) metric.wins += 1;
  if (metric.group === 'High Sell Pressure' && changePct < 0) metric.wins += 1;
}

function isUsablePriceRow(row) {
  return row && row.bookFresh !== false
    && finite(row.staticImbalance) !== null
    && finite(row.midPrice) !== null
    && finite(row.midPrice) > 0;
}

export function calculateBacktest(rows, options = {}) {
  const horizonMs = Number.isFinite(options.horizonMs) ? options.horizonMs : LOOKAHEAD_MS;
  const toleranceMs = Number.isFinite(options.toleranceMs)
    ? options.toleranceMs : LOOKAHEAD_TOLERANCE_MS;
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
  for (const sessionRows of sessions.values()) {
    sessionRows.sort((left, right) => left.timestampMs - right.timestampMs);
    let cursor = 0;
    for (let i = 0; i < sessionRows.length; i += 1) {
      const row = sessionRows[i];
      if (!isUsablePriceRow(row)) continue;
      const imbalance = finite(row.staticImbalance);
      const group = classifyImbalance(imbalance);
      if (!group) continue;
      const startPrice = finite(row.midPrice);
      const targetTimestamp = row.timestampMs + horizonMs;
      while (cursor < sessionRows.length && sessionRows[cursor].timestampMs < targetTimestamp) {
        cursor += 1;
      }
      let futureIndex = cursor;
      while (futureIndex < sessionRows.length
        && sessionRows[futureIndex].timestampMs <= targetTimestamp + toleranceMs
        && !isUsablePriceRow(sessionRows[futureIndex])) {
        futureIndex += 1;
      }
      if (futureIndex >= sessionRows.length) continue;
      const future = sessionRows[futureIndex];
      if (future.timestampMs < targetTimestamp
        || future.timestampMs > targetTimestamp + toleranceMs
        || !isUsablePriceRow(future)) continue;
      const futurePrice = finite(future.midPrice);
      if (startPrice === null || startPrice <= 0 || futurePrice === null || futurePrice <= 0) continue;
      const changePct = ((futurePrice - startPrice) / startPrice) * 100;
      outcomes.push({
        symbol: row.symbol,
        sessionId: row.sessionId,
        timestampMs: row.timestampMs,
        group,
        imbalance,
        startPrice,
        futureTimestampMs: future.timestampMs,
        futurePrice,
        changePct
      });
    }
  }

  const groups = ['High Buy Pressure', 'High Sell Pressure', 'Neutral'];
  const overallMetrics = new Map(groups.map(group => [group, createMetric(group)]));
  const symbolMetrics = new Map();
  for (const outcome of outcomes) {
    addOutcome(overallMetrics.get(outcome.group), outcome.changePct);
    const key = outcome.symbol + '|' + outcome.group;
    if (!symbolMetrics.has(key)) symbolMetrics.set(key, createMetric(outcome.group, outcome.symbol));
    addOutcome(symbolMetrics.get(key), outcome.changePct);
  }
  return {
    outcomes,
    overall: groups.map(group => overallMetrics.get(group)),
    bySymbol: [...symbolMetrics.values()].sort((left, right) =>
      left.symbol.localeCompare(right.symbol) || groups.indexOf(left.group) - groups.indexOf(right.group))
  };
}

function pct(value, count, digits = 1) {
  return count > 0 ? (value / count * 100).toFixed(digits) + '%' : 'N/A';
}

function averageChange(metric) {
  return metric.observations > 0
    ? (metric.returnSumPct / metric.observations).toFixed(4) + '%'
    : 'N/A';
}

function formatMetricRow(metric) {
  const winRate = metric.group === 'Neutral'
    ? 'N/A (no direction)'
    : pct(metric.wins, metric.observations);
  return '| ' + metric.group + ' | ' + metric.observations + ' | ' + averageChange(metric)
    + ' | ' + winRate + ' | ' + pct(metric.up, metric.observations)
    + ' / ' + pct(metric.down, metric.observations)
    + ' / ' + pct(metric.flat, metric.observations) + ' |';
}

export function buildMarkdownSummary({ fileName, totalRows, freshBookRows, result }) {
  const lines = [
    '# OFI preliminary 5-minute look-ahead',
    '',
    '- Data file: ' + fileName,
    '- Raw observations: ' + totalRows,
    '- Observations with a fresh book, valid imbalance and mid-price: ' + freshBookRows,
    '- Evaluated observations with a 5-minute forward price: ' + result.outcomes.length,
    '- Look-ahead: 300 seconds; accepted target timing: 300–305 seconds after the observation',
    '',
    '## Results by imbalance group',
    '',
    '| Group | Evaluated observations | Average 5-min price change | Directional win rate | Price up / down / flat |',
    '|---|---:|---:|---:|---:|',
    ...result.overall.map(metric => formatMetricRow(metric)),
    '',
    '## Results by symbol and group',
    '',
    '| Symbol | Group | Evaluated observations | Average 5-min change | Directional win rate | Price up / down / flat |',
    '|---|---|---:|---:|---:|---:|',
    ...result.bySymbol.map(metric => {
      const winRate = metric.group === 'Neutral'
        ? 'N/A (no direction)'
        : pct(metric.wins, metric.observations);
      return '| ' + metric.symbol + ' | ' + metric.group + ' | ' + metric.observations
        + ' | ' + averageChange(metric) + ' | ' + winRate + ' | '
        + pct(metric.up, metric.observations) + ' / '
        + pct(metric.down, metric.observations) + ' / '
        + pct(metric.flat, metric.observations) + ' |';
    }),
    '',
    '## Interpretation limits',
    '',
    '- Neutral rows have no predicted direction, so directional win rate is reported as N/A. Up/down/flat proportions are shown instead.',
    '- Rows are sampled once per second and 5-minute outcomes overlap heavily. Observations are not independent; these results are exploratory, not a statistical proof of an edge.',
    '- Returns use midpoint prices, not executable fills, and do not include fees, spread-crossing, latency or slippage.',
    '- A buy-pressure group is counted as a win only when the 5-minute midpoint return is positive; sell-pressure only when it is negative. Flat returns do not count as wins.',
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
  const rows = [];
  let malformedLines = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      malformedLines += 1;
    }
  }

  const freshBookRows = rows.filter(isUsablePriceRow).length;
  const result = calculateBacktest(rows);
  const summary = buildMarkdownSummary({ fileName, totalRows: rows.length, freshBookRows, result });
  const diagnostic = malformedLines ? '\nMalformed lines skipped: ' + malformedLines + '\n' : '';
  process.stdout.write(summary + diagnostic);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + diagnostic, 'utf8');
  }
  return { filePath, rows: rows.length, malformedLines, result, summary };
}

async function main() {
  await runBacktest();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[OFI] Backtest failed: ' + String(error?.stack || error));
    process.exitCode = 1;
  });
}
