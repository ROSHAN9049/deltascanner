const requested = String(process.env.DELTA_ENVIRONMENT || 'SIGNAL_ONLY').toUpperCase();
const environment = requested === 'TESTNET' ? 'TESTNET' : 'SIGNAL_ONLY';
const signalOnly = environment === 'SIGNAL_ONLY';

function parseTradetronBridgeRoutes() {
  const raw = String(process.env.TRADETRON_BRIDGES_JSON || '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TRADETRON_BRIDGES_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('TRADETRON_BRIDGES_JSON must be an array');

  const ids = new Set();
  const tokens = new Set();
  const allSymbols = new Set();
  return parsed.map((row, index) => {
    const id = String(row?.id || 'bridge-' + (index + 1)).trim();
    const authToken = String(row?.authToken || '').trim();
    const symbols = [...new Set((Array.isArray(row?.symbols) ? row.symbols : [])
      .map(x => String(x || '').trim().toUpperCase())
      .filter(x => /^[A-Z0-9]+USD$/.test(x) && x !== 'USD'))];
    if (!id || ids.has(id)) throw new Error('TRADETRON_BRIDGES_JSON contains an empty or duplicate bridge id');
    if (!authToken) throw new Error('TRADETRON_BRIDGES_JSON bridge ' + id + ' is missing authToken');
    if (tokens.has(authToken)) throw new Error('TRADETRON_BRIDGES_JSON must use a unique authToken for each bridge');
    if (!symbols.length) throw new Error('TRADETRON_BRIDGES_JSON bridge ' + id + ' has no valid symbols');
    for (const symbol of symbols) {
      if (allSymbols.has(symbol)) throw new Error('TRADETRON_BRIDGES_JSON assigns ' + symbol + ' to more than one bridge');
      allSymbols.add(symbol);
    }
    ids.add(id);
    tokens.add(authToken);
    return Object.freeze({ id, authToken, symbols: Object.freeze(symbols) });
  });
}

const tradetronBridgeRoutes = parseTradetronBridgeRoutes();

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
  tradetronDynamicBridgeEnabled: signalOnly ? false : String(process.env.TRADETRON_DYNAMIC_BRIDGE_ENABLED || 'false').toLowerCase() === 'true',
  // The currently confirmed Tradetron Signal Bridge is a fixed 13-symbol
  // basket. Explicitly opt symbols in after adding them to the real strategy;
  // do not report unsupported scanner symbols as successfully routed.
  tradetronSupportedSymbols: [...new Set(String(
    process.env.TRADETRON_SUPPORTED_SYMBOLS ||
    'BTCUSD,ETHUSD,AAPLXUSD,ADAUSD,ALGOUSD,AMDBUSD,AMZNXUSD,ATOMUSD,AVAXUSD,BCHUSD,BNBUSD,CBRSBUSD,COINXUSD'
  ).split(',').map(x => x.trim().toUpperCase()).filter(x => /^[A-Z0-9]+USD$/.test(x)))],
  // If provided, this route table replaces the legacy single-token allowlist.
  // Each bridge id owns a distinct, fixed symbol set and linked API token.
  tradetronBridgeRoutes,
  // Options require a separately configured Tradetron strategy/token. Keep
  // this route disabled until that strategy exists and has been validated.
  tradetronOptionsBridgeEnabled: String(process.env.TRADETRON_OPTIONS_BRIDGE_ENABLED || 'false').toLowerCase() === 'true',
  tradetronOptionsAuthToken: process.env.TRADETRON_OPTIONS_AUTH_TOKEN || '',
  tradetronWebhookSecret: process.env.TRADETRON_WEBHOOK_SECRET || '',
  tradetronBaseUrl: process.env.TRADETRON_BASE_URL || 'https://api.tradetron.tech',
  tradetronAuthToken: process.env.TRADETRON_AUTH_TOKEN || '',
  tradetronTimeoutMs: Number(process.env.TRADETRON_TIMEOUT_MS || 10000),
  tradetronCapitalUsd: Number(process.env.TRADETRON_CAPITAL_USD || 5000)
});
