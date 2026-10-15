#!/usr/bin/env node
/**
 * Export selected signal-cache observations as JSON for offline analysis.
 *
 * This script never writes to the database. Safe to run from CI.
 */

function sanitizeError(error) {
  let message = String(error?.message || error || 'Database export failed');
  for (const name of ['DATABASE_URL', 'SUPABASE_DB_URL']) {
    const value = process.env[name];
    if (value) message = message.split(value).join('[REDACTED]');
  }
  message = message
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_CONNECTION_STRING]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_HEX]')
    .replace(/(password|token|secret|authorization|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  return message.slice(0, 300);
}

function hasSecretLikeHex(value) {
  if (typeof value === 'string') return /\b[a-f0-9]{32,}\b/i.test(value);
  if (Array.isArray(value)) return value.some(hasSecretLikeHex);
  if (value && typeof value === 'object') return Object.values(value).some(hasSecretLikeHex);
  return false;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not configured. Add it via GitHub Settings → Secrets and variables → Actions.');
    process.exitCode = 1;
    return;
  }

  let pool;
  let closePool;
  let exitCode = 0;

  try {
    // Import only after the required environment variable check.
    ({ pool, closePool } = await import('../src/ledger/pg-adapter.mjs'));

    // Read-only query: this script does not INSERT, UPDATE, DELETE, or migrate.
    const result = await pool.query(
      'SELECT symbol, strategy, stage, score, details FROM public.dd_signal_cache ORDER BY score DESC'
    );
    const rows = result.rows;

    const suspiciousRows = rows.reduce(
      (count, row) => count + (hasSecretLikeHex(row.details) ? 1 : 0),
      0
    );
    if (suspiciousRows > 0) {
      console.error(
        `WARNING: secret-like long hex strings detected in details for ${suspiciousRows} row(s); values were not printed or redacted.`
      );
    }

    console.log(JSON.stringify(rows, null, 2));
    console.error(`Exported ${rows.length} rows`);
  } catch (error) {
    console.error('Signal-cache export failed: ' + sanitizeError(error));
    exitCode = 1;
  } finally {
    if (typeof closePool === 'function') {
      try {
        await closePool();
      } catch (error) {
        console.error('PostgreSQL pool close failed: ' + sanitizeError(error));
        exitCode = 1;
      }
    }
  }

  if (exitCode !== 0) process.exitCode = exitCode;
}

await main();
