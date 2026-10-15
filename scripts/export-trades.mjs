#!/usr/bin/env node
/**
 * Export closed-trade records from dd_trades for the last 30 days.
 * This is a read-only export; the main frequency report computes aggregates
 * inside PostgreSQL rather than exporting raw signal observations.
 */
import pg from 'pg';

const { Pool } = pg;
const SENSITIVE_KEY = /(api.?key|access.?token|refresh.?token|secret|password|authorization|cookie|credential|database.?url|private.?key)/i;

function sanitize(value, key = '', depth = 0) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'string') {
    return value
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
      .slice(0, 2000);
  }
  if (depth >= 8) return '[TRUNCATED_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, '', depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const childKey of Object.keys(value).slice(0, 200)) {
      output[childKey] = sanitize(value[childKey], childKey, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 2000);
}

let pool;
let exitCode = 0;
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
  const result = await pool.query(
    "SELECT id, symbol, side, strategy, entry_price, exit_price, qty, " +
    "net_pnl AS pnl, entry_fill_ids AS entry_fill_id, exit_fill_ids AS exit_fill_id, " +
    "opened_at, closed_at " +
    "FROM public.dd_trades " +
    "WHERE opened_at > NOW() - INTERVAL '30 days' " +
    "ORDER BY opened_at DESC"
  );
  const rows = result.rows.map(row => sanitize(row));
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  console.error('Exported ' + rows.length + ' dd_trades rows (last 30 days).');
} catch (error) {
  const message = error?.message === 'DATABASE_URL is required; its value will not be printed.'
    ? error.message
    : 'Trade export failed; database errors are suppressed to avoid leaking connection details.';
  console.error(message);
  exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch {
      console.error('Trade export: database pool shutdown failed; details suppressed.');
      exitCode = 1;
    }
  }
}
if (exitCode) process.exitCode = exitCode;
