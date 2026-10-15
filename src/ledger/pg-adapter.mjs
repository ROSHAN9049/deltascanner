import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required for PositionLedger. Add it to .env.');
}

// This Pool connects to the Supabase PostgreSQL database directly. It is
// separate from the REST-based server/db.js and does not modify that module.
export const pool = new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', error => {
  // Never log connection configuration or credentials.
  console.error('[ledger-db] Unexpected PostgreSQL pool error:', error.message);
});

export const db = {
  query: (sql, params) => pool.query(sql, params)
};

export async function testConnection() {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    // PostgreSQL errors may contain connection details; expose only a generic
    // message and safe error code, never the connection string.
    const safeError = new Error('PositionLedger PostgreSQL startup connection test failed');
    if (error && error.code) safeError.code = error.code;
    throw safeError;
  }
}

export async function closePool() {
  await pool.end();
}
