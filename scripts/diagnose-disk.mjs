#!/usr/bin/env node
/**
 * Read-only disk usage diagnostics. Prints a human summary and machine-readable
 * JSON. This script never mutates database state.
 */
import pg from 'pg';

const { Pool } = pg;

function number(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}
function safeError(error) {
  return String(error?.message || 'Database query failed')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, 800);
}
function printJson(label, value) {
  console.log(label);
  console.log(JSON.stringify(value, null, 2));
}

let pool;
let exitCode = 0;
const report = {
  generatedAt: new Date().toISOString(),
  database: null,
  largestTables: [],
  ddSignalsAgeBuckets: null,
  ddSignalsPayloadSizes: null,
  errors: []
};
try {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
    throw new Error('DATABASE_URL is required; its value will not be printed.');
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false }
  });

  const sizeResult = await pool.query(
    'SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size, ' +
    'pg_database_size(current_database())::text AS database_bytes, current_database() AS database_name'
  );
  report.database = sizeResult.rows[0] || null;

  const tableSizeResult = await pool.query(
    'SELECT schemaname, relname, pg_size_pretty(pg_total_relation_size(relid)) AS total_size, ' +
    'pg_total_relation_size(relid)::text AS total_bytes ' +
    'FROM pg_catalog.pg_statio_user_tables ' +
    'ORDER BY pg_total_relation_size(relid) DESC LIMIT 20'
  );
  report.largestTables = tableSizeResult.rows;

  const ageResult = await pool.query(
    "SELECT " +
    "COUNT(*) FILTER (WHERE captured_at < NOW() - INTERVAL '1 day')::text AS o1, " +
    "COUNT(*) FILTER (WHERE captured_at < NOW() - INTERVAL '2 days')::text AS o2, " +
    "COUNT(*) FILTER (WHERE captured_at < NOW() - INTERVAL '3 days')::text AS o3, " +
    "COUNT(*) FILTER (WHERE captured_at < NOW() - INTERVAL '5 days')::text AS o5, " +
    "COUNT(*) FILTER (WHERE captured_at < NOW() - INTERVAL '7 days')::text AS o7, " +
    "COUNT(*)::text AS total " +
    "FROM public.dd_signals"
  );
  const age = ageResult.rows[0] || {};
  report.ddSignalsAgeBuckets = {
    olderThan1Day: number(age.o1),
    olderThan2Days: number(age.o2),
    olderThan3Days: number(age.o3),
    olderThan5Days: number(age.o5),
    olderThan7Days: number(age.o7),
    totalRows: number(age.total)
  };

  const payloadResult = await pool.query(
    "SELECT " +
    "COALESCE(pg_size_pretty(SUM(pg_column_size(details))::bigint), '0 bytes') AS details_size, " +
    "COALESCE(SUM(pg_column_size(details))::bigint, 0)::text AS details_bytes, " +
    "COALESCE(pg_size_pretty(SUM(pg_column_size(blocked_reasons))::bigint), '0 bytes') AS blockers_size, " +
    "COALESCE(SUM(pg_column_size(blocked_reasons))::bigint, 0)::text AS blockers_bytes " +
    "FROM public.dd_signals"
  );
  report.ddSignalsPayloadSizes = payloadResult.rows[0] || null;

  console.log('DISK USAGE DIAGNOSTIC');
  console.log('Generated at: ' + report.generatedAt);
  console.log('Database: ' + String(report.database?.database_name || 'unknown'));
  console.log('Database size: ' + String(report.database?.database_size || 'unknown') +
    ' (' + String(report.database?.database_bytes || 'unknown') + ' bytes)');
  console.log('');
  console.log('TOP TABLES BY TOTAL RELATION SIZE');
  if (!report.largestTables.length) {
    console.log('No user tables returned.');
  } else {
    console.log('Schema | Table | Total size | Bytes');
    for (const row of report.largestTables) {
      console.log([
        String(row.schemaname || ''),
        String(row.relname || ''),
        String(row.total_size || ''),
        String(row.total_bytes || '')
      ].join(' | '));
    }
  }
  console.log('');
  console.log('dd_signals ROW AGE BUCKETS');
  console.log('Older than 1 day: ' + report.ddSignalsAgeBuckets.olderThan1Day);
  console.log('Older than 2 days: ' + report.ddSignalsAgeBuckets.olderThan2Days);
  console.log('Older than 3 days: ' + report.ddSignalsAgeBuckets.olderThan3Days);
  console.log('Older than 5 days: ' + report.ddSignalsAgeBuckets.olderThan5Days);
  console.log('Older than 7 days: ' + report.ddSignalsAgeBuckets.olderThan7Days);
  console.log('Total rows: ' + report.ddSignalsAgeBuckets.totalRows);
  console.log('');
  console.log('dd_signals JSON PAYLOAD SIZE (column data, not full table/index size)');
  console.log('details: ' + report.ddSignalsPayloadSizes.details_size +
    ' (' + report.ddSignalsPayloadSizes.details_bytes + ' bytes)');
  console.log('blocked_reasons: ' + report.ddSignalsPayloadSizes.blockers_size +
    ' (' + report.ddSignalsPayloadSizes.blockers_bytes + ' bytes)');
  console.log('');
  printJson('JSON REPORT', report);
} catch (error) {
  const message = error?.message === 'DATABASE_URL is required; its value will not be printed.'
    ? error.message
    : safeError(error);
  report.errors.push(message);
  console.error('Disk diagnostic failed: ' + message);
  printJson('PARTIAL JSON REPORT', report);
  exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch {
      console.error('Disk diagnostic: pool shutdown failed; details suppressed.');
      exitCode = 1;
    }
  }
}
if (exitCode) process.exitCode = exitCode;
