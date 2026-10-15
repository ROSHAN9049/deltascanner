#!/usr/bin/env node
/**
 * SQL-aggregated signal quality report.
 *
 * Every database operation is SELECT-only. Large dd_signals history remains
 * in PostgreSQL: this program transfers only grouped counts and compact
 * correlation diagnostics, never millions of raw signal rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const DAY_MS = 86400000;
const REQUIRED_TRADE_COLUMNS = [
  'id', 'symbol', 'side', 'strategy', 'net_pnl',
  'entry_fill_ids', 'exit_fill_ids', 'opened_at', 'closed_at'
];
const SCORE_BANDS = [
  { key: '0–<40', count: 'score_0_40', confirmed: 'confirmed_0_40' },
  { key: '40–<70', count: 'score_40_70', confirmed: 'confirmed_40_70' },
  { key: '70–<85', count: 'score_70_85', confirmed: 'confirmed_70_85' },
  { key: '85–100', count: 'score_85_100', confirmed: 'confirmed_85_100' }
];

function parseArgs(argv) {
  const result = { output: 'signal-frequency-report.json' };
  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('=')) {
      throw new Error('Arguments must use --name=value format.');
    }
    const separator = arg.indexOf('=');
    const name = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (name !== 'output' || !value) {
      throw new Error('Only --output=path is supported.');
    }
    result.output = value;
  }
  return result;
}

function count(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}
function percent(numerator, denominator) {
  return denominator ? Number((numerator / denominator * 100).toFixed(2)) : null;
}
function round(value, decimals = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
function dateIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function dateText(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).slice(0, 10);
}
function safeCell(value) {
  return String(value === null || value === undefined || value === '' ? '—' : value)
    .replace(/[\r\n\t|]/g, ' ')
    .slice(0, 80);
}
function renderTable(title, headers, rows, maxWidth = 35) {
  console.log(title);
  const allRows = rows.length ? rows : [['No rows']];
  const normalized = [headers, ...allRows].map(row => headers.map((_, i) => safeCell(row[i])));
  const widths = headers.map((header, i) =>
    Math.min(maxWidth, Math.max(String(header).length, ...normalized.map(row => (row[i] || '').length)))
  );
  const border = '|-' + widths.map(width => '-'.repeat(width)).join('-|-') + '-|';
  const format = row => '| ' + row.map((value, i) => value.slice(0, widths[i]).padEnd(widths[i], ' ')).join(' | ') + ' |';
  console.log(format(headers));
  console.log(border);
  for (const row of normalized.slice(1)) console.log(format(row));
  console.log('');
}
function safeError(error) {
  return String(error?.message || 'Database query failed')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, 500);
}
async function queryOne(pool, sql) {
  const result = await pool.query(sql);
  return result.rows[0] || {};
}
async function optionalQuery(pool, sql, label) {
  try {
    return { ok: true, rows: (await pool.query(sql)).rows };
  } catch (error) {
    console.error(label + ' query unavailable: ' + safeError(error));
    return { ok: false, rows: [], error: safeError(error) };
  }
}
function correlationConfidence(result) {
  if (!result || !result.sourceRows || !result.targetRows || !result.sourceRowsWithKeys || !result.targetRowsWithKeys) {
    return 'UNKNOWN';
  }
  const sourceKeyPct = result.sourceRowsWithKeys / result.sourceRows;
  const targetKeyPct = result.targetRowsWithKeys / result.targetRows;
  if (sourceKeyPct < 0.8 || targetKeyPct < 0.8 || result.ambiguousSourceRows > 0 || result.ambiguousTargetRows > 0) {
    return 'UNKNOWN';
  }
  if (result.uniqueMatches <= 0) return 'UNKNOWN';
  const targetMatchPct = result.uniqueMatches / result.targetRowsWithKeys;
  if (targetMatchPct >= 0.9) return 'HIGH';
  if (targetMatchPct >= 0.5) return 'MEDIUM';
  return 'LOW';
}
function publicCorrelation(result, targetRows, targetLabel) {
  const confidence = correlationConfidence(result);
  return {
    count: confidence === 'HIGH' || confidence === 'MEDIUM' ? result.uniqueMatches : 'UNKNOWN',
    confidence,
    source: targetLabel,
    diagnostics: result ? {
      sourceRows: result.sourceRows,
      sourceRowsWithKeys: result.sourceRowsWithKeys,
      targetRows,
      targetRowsWithKeys: result.targetRowsWithKeys,
      definiteMatches: result.uniqueMatches,
      ambiguousSourceRows: result.ambiguousSourceRows,
      ambiguousTargetRows: result.ambiguousTargetRows,
      unmatchedSourceRows: result.unmatchedSourceRows,
      unmatchedTargetRows: result.unmatchedTargetRows
    } : null,
    note: 'Heuristic match only. UNKNOWN means the available identifiers/timestamps cannot support a reliable match count.'
  };
}
function reasonSql(jsonExpression) {
  return [
    'WITH reason_values AS (',
    '  SELECT s.strategy,',
    "    CASE WHEN jsonb_typeof(reason_item.value) = 'string'",
    "      THEN reason_item.value #>> '{}'",
    "      ELSE COALESCE(reason_item.value->>'reason', reason_item.value->>'message', reason_item.value->>'code', reason_item.value::text)",
    '    END AS raw_reason',
    '  FROM public.dd_signals s',
    '  CROSS JOIN LATERAL jsonb_array_elements(',
    "    CASE WHEN jsonb_typeof(" + jsonExpression + ") = 'array' THEN " + jsonExpression + " ELSE '[]'::jsonb END",
    '  ) AS reason_item(value)',
    "  WHERE s.captured_at > NOW() - INTERVAL '30 days'",
    '), categorized AS (',
    '  SELECT strategy,',
    '    CASE',
    "      WHEN raw_reason ~* '(no directional trigger|no trigger)' THEN 'No directional trigger'",
    "      WHEN raw_reason ~* '(score.*below|below.*score|score.*threshold)' THEN 'Signal score below threshold'",
    "      WHEN raw_reason ~* '(rsi|vwap)' THEN 'RSI/VWAP'",
    "      WHEN raw_reason ~* '(volume|spike)' THEN 'Volume spike'",
    "      WHEN raw_reason ~* '(anti.?chase|24.?h)' THEN 'Anti-chase'",
    "      WHEN raw_reason ~* '(entry candle|candle.*range|range.*atr)' THEN 'Entry candle range'",
    "      WHEN raw_reason ~* '(ema.*distance|distance.*ema)' THEN 'EMA distance'",
    "      WHEN raw_reason ~* '(btc|bitcoin)' THEN 'BTC regime'",
    "      WHEN raw_reason ~* '(fee.*spread|spread.*fee|cost.*risk|1r cost)' THEN 'Fee+spread'",
    "      WHEN raw_reason ~* 'spread' THEN 'Spread'",
    "      WHEN raw_reason ~* '(invalid.*(price|stop)|price.*stop)' THEN 'Invalid price/stop'",
    "      ELSE COALESCE(NULLIF(LEFT(BTRIM(raw_reason), 120), ''), 'Other/Uncategorized')",
    '    END AS reason_category',
    '  FROM reason_values',
    ')',
    'SELECT reason_category, strategy, COUNT(*)::text AS occurrences',
    'FROM categorized',
    'GROUP BY reason_category, strategy',
    'ORDER BY COUNT(*) DESC, reason_category, strategy',
    'LIMIT 100'
  ].join('\n');
}

function buildEventCorrelationSql() {
  return [
    'WITH actionable AS (',
    '  SELECT id, UPPER(symbol) AS symbol_key, UPPER(COALESCE(side, \'\')) AS side_key, captured_at',
    '  FROM public.dd_signals',
    "  WHERE captured_at > NOW() - INTERVAL '30 days'",
    '    AND ready IS TRUE',
    "    AND CASE WHEN jsonb_typeof(blocked_reasons) = 'array' THEN jsonb_array_length(blocked_reasons) = 0 ELSE FALSE END",
    '), targets AS (',
    '  SELECT event_id AS target_id, UPPER(symbol) AS symbol_key, UPPER(COALESCE(side, \'\')) AS side_key, event_at AS target_at',
    '  FROM public.dd_tradetron_events',
    "  WHERE event_at > NOW() - INTERVAL '30 days' AND event_at IS NOT NULL AND NULLIF(BTRIM(symbol), '') IS NOT NULL",
    '), pairs AS (',
    '  SELECT s.id AS signal_id, t.target_id,',
    '    COUNT(*) OVER (PARTITION BY s.id) AS signal_candidates,',
    '    COUNT(*) OVER (PARTITION BY t.target_id) AS target_candidates',
    '  FROM actionable s JOIN targets t',
    '    ON s.symbol_key = t.symbol_key',
    "   AND (s.side_key = '' OR t.side_key = '' OR s.side_key = t.side_key)",
    "   AND s.captured_at BETWEEN t.target_at - INTERVAL '5 minutes' AND t.target_at + INTERVAL '5 minutes'",
    '), signal_pairs AS (',
    '  SELECT signal_id, COUNT(*) AS candidates',
    '  FROM pairs GROUP BY signal_id',
    '), target_pairs AS (',
    '  SELECT target_id, COUNT(*) AS candidates',
    '  FROM pairs GROUP BY target_id',
    '), source_stats AS (',
    '  SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE NULLIF(BTRIM(symbol_key), \'\') IS NOT NULL AND captured_at IS NOT NULL)::text AS with_keys',
    '  FROM actionable',
    '), target_stats AS (',
    '  SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE NULLIF(BTRIM(symbol_key), \'\') IS NOT NULL AND target_at IS NOT NULL)::text AS with_keys',
    '  FROM targets',
    ')',
    'SELECT',
    '  (SELECT total FROM source_stats) AS source_rows,',
    '  (SELECT with_keys FROM source_stats) AS source_rows_with_keys,',
    '  (SELECT total FROM target_stats) AS target_rows,',
    '  (SELECT with_keys FROM target_stats) AS target_rows_with_keys,',
    '  (SELECT COUNT(*)::text FROM pairs WHERE signal_candidates = 1 AND target_candidates = 1) AS unique_matches,',
    "  (SELECT COUNT(DISTINCT p.signal_id)::text FROM pairs p WHERE p.signal_candidates > 1 OR p.target_candidates > 1) AS ambiguous_source_rows,",
    "  (SELECT COUNT(DISTINCT p.target_id)::text FROM pairs p WHERE p.signal_candidates > 1 OR p.target_candidates > 1) AS ambiguous_target_rows,",
    "  ((SELECT COUNT(*) FROM actionable) - (SELECT COUNT(*) FROM signal_pairs))::text AS unmatched_source_rows,",
    "  ((SELECT COUNT(*) FROM targets) - (SELECT COUNT(*) FROM target_pairs))::text AS unmatched_target_rows"
  ].join('\n');
}
function buildTradeCorrelationSql() {
  return [
    'WITH actionable AS (',
    '  SELECT id, UPPER(symbol) AS symbol_key, UPPER(COALESCE(side, \'\')) AS side_key, captured_at',
    '  FROM public.dd_signals',
    "  WHERE captured_at > NOW() - INTERVAL '30 days'",
    '    AND ready IS TRUE',
    "    AND CASE WHEN jsonb_typeof(blocked_reasons) = 'array' THEN jsonb_array_length(blocked_reasons) = 0 ELSE FALSE END",
    '), targets AS (',
    '  SELECT id AS target_id, UPPER(symbol) AS symbol_key, UPPER(COALESCE(side, \'\')) AS side_key, opened_at AS target_at',
    '  FROM public.dd_trades',
    "  WHERE opened_at > NOW() - INTERVAL '30 days' AND opened_at IS NOT NULL AND NULLIF(BTRIM(symbol), '') IS NOT NULL",
    '), pairs AS (',
    '  SELECT s.id AS signal_id, t.target_id,',
    '    COUNT(*) OVER (PARTITION BY s.id) AS signal_candidates,',
    '    COUNT(*) OVER (PARTITION BY t.target_id) AS target_candidates',
    '  FROM actionable s JOIN targets t',
    '    ON s.symbol_key = t.symbol_key',
    "   AND (s.side_key = '' OR t.side_key = '' OR s.side_key = t.side_key)",
    "   AND s.captured_at BETWEEN t.target_at - INTERVAL '5 minutes' AND t.target_at + INTERVAL '5 minutes'",
    '), signal_pairs AS (',
    '  SELECT signal_id, COUNT(*) AS candidates FROM pairs GROUP BY signal_id',
    '), target_pairs AS (',
    '  SELECT target_id, COUNT(*) AS candidates FROM pairs GROUP BY target_id',
    '), source_stats AS (',
    '  SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE NULLIF(BTRIM(symbol_key), \'\') IS NOT NULL AND captured_at IS NOT NULL)::text AS with_keys',
    '  FROM actionable',
    '), target_stats AS (',
    '  SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE NULLIF(BTRIM(symbol_key), \'\') IS NOT NULL AND target_at IS NOT NULL)::text AS with_keys',
    '  FROM targets',
    ')',
    'SELECT',
    '  (SELECT total FROM source_stats) AS source_rows,',
    '  (SELECT with_keys FROM source_stats) AS source_rows_with_keys,',
    '  (SELECT total FROM target_stats) AS target_rows,',
    '  (SELECT with_keys FROM target_stats) AS target_rows_with_keys,',
    '  (SELECT COUNT(*)::text FROM pairs WHERE signal_candidates = 1 AND target_candidates = 1) AS unique_matches,',
    "  (SELECT COUNT(DISTINCT p.signal_id)::text FROM pairs p WHERE p.signal_candidates > 1 OR p.target_candidates > 1) AS ambiguous_source_rows,",
    "  (SELECT COUNT(DISTINCT p.target_id)::text FROM pairs p WHERE p.signal_candidates > 1 OR p.target_candidates > 1) AS ambiguous_target_rows,",
    "  ((SELECT COUNT(*) FROM actionable) - (SELECT COUNT(*) FROM signal_pairs))::text AS unmatched_source_rows,",
    "  ((SELECT COUNT(*) FROM targets) - (SELECT COUNT(*) FROM target_pairs))::text AS unmatched_target_rows"
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
    throw new Error('DATABASE_URL is required; its value will not be printed.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('SIGNAL FREQUENCY / READY-SIGNAL REPORT (SQL AGGREGATES)');
    console.log('Window: rolling 30 days; actionable symbol/strategy/day tuples: rolling 7 days');
    console.log('No raw dd_signals rows are exported; all counts and groupings are computed in PostgreSQL.');
    console.log('');

    const allTimeSql = [
      'SELECT COUNT(*)::text AS all_time_rows,',
      '       MIN(captured_at) AS oldest_captured_at,',
      '       MAX(captured_at) AS newest_captured_at,',
      '       COUNT(*) FILTER (WHERE captured_at IS NULL)::text AS null_captured_at',
      'FROM public.dd_signals'
    ].join('\n');
    const allTime = await queryOne(pool, allTimeSql);

    const summarySql = [
      'SELECT',
      '  COUNT(*)::text AS total,',
      "  COUNT(*) FILTER (WHERE stage = 'CONFIRMED')::text AS confirmed,",
      '  COUNT(*) FILTER (WHERE ready IS TRUE)::text AS ready,',
      "  COUNT(*) FILTER (WHERE ready IS TRUE AND CASE WHEN jsonb_typeof(blocked_reasons) = 'array' THEN jsonb_array_length(blocked_reasons) = 0 ELSE FALSE END)::text AS action_ready,",
      '  COUNT(DISTINCT symbol)::text AS unique_symbols,',
      '  COUNT(DISTINCT strategy)::text AS unique_strategies,',
      '  COUNT(DISTINCT (symbol, strategy))::text AS unique_symbol_strategy,',
      '  COUNT(DISTINCT (symbol, strategy)) FILTER (WHERE ready IS TRUE)::text AS ready_symbol_strategy,',
      "  COUNT(DISTINCT (symbol, strategy, (captured_at AT TIME ZONE 'UTC')::date)) FILTER (WHERE ready IS TRUE AND captured_at > NOW() - INTERVAL '7 days')::text AS ready_symbol_strategy_date_7d,",
      '  MIN(captured_at) AS min_captured_at,',
      '  MAX(captured_at) AS max_captured_at,',
      '  COUNT(*) FILTER (WHERE captured_at IS NULL)::text AS null_captured_at',
      'FROM public.dd_signals',
      "WHERE captured_at > NOW() - INTERVAL '30 days'"
    ].join('\n');
    const summary = await queryOne(pool, summarySql);

    const dailySql = [
      "SELECT (captured_at AT TIME ZONE 'UTC')::date::text AS date,",
      '  COUNT(*)::text AS observations,',
      "  COUNT(*) FILTER (WHERE stage = 'CONFIRMED')::text AS confirmed,",
      '  COUNT(*) FILTER (WHERE ready IS TRUE)::text AS ready,',
      "  COUNT(*) FILTER (WHERE ready IS TRUE AND CASE WHEN jsonb_typeof(blocked_reasons) = 'array' THEN jsonb_array_length(blocked_reasons) = 0 ELSE FALSE END)::text AS action_ready,",
      '  COUNT(DISTINCT (symbol, strategy)) FILTER (WHERE ready IS TRUE)::text AS ready_symbol_strategy',
      'FROM public.dd_signals',
      "WHERE captured_at > NOW() - INTERVAL '30 days'",
      "GROUP BY (captured_at AT TIME ZONE 'UTC')::date",
      'ORDER BY (captured_at AT TIME ZONE \'UTC\')::date DESC'
    ].join('\n');
    const dailyResult = await pool.query(dailySql);
    const daily = dailyResult.rows.map(row => ({
      date: dateText(row.date),
      observations: count(row.observations),
      confirmed: count(row.confirmed),
      ready: count(row.ready),
      actionReady: count(row.action_ready),
      readySymbolStrategy: count(row.ready_symbol_strategy)
    }));

    const stageResult = await pool.query([
      'SELECT COALESCE(stage, \'UNKNOWN\') AS stage, COUNT(*)::text AS count',
      'FROM public.dd_signals',
      "WHERE captured_at > NOW() - INTERVAL '30 days'",
      'GROUP BY stage ORDER BY COUNT(*) DESC, stage'
    ].join('\n'));
    const strategyResult = await pool.query([
      'SELECT COALESCE(strategy, \'UNKNOWN\') AS strategy, COUNT(*)::text AS count,',
      "  COUNT(*) FILTER (WHERE stage = 'CONFIRMED')::text AS confirmed,",
      '  COUNT(*) FILTER (WHERE ready IS TRUE)::text AS ready,',
      "  COUNT(*) FILTER (WHERE ready IS TRUE AND CASE WHEN jsonb_typeof(blocked_reasons) = 'array' THEN jsonb_array_length(blocked_reasons) = 0 ELSE FALSE END)::text AS action_ready",
      'FROM public.dd_signals',
      "WHERE captured_at > NOW() - INTERVAL '30 days'",
      'GROUP BY strategy ORDER BY COUNT(*) DESC, strategy'
    ].join('\n'));

    const scoreSql = [
      'SELECT',
      '  COUNT(*) FILTER (WHERE score >= 0 AND score < 40)::text AS score_0_40,',
      '  COUNT(*) FILTER (WHERE score >= 40 AND score < 70)::text AS score_40_70,',
      '  COUNT(*) FILTER (WHERE score >= 70 AND score < 85)::text AS score_70_85,',
      '  COUNT(*) FILTER (WHERE score >= 85 AND score <= 100)::text AS score_85_100,',
      "  COUNT(*) FILTER (WHERE score IS NULL OR score < 0 OR score > 100)::text AS invalid_score,",
      "  COUNT(*) FILTER (WHERE stage = 'CONFIRMED' AND score >= 0 AND score < 40)::text AS confirmed_0_40,",
      "  COUNT(*) FILTER (WHERE stage = 'CONFIRMED' AND score >= 40 AND score < 70)::text AS confirmed_40_70,",
      "  COUNT(*) FILTER (WHERE stage = 'CONFIRMED' AND score >= 70 AND score < 85)::text AS confirmed_70_85,",
      "  COUNT(*) FILTER (WHERE stage = 'CONFIRMED' AND score >= 85 AND score <= 100)::text AS confirmed_85_100,",
      "  COUNT(*) FILTER (WHERE stage = 'CONFIRMED' AND (score IS NULL OR score < 0 OR score > 100))::text AS confirmed_invalid_score",
      'FROM public.dd_signals',
      "WHERE captured_at > NOW() - INTERVAL '30 days'"
    ].join('\n');
    const score = await queryOne(pool, scoreSql);

    const persistedBlocks = await optionalQuery(pool, reasonSql('s.blocked_reasons'), 'Strategy/block-reason');
    const detailBlocks = await optionalQuery(pool, reasonSql("s.details->'blocked'"), 'details.blocked');
    const eventColumnsResult = await optionalQuery(pool, [
      'SELECT column_name, data_type, is_nullable',
      'FROM information_schema.columns',
      "WHERE table_schema = 'public' AND table_name = 'dd_tradetron_events'",
      'ORDER BY ordinal_position'
    ].join('\n'), 'Tradetron event schema');
    const eventColumns = eventColumnsResult.rows || [];
    const eventHasKeys = ['event_id', 'symbol', 'side', 'event_at'].every(name => eventColumns.some(row => row.column_name === name));
    let eventSummary = { total: null, min: null, max: null, validTimestamps: null, tableExists: eventColumns.length > 0 };
    let eventCorrelation = null;
    let eventCorrelationError = null;
    if (eventHasKeys) {
      const eventSummaryResult = await optionalQuery(pool, [
        'SELECT COUNT(*)::text AS total,',
        '  COUNT(*) FILTER (WHERE event_at IS NOT NULL)::text AS valid_timestamps,',
        '  MIN(event_at) AS min_event_at, MAX(event_at) AS max_event_at',
        'FROM public.dd_tradetron_events',
        "WHERE event_at > NOW() - INTERVAL '30 days'"
      ].join('\n'), 'Tradetron event coverage');
      if (eventSummaryResult.ok) {
        const row = eventSummaryResult.rows[0] || {};
        eventSummary = {
          total: count(row.total),
          validTimestamps: count(row.valid_timestamps),
          min: dateIso(row.min_event_at),
          max: dateIso(row.max_event_at),
          tableExists: true
        };
        if (eventSummary.total > 0) {
          const matchResult = await optionalQuery(pool, buildEventCorrelationSql(), 'Tradetron event correlation');
          if (matchResult.ok) {
            const r = matchResult.rows[0] || {};
            eventCorrelation = {
              sourceRows: count(r.source_rows),
              sourceRowsWithKeys: count(r.source_rows_with_keys),
              targetRows: count(r.target_rows),
              targetRowsWithKeys: count(r.target_rows_with_keys),
              uniqueMatches: count(r.unique_matches),
              ambiguousSourceRows: count(r.ambiguous_source_rows),
              ambiguousTargetRows: count(r.ambiguous_target_rows),
              unmatchedSourceRows: count(r.unmatched_source_rows),
              unmatchedTargetRows: count(r.unmatched_target_rows)
            };
          } else eventCorrelationError = matchResult.error;
        }
      } else eventCorrelationError = eventSummaryResult.error;
    }

    const tradeColumnsResult = await optionalQuery(pool, [
      'SELECT column_name, data_type, is_nullable',
      'FROM information_schema.columns',
      "WHERE table_schema = 'public' AND table_name = 'dd_trades'",
      'ORDER BY ordinal_position'
    ].join('\n'), 'dd_trades schema');
    const tradeColumns = tradeColumnsResult.rows || [];
    const tradeColumnNames = tradeColumns.map(row => row.column_name);
    const tradeMissingColumns = REQUIRED_TRADE_COLUMNS.filter(name => !tradeColumnNames.includes(name));
    const tradeTableExists = tradeColumns.length > 0;
    let tradeSummary = { tableExists: tradeTableExists, schemaAvailable: tradeColumnsResult.ok, missingRequiredColumns: tradeMissingColumns, total: null, allTime: null, min: null, max: null };
    let tradeCorrelation = null;
    let tradeCorrelationError = null;
    if (tradeTableExists && tradeMissingColumns.length === 0) {
      const tradeStatsResult = await optionalQuery(pool, [
        'SELECT COUNT(*)::text AS all_time,',
        "  COUNT(*) FILTER (WHERE opened_at > NOW() - INTERVAL '30 days')::text AS total,",
        "  MIN(opened_at) FILTER (WHERE opened_at > NOW() - INTERVAL '30 days') AS min_opened_at,",
        "  MAX(opened_at) FILTER (WHERE opened_at > NOW() - INTERVAL '30 days') AS max_opened_at,",
        "  COUNT(*) FILTER (WHERE opened_at IS NULL)::text AS null_opened_at",
        'FROM public.dd_trades'
      ].join('\n'), 'dd_trades coverage');
      if (tradeStatsResult.ok) {
        const r = tradeStatsResult.rows[0] || {};
        tradeSummary = {
          tableExists: true,
          schemaAvailable: true,
          missingRequiredColumns: [],
          columns: tradeColumns.map(row => ({ name: row.column_name, dataType: row.data_type, nullable: row.is_nullable === 'YES' })),
          allTime: count(r.all_time),
          total: count(r.total),
          min: dateIso(r.min_opened_at),
          max: dateIso(r.max_opened_at),
          nullOpenedAt: count(r.null_opened_at)
        };
        if (tradeSummary.total > 0) {
          const matchResult = await optionalQuery(pool, buildTradeCorrelationSql(), 'dd_trades correlation');
          if (matchResult.ok) {
            const row = matchResult.rows[0] || {};
            tradeCorrelation = {
              sourceRows: count(row.source_rows),
              sourceRowsWithKeys: count(row.source_rows_with_keys),
              targetRows: count(row.target_rows),
              targetRowsWithKeys: count(row.target_rows_with_keys),
              uniqueMatches: count(row.unique_matches),
              ambiguousSourceRows: count(row.ambiguous_source_rows),
              ambiguousTargetRows: count(row.ambiguous_target_rows),
              unmatchedSourceRows: count(row.unmatched_source_rows),
              unmatchedTargetRows: count(row.unmatched_target_rows)
            };
          } else tradeCorrelationError = matchResult.error;
        }
      } else tradeCorrelationError = tradeStatsResult.error;
    }

    const total = count(summary.total);
    const confirmed = count(summary.confirmed);
    const ready = count(summary.ready);
    const actionReady = count(summary.action_ready);
    const readyCombos = count(summary.ready_symbol_strategy);
    const readySymbolStrategyDate7d = count(summary.ready_symbol_strategy_date_7d);
    const observedDates = daily.length;
    const activeDayReadyCombos = daily.reduce((sum, row) => sum + row.readySymbolStrategy, 0);
    const activeDays = daily.filter(row => row.observations > 0).length;
    const allTimeRows = count(allTime.all_time_rows);
    const oldest = dateIso(allTime.oldest_captured_at);
    const newest = dateIso(allTime.newest_captured_at);
    const retentionDays = oldest ? Math.max(0, (Date.now() - new Date(oldest).getTime()) / DAY_MS) : null;
    const total30PerDay = total / 30;
    const confirmedPerDay = confirmed / 30;
    const readyPerDay = ready / 30;
    const actionReadyPerDay = actionReady / 30;
    const readyComboPerDay = activeDayReadyCombos / 30;
    const readyUniqueTuplePerDay7d = readySymbolStrategyDate7d / 7;
    const scoreBandCounts = SCORE_BANDS.map(band => ({
      band: band.key,
      all: count(score[band.count]),
      confirmed: count(score[band.confirmed])
    }));
    const allScored = scoreBandCounts.reduce((sum, row) => sum + row.all, 0);
    const confirmedScored = scoreBandCounts.reduce((sum, row) => sum + row.confirmed, 0);

    function formatPercent(value) {
      return value === null ? 'N/A' : value.toFixed(2) + '%';
    }
    function reasonSummary(queryResult) {
      if (!queryResult.ok) return { totalOccurrences: null, top10: [], byStrategy: [], available: false };
      const grouped = new Map();
      const byStrategy = queryResult.rows.map(row => ({
        reason: String(row.reason_category || 'Other/Uncategorized'),
        strategy: String(row.strategy || 'UNKNOWN'),
        count: count(row.occurrences)
      }));
      for (const row of byStrategy) {
        grouped.set(row.reason, (grouped.get(row.reason) || 0) + row.count);
      }
      return {
        totalOccurrences: byStrategy.reduce((sum, row) => sum + row.count, 0),
        top10: [...grouped.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 10).map(([reason, occurrences]) => ({ reason, count: occurrences })),
        byStrategy: byStrategy.sort((a, b) => b.count - a.count || a.strategy.localeCompare(b.strategy)),
        available: true
      };
    }
    const strategyReasons = reasonSummary(persistedBlocks);
    const detailReasons = reasonSummary(detailBlocks);
    const publishedEventCorrelation = publicCorrelation(eventCorrelation, eventSummary.total, 'dd_tradetron_events within ±5 minutes');
    if (eventSummary.total === 0 && eventSummary.tableExists) {
      publishedEventCorrelation.count = 'UNKNOWN';
      publishedEventCorrelation.confidence = 'UNKNOWN';
      publishedEventCorrelation.note = 'No event rows exist in the 30-day window; this does not prove that no outbound delivery occurred.';
      publishedEventCorrelation.diagnostics = { targetRows: 0, definiteMatches: 0 };
    } else if (!eventSummary.tableExists) {
      publishedEventCorrelation.count = 'UNKNOWN';
      publishedEventCorrelation.confidence = 'UNKNOWN';
      publishedEventCorrelation.note = 'dd_tradetron_events is unavailable or its required columns do not exist.';
    } else if (eventSummary.total === null) {
      publishedEventCorrelation.count = 'UNKNOWN';
      publishedEventCorrelation.confidence = 'UNKNOWN';
      publishedEventCorrelation.note = 'Event schema/coverage could not be verified; event count and correlation are UNKNOWN.';
    } else if (eventCorrelationError) {
      publishedEventCorrelation.count = 'UNKNOWN';
      publishedEventCorrelation.confidence = 'UNKNOWN';
      publishedEventCorrelation.note = 'Event correlation query failed; details are available in the report error field.';
    }
    const publishedTradeCorrelation = publicCorrelation(tradeCorrelation, tradeSummary.total, 'dd_trades opened_at within ±5 minutes of action-ready signals');
    if (!tradeTableExists) {
      publishedTradeCorrelation.count = 'UNKNOWN';
      publishedTradeCorrelation.confidence = 'UNKNOWN';
      publishedTradeCorrelation.note = 'dd_trades does not exist in public schema; correlation unavailable.';
    } else if (tradeMissingColumns.length > 0) {
      publishedTradeCorrelation.count = 'UNKNOWN';
      publishedTradeCorrelation.confidence = 'UNKNOWN';
      publishedTradeCorrelation.note = 'dd_trades schema does not contain the expected correlation columns.';
    } else if (!tradeSummary.total) {
      publishedTradeCorrelation.count = 'UNKNOWN';
      publishedTradeCorrelation.confidence = 'UNKNOWN';
      publishedTradeCorrelation.note = 'No dd_trades rows with opened_at in the last 30 days; correlation is UNKNOWN, not proof of zero fills.';
    } else if (tradeCorrelationError) {
      publishedTradeCorrelation.count = 'UNKNOWN';
      publishedTradeCorrelation.confidence = 'UNKNOWN';
      publishedTradeCorrelation.note = 'Trade correlation query failed; details are available in the report error field.';
    }

    const stageRows = stageResult.rows.map(row => ({
      stage: String(row.stage || 'UNKNOWN'),
      count: count(row.count)
    }));
    const strategyRows = strategyResult.rows.map(row => ({
      strategy: String(row.strategy || 'UNKNOWN'),
      count: count(row.count),
      confirmed: count(row.confirmed),
      ready: count(row.ready),
      actionReady: count(row.action_ready)
    }));

    const recommendedActions = [];
    recommendedActions.push('Score recalibration is on hold. Use action-ready counts and the 7-day unique (symbol, strategy, date) proxy before reviewing any threshold.');
    if (readyUniqueTuplePerDay7d < 2) {
      recommendedActions.push('Unique ready (symbol, strategy, date) tuples average below 2/day; verify the history window and investigate readiness blockers before considering any score change.');
    } else if (readyUniqueTuplePerDay7d <= 8) {
      recommendedActions.push('Unique ready (symbol, strategy, date) tuples average 2–8/day, within the requested monitoring range; validate delivery/trade evidence before judging signal quality.');
    } else {
      recommendedActions.push('Unique ready (symbol, strategy, date) tuples average above 8/day; investigate repeated opportunities/over-signaling before any reviewed recalibration.');
    }
    if (eventSummary.tableExists && eventSummary.total === 0) {
      recommendedActions.push('dd_tradetron_events has zero rows in the last 30 days. Event correlation is UNKNOWN; investigate webhook delivery/configuration separately, without treating the event count as proof no deliveries occurred.');
    }
    if (tradeTableExists && tradeSummary.total === 0) {
      recommendedActions.push('dd_trades has zero rows with opened_at in the last 30 days. Check closed-trade recording/history separately; this table only records closed trades and is not a raw-fill ledger.');
    }
    if (!total) recommendedActions.push('No signal observations were returned for the last 30 days. Verify database access, table population and timestamp filters.');
    recommendedActions.push('Keep live scoring, gates and trading code unchanged until these measured results are reviewed.');

    const report = {
      generatedAt: new Date().toISOString(),
      queryWindow: {
        signalWindow: 'captured_at > NOW() - INTERVAL 30 days',
        tradeWindow: 'opened_at > NOW() - INTERVAL 30 days',
        correlationWindowMinutes: 5,
        signalRowsTransferred: 0,
        rowLimitAppliedToSignalAggregation: false
      },
      dataCoverage: {
        dd_signals: {
          allTimeRows: allTimeRows,
          last30DaysRows: total,
          minCapturedAtLast30Days: dateIso(summary.min_captured_at),
          maxCapturedAtLast30Days: dateIso(summary.max_captured_at),
          allTimeOldestCapturedAt: oldest,
          allTimeNewestCapturedAt: newest,
          actualOldestRowAgeDays: retentionDays === null ? null : round(retentionDays),
          nullCapturedAtAllTime: count(allTime.null_captured_at),
          nullCapturedAtLast30Days: count(summary.null_captured_at),
          uniqueSymbols: count(summary.unique_symbols),
          uniqueStrategies: count(summary.unique_strategies),
          uniqueSymbolStrategyCombos: count(summary.unique_symbol_strategy),
          activeUtcDatesInWindow: activeDays,
          dailyAggregateRows: observedDates
        },
        dd_tradetron_events: {
          tableExists: eventSummary.tableExists,
          last30DaysRows: eventSummary.total,
          validTimestampRows: eventSummary.validTimestamps,
          minEventAt: eventSummary.min,
          maxEventAt: eventSummary.max,
          correlationError: eventCorrelationError
        },
        dd_trades: {
          ...tradeSummary,
          correlationError: tradeCorrelationError
        },
        dd_fills: {
          usedAsReportSource: false,
          note: 'Legacy raw-fill table is not used. Closed trades are read from dd_trades.'
        }
      },
      readySignalMetrics: {
        totalObservations: { count: total, pctOfTotal: total ? 100 : null, per30CalendarDays: round(total30PerDay) },
        confirmedStage: { count: confirmed, pctOfTotal: percent(confirmed, total), per30CalendarDays: round(confirmedPerDay) },
        readyTrue: { count: ready, pctOfTotal: percent(ready, total), per30CalendarDays: round(readyPerDay) },
        readyTrueAndNoBlockers: { count: actionReady, pctOfTotal: percent(actionReady, total), per30CalendarDays: round(actionReadyPerDay) },
        uniqueSymbolStrategyReady30d: { count: readyCombos, pctOfTotal: null, per30CalendarDays: round(readyComboPerDay) },
        uniqueSymbolStrategyDateReady7d: {
          count: readySymbolStrategyDate7d,
          pctOfTotal: null,
          perCalendarDay: round(readyUniqueTuplePerDay7d),
          windowDays: 7,
          definition: 'COUNT(DISTINCT (symbol, strategy, UTC date)) where ready=true; repeated scan observations collapse within each symbol/strategy/day.'
        },
        confirmedIsNotReady: true,
        readyIsNotEquivalentToNoBlockers: true
      },
      stageBreakdown: stageRows.map(row => ({ ...row, pctOfTotal: percent(row.count, total) })),
      strategyBreakdown: strategyRows.map(row => ({
        ...row, pctOfTotal: percent(row.count, total),
        confirmedPctOfStrategy: percent(row.confirmed, row.count),
        readyPctOfStrategy: percent(row.ready, row.count),
        actionReadyPctOfStrategy: percent(row.actionReady, row.count)
      })),
      signalFrequency: {
        daily: daily,
        averagePer30CalendarDays: {
          observations: round(total30PerDay),
          confirmedStage: round(confirmedPerDay),
          readyTrue: round(readyPerDay),
          readyTrueAndNoBlockers: round(actionReadyPerDay),
          uniqueReadySymbolStrategyPerDay: round(readyComboPerDay),
          uniqueReadySymbolStrategyDatePerDayLast7Days: round(readyUniqueTuplePerDay7d)
        }
      },
      scoreDistribution: {
        boundaries: '0–<40, 40–<70, 70–<85, 85–100; missing/out-of-range values excluded from band percentages',
        allObservations: {
          totalRows: total,
          scoredRows: allScored,
          missingOrOutOfRange: count(score.invalid_score),
          bands: scoreBandCounts.map(row => ({ band: row.band, count: row.all, pctOfValidScores: percent(row.all, allScored) }))
        },
        confirmedOnly: {
          totalRows: confirmed,
          scoredRows: confirmedScored,
          missingOrOutOfRange: count(score.confirmed_invalid_score),
          bands: scoreBandCounts.map(row => ({ band: row.band, count: row.confirmed, pctOfValidScores: percent(row.confirmed, confirmedScored) }))
        }
      },
      blockReasons: {
        persistedBlockedReasons: {
          sourceField: 'dd_signals.blocked_reasons',
          note: 'Reported independently. In the current persistence path this may contain downstream gate reasons; it is not assumed to be exclusively strategy-level.',
          ...strategyReasons
        },
        detailsBlocked: {
          sourceField: 'dd_signals.details.blocked',
          note: 'Reported independently and not merged with blocked_reasons.',
          ...detailReasons
        }
      },
      funnel: {
        step1ConfirmedStage: { count: confirmed, note: 'CONFIRMED stage observations; may not be ready.' },
        step2ReadyTrue: { count: ready, note: 'All observations where ready IS TRUE; independent of stage label.' },
        step3ReadyAndNoBlockers: { count: actionReady, note: 'ready IS TRUE and blocked_reasons is a JSON array of length zero.' },
        step4TradetronEventCorrelation: publishedEventCorrelation,
        step5ClosedTradeCorrelation: publishedTradeCorrelation,
        recordedClosedTradesLast30Days: tradeSummary.total,
        correlationConfidence: {
          tradetronEvents: publishedEventCorrelation.confidence,
          closedTrades: publishedTradeCorrelation.confidence
        }
      },
      summary: {
        readyTrueAndNoBlockersPerDay: round(actionReadyPerDay),
        uniqueReadySymbolStrategyDatePerDayLast7Days: round(readyUniqueTuplePerDay7d),
        recommendedActions: recommendedActions
      }
    };

    console.log('SECTION 1 — DATA COVERAGE (all-time counts and actual date coverage)');
    renderTable('Coverage', ['Source', 'Rows', 'Min time', 'Max time', 'Notes'], [
      ['dd_signals all-time', allTimeRows, oldest || 'N/A', newest || 'N/A', 'Actual oldest-row age: ' + (retentionDays === null ? 'N/A' : round(retentionDays) + ' days')],
      ['dd_signals last 30d', total, dateIso(summary.min_captured_at) || 'N/A', dateIso(summary.max_captured_at) || 'N/A', 'No LIMIT; aggregate query'],
      ['dd_tradetron_events last 30d', eventSummary.total === null ? 'UNKNOWN' : eventSummary.total, eventSummary.min || 'N/A', eventSummary.max || 'N/A', eventSummary.tableExists ? 'Event rows are not proof of outbound delivery' : 'Table/schema unavailable'],
      ['dd_trades opened last 30d', tradeSummary.total === null ? 'UNKNOWN' : tradeSummary.total, tradeSummary.min || 'N/A', tradeSummary.max || 'N/A', tradeTableExists ? 'Closed trades, not raw fills' : 'Table unavailable']
    ], 35);
    console.log('dd_signals unique symbols: ' + count(summary.unique_symbols));
    console.log('dd_signals unique strategies: ' + count(summary.unique_strategies));
    console.log('dd_signals unique (symbol,strategy): ' + count(summary.unique_symbol_strategy));
    console.log('dd_signals null captured_at (all-time): ' + count(allTime.null_captured_at));
    console.log('dd_trades schema exists: ' + (tradeTableExists ? 'YES' : 'NO/UNKNOWN'));
    if (tradeTableExists) console.log('dd_trades schema columns: ' + tradeColumns.map(row => row.column_name + ' (' + row.data_type + ', nullable=' + row.is_nullable + ')').join('; '));
    if (tradeMissingColumns.length) console.log('dd_trades missing expected columns: ' + tradeMissingColumns.join(', '));
    console.log('');

    renderTable('SECTION 2A — STAGE AND STRATEGY BREAKDOWN', ['Stage/Strategy', 'Count', '% of total'], [
      ...stageRows.map(row => ['Stage ' + row.stage, row.count, formatPercent(row.pctOfTotal)]),
      ...strategyRows.map(row => ['Strategy ' + row.strategy, row.count, formatPercent(row.pctOfTotal)])
    ], 31);

    renderTable('SECTION 2B — READY VS CONFIRMED VS ACTION-READY (rolling 30 days)', ['Metric', 'Count', '% of total', 'Per day'], [
      ['Total observations', total, formatPercent(total ? 100 : null), round(total30PerDay)],
      ['CONFIRMED stage', confirmed, formatPercent(percent(confirmed, total)), round(confirmedPerDay)],
      ['ready=true', ready, formatPercent(percent(ready, total)), round(readyPerDay)],
      ['ready=true AND no blockers', actionReady, formatPercent(percent(actionReady, total)), round(actionReadyPerDay)],
      ['Unique (symbol,strategy), ready=true', readyCombos, 'N/A', round(readyComboPerDay)]
    ], 34);
    console.log('Unique ready (symbol,strategy,date) tuples — last 7 days: ' + readySymbolStrategyDate7d);
    console.log('Estimated unique ready tuples/day — last 7 days: ' + round(readyUniqueTuplePerDay7d));
    console.log('Caution: a symbol/strategy/day tuple is a conservative opportunity proxy, not a distinct entry ID.');
    console.log('');

    renderTable('SECTION 3 — DAILY BREAKDOWN (SQL aggregates; rolling 30-day window)', ['UTC date', 'Observations', 'CONFIRMED', 'ready=true', 'ready+empty blockers', 'Unique ready combos'], daily.map(row => [
      row.date, row.observations, row.confirmed, row.ready, row.actionReady, row.readySymbolStrategy
    ]), 24);
    console.log('Active UTC dates represented: ' + activeDays);
    console.log('');

    renderTable('SECTION 4 — SCORE DISTRIBUTION (ALL vs CONFIRMED stage)', ['Score band', 'ALL count', 'ALL %', 'CONFIRMED count', 'CONFIRMED %'], scoreBandCounts.map(row => [
      row.band, row.all, formatPercent(percent(row.all, allScored)), row.confirmed, formatPercent(percent(row.confirmed, confirmedScored))
    ]), 23);
    console.log('Missing/out-of-range scores: ALL=' + count(score.invalid_score) + '; CONFIRMED=' + count(score.confirmed_invalid_score));
    console.log('');

    renderTable('SECTION 5A — PERSISTED blocked_reasons (separate source)', ['Reason category', 'Count'], strategyReasons.top10.map(row => [row.reason, row.count]), 42);
    renderTable('Top persisted reason counts by strategy', ['Strategy', 'Reason category', 'Count'], strategyReasons.byStrategy.slice(0, 20).map(row => [row.strategy, row.reason, row.count]), 42);
    renderTable('SECTION 5B — details.blocked (not merged with blocked_reasons)', ['Reason category', 'Count'], detailReasons.top10.map(row => [row.reason, row.count]), 42);
    console.log('Persisted reason occurrences: ' + (strategyReasons.totalOccurrences === null ? 'UNAVAILABLE' : strategyReasons.totalOccurrences));
    console.log('details.blocked reason occurrences: ' + (detailReasons.totalOccurrences === null ? 'UNAVAILABLE' : detailReasons.totalOccurrences));
    console.log('');

    renderTable('SECTION 6 — SIGNAL-TO-ACTION AND RECORDED-TRADE FUNNEL', ['Stage/metric', 'Count', 'Interpretation'], [
      ['1. CONFIRMED stage', confirmed, 'Not equivalent to ready=true'],
      ['2. ready=true', ready, 'Readiness flag from persisted signal row'],
      ['3. ready=true + no blockers', actionReady, 'Blocker array must be empty'],
      ['4. Tradetron event correlation', publishedEventCorrelation.count, publishedEventCorrelation.note],
      ['5. dd_trades correlation', publishedTradeCorrelation.count, publishedTradeCorrelation.note],
      ['Recorded dd_trades rows', tradeSummary.total === null ? 'UNKNOWN' : tradeSummary.total, 'Actual closed-trade records opened in the last 30 days']
    ], 44);
    console.log('Event correlation confidence: ' + publishedEventCorrelation.confidence);
    console.log('Trade correlation confidence: ' + publishedTradeCorrelation.confidence);
    console.log('dd_tradetron_events rows in window: ' + (eventSummary.total === null ? 'UNKNOWN' : eventSummary.total));
    console.log('dd_trades rows in window: ' + (tradeSummary.total === null ? 'UNKNOWN' : tradeSummary.total));
    console.log('');

    console.log('SECTION 7 — SUMMARY & RECOMMENDED ACTION');
    console.log('CONFIRMED/day (rolling 30 days): ' + round(confirmedPerDay));
    console.log('ready=true/day (rolling 30 days): ' + round(readyPerDay));
    console.log('ready=true and no blockers/day: ' + round(actionReadyPerDay));
    console.log('Unique ready (symbol,strategy,date)/day over last 7 days: ' + round(readyUniqueTuplePerDay7d));
    for (const action of recommendedActions) console.log('- ' + action);
    console.log('');

    try {
      fs.writeFileSync(path.resolve(args.output), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw new Error('Could not write JSON report output: ' + args.output);
    }
    console.log('JSON aggregate report written: ' + args.output);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Signal frequency report failed: ' + (error?.message === 'DATABASE_URL is required; its value will not be printed.' ? error.message : safeError(error)));
  process.exitCode = 1;
});
