const env = String(process.env.DELTA_ENVIRONMENT || 'TESTNET').toUpperCase();
if (env !== 'TESTNET') throw new Error('Delta production execution is disabled in this build.');

const envBool = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  return raw === '' ? fallback : !['false', '0', 'no', 'off'].includes(raw);
};
const envNumber = (name, fallback, min = -Infinity) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
};

export const CONFIG = Object.freeze({
  environment: 'TESTNET',
  scanOnly: envBool('SCAN_ONLY', true),
  paperEquity: envNumber('PAPER_EQUITY', 1000, 0),
  minTurnoverUsd: envNumber('MIN_TURNOVER_USD', 1000, 0),
  maxAbsChange24h: envNumber('MAX_ABS_CHANGE_24H', 30, 0),
  maxSpreadPct: envNumber('MAX_SPREAD_PCT', 1, 0),
  volSpikeMin: envNumber('VOL_SPIKE_MIN', 1.6, 0),
  restBase: 'https://cdn-ind.testnet.deltaex.org',
  publicWs: 'wss://socket-ind-pub.testnet.deltaex.org',
  privateWs: 'wss://socket-ind.testnet.deltaex.org',
  apiKey: String(process.env.DELTA_TESTNET_API_KEY || '').trim(),
  apiSecret: String(process.env.DELTA_TESTNET_API_SECRET || '').trim(),
  engineSecret: process.env.ENGINE_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseAdminKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  workerId: process.env.WORKER_ID || ('delta-worker-' + process.pid)
});