const env = String(process.env.DELTA_ENVIRONMENT || 'TESTNET').toUpperCase();
if (env !== 'TESTNET') throw new Error('Delta production execution is disabled in this build.');

export const CONFIG = Object.freeze({
  environment: 'TESTNET',
  restBase: 'https://cdn-ind.testnet.deltaex.org',
  publicWs: 'wss://socket-ind-pub.testnet.deltaex.org',
  privateWs: 'wss://socket-ind.testnet.deltaex.org',
  apiKey: process.env.DELTA_TESTNET_API_KEY || '',
  apiSecret: process.env.DELTA_TESTNET_API_SECRET || '',
  engineSecret: process.env.ENGINE_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  workerId: process.env.WORKER_ID || ('delta-worker-' + process.pid)
});