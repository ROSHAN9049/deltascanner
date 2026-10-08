const requested = String(process.env.DELTA_ENVIRONMENT || 'SIGNAL_ONLY').toUpperCase();
const environment = requested === 'TESTNET' ? 'TESTNET' : 'SIGNAL_ONLY';
const signalOnly = environment === 'SIGNAL_ONLY';

export const CONFIG = Object.freeze({
  environment,
  signalOnly,
  directDeltaExecutionEnabled: false,
  restBase: signalOnly ? 'https://api.india.delta.exchange' : 'https://cdn-ind.testnet.deltaex.org',
  publicWs: signalOnly ? 'wss://public-socket.india.delta.exchange' : 'wss://socket-ind-pub.testnet.deltaex.org',
  privateWs: signalOnly ? '' : 'wss://socket-ind.testnet.deltaex.org',
  apiKey: signalOnly ? '' : String(process.env.DELTA_TESTNET_API_KEY || '').trim(),
  apiSecret: signalOnly ? '' : String(process.env.DELTA_TESTNET_API_SECRET || '').trim(),
  engineSecret: process.env.ENGINE_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseAdminKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  workerId: process.env.WORKER_ID || ('delta-signal-worker-' + process.pid),
  tradetronBridgeEnabled: String(process.env.TRADETRON_BRIDGE_ENABLED || 'true').toLowerCase() === 'true',
  tradetronDynamicBridgeEnabled: String(process.env.TRADETRON_DYNAMIC_BRIDGE_ENABLED || 'false').toLowerCase() === 'true',
  tradetronBaseUrl: process.env.TRADETRON_BASE_URL || 'https://api.tradetron.tech',
  tradetronAuthToken: process.env.TRADETRON_AUTH_TOKEN || '',
  tradetronTimeoutMs: Number(process.env.TRADETRON_TIMEOUT_MS || 10000),
  tradetronCapitalUsd: Number(process.env.TRADETRON_CAPITAL_USD || 5000)
});
