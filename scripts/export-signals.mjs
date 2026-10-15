#!/usr/bin/env node
import pg from 'pg';

const { Pool } = pg;
const SECRET_KEY = /(api.?key|access.?token|refresh.?token|secret|password|authorization|cookie|credential|database.?url|private.?key)/i;

function sanitize(value, key = '', depth = 0) {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
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
    throw new Error('DATABASE_URL is required; value was not printed.');
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false }
  });
  const result = await pool.query(
    "SELECT id, captured_at, symbol, strategy, stage, score, side, ready, blocked_reasons, details " +
    "FROM public.dd_signals " +
    "WHERE captured_at > NOW() - INTERVAL '30 days' " +
    "ORDER BY captured_at DESC LIMIT 100000"
  );
  const rows = result.rows.map(row => sanitize(row));
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  const times = rows.map(row => Date.parse(row.captured_at)).filter(Number.isFinite);
  const min = times.length ? new Date(times.reduce((value, time) => Math.min(value, time), Infinity)).toISOString() : 'none';
  const max = times.length ? new Date(times.reduce((value, time) => Math.max(value, time), -Infinity)).toISOString() : 'none';
  console.error('Exported ' + rows.length + ' rows (range: ' + min + ' to ' + max + ')');
} catch (error) {
  console.error('Signal export failed: ' + (error?.message === 'DATABASE_URL is required; value was not printed.' ? error.message : 'database query failed; connection details suppressed.'));
  exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch {
      console.error('Signal export: pool shutdown failed; details suppressed.');
      exitCode = 1;
    }
  }
}
if (exitCode) process.exitCode = exitCode;
