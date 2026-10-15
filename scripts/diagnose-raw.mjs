#!/usr/bin/env node
/**
 * Raw, read-only database diagnostics.
 *
 * Prints PostgreSQL client rows using JSON.stringify without normalizing,
 * parsing, filtering, redacting, or otherwise transforming row values.
 * Every query is independent so one schema/type error does not stop the rest.
 */
import pg from 'pg';

const { Pool } = pg;

const queries = [
  'SELECT COUNT(*) FROM dd_signals',
  'SELECT COUNT(*) FROM dd_fills',
  'SELECT COUNT(*) FROM dd_tradetron_events',
  'SELECT * FROM dd_signals ORDER BY id DESC LIMIT 3',
  'SELECT * FROM dd_fills LIMIT 3',
  'SELECT * FROM dd_tradetron_events LIMIT 3',
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'dd_signals' ORDER BY ordinal_position",
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'dd_fills' ORDER BY ordinal_position",
  "SELECT COUNT(*) FROM dd_signals WHERE captured_at > NOW() - INTERVAL '30 days'",
  'SELECT COUNT(*) FROM dd_signals WHERE captured_at IS NULL',
  'SELECT COUNT(*) FROM dd_signals WHERE captured_at IS NOT NULL'
];

function safeErrorMessage(error) {
  let message = String(error?.message || 'Database query failed');
  message = message
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, 1000);
  return message;
}

let pool;
let failures = 0;
try {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
    console.error('DATABASE_URL is required; its value will not be printed.');
    process.exitCode = 1;
  } else {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: false }
    });

    for (let index = 0; index < queries.length; index += 1) {
      const sql = queries[index];
      console.log('=== QUERY ' + (index + 1) + ' ===');
      console.log('SQL: ' + sql);
      try {
        const result = await pool.query(sql);
        const rows = result.rows;
        console.log('Row count: ' + rows.length);
        console.log('Raw output (JSON.stringify with no transformation):');
        console.log(JSON.stringify(rows, null, 2));
      } catch (error) {
        failures += 1;
        console.log('Row count: 0');
        console.log('Raw output (JSON.stringify with no transformation):');
        console.log('[]');
        console.log('Query error: ' + safeErrorMessage(error));
        if (error?.code) console.log('PostgreSQL error code: ' + String(error.code).slice(0, 30));
      }
      console.log('');
    }
  }
} catch {
  failures += 1;
  console.error('Raw diagnostic could not initialize the database connection; details suppressed.');
  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch {
      failures += 1;
      console.error('Raw diagnostic could not close the database pool; details suppressed.');
      process.exitCode = 1;
    }
  }
}

if (failures > 0) {
  console.error('Raw diagnostic completed with ' + failures + ' failed query/connection operation(s).');
  process.exitCode = 1;
}
