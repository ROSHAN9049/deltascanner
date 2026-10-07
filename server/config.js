const env = String(process.env.DELTA_ENVIRONMENT || 'TESTNET').toUpperCase();
if (env !== 'TESTNET') throw new Error('Delta production execution is disabled in this build.');

export const CONFIG = Object.freeze({
  environment: 'TESTNET',
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
  workerId: process.env.WORKER_ID || ('delta-worker-' + process.pid),
  tradetronBridgeEnabled: String(process.env.TRADETRON_BRIDGE_ENABLED || 'false').toLowerCase() === 'true',
  tradetronBaseUrl: process.env.TRADETRON_BASE_URL || 'https://api.tradetron.tech',
  tradetronAuthToken: process.env.TRADETRON_AUTH_TOKEN || '',
  tradetronTimeoutMs: Number(process.env.TRADETRON_TIMEOUT_MS || 10000),
  tradetronCapitalUsd: Number(process.env.TRADETRON_CAPITAL_USD || 5000)
});