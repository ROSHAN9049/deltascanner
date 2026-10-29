import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Support local .env for non-Railway use without overwriting injected environment values.
function loadLocalEnvFile() {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  let contents;
  try { contents = readFileSync(envPath, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2] || '';
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') ||
        (value[0] === "'" && value.at(-1) === "'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
}
loadLocalEnvFile();

export function parseDeltaExecutionMode(value) {
  const mode = String(value ?? 'disabled').trim().toLowerCase();
  if (mode === 'live') throw new Error('Live mode requires explicit user approval via code change');
  if (!['testnet', 'disabled'].includes(mode)) {
    throw new Error('DELTA_EXECUTION_MODE must be either "testnet" or "disabled" for now');
  }
  return mode;
}

const deltaExecutionMode = parseDeltaExecutionMode(process.env.DELTA_EXECUTION_MODE);
const deltaTestnetRestBase = String(process.env.DELTA_TESTNET_REST_BASE || 'https://cdn-ind.testnet.deltaex.org').trim().replace(/\/+$/, '');
const deltaTestnetWsUrl = String(process.env.DELTA_TESTNET_WS_URL || 'wss://socket-ind.testnet.deltaex.org').trim();
// Scanner prices/candles always come from the liquid production public feed.
// Testnet is reserved for authenticated account, order and position operations.
const marketDataRestBase = 'https://api.india.delta.exchange';
const publicMarketDataWs = 'wss://public-socket.india.delta.exchange';
if (deltaExecutionMode === 'testnet' && deltaTestnetRestBase !== 'https://cdn-ind.testnet.deltaex.org') {
  throw new Error('DELTA_TESTNET_REST_BASE must use the hardcoded Delta India Testnet endpoint');
}
if (deltaExecutionMode === 'testnet' && deltaTestnetWsUrl !== 'wss://socket-ind.testnet.deltaex.org') {
  throw new Error('DELTA_TESTNET_WS_URL must use the private Delta India Testnet WebSocket endpoint');
}

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

const tradetronBridgeRoutes = [];

export const CONFIG = Object.freeze({
  environment,
  signalOnly,
  deltaExecutionMode,
  deltaTestnetRestBase,
  deltaTestnetWsUrl,
  marketDataRestBase,
  directDeltaExecutionEnabled: false,
  // Keep private REST operations on the environment-specific API base. Public
  // scanner data has an explicit production feed, independent of execution mode.
  restBase: signalOnly ? 'https://api.india.delta.exchange' : 'https://cdn-ind.testnet.deltaex.org',
  publicWs: publicMarketDataWs,
  privateWs: signalOnly ? '' : 'wss://socket-ind.testnet.deltaex.org',
  apiKey: signalOnly ? '' : String(process.env.DELTA_TESTNET_API_KEY || '').trim(),
  apiSecret: signalOnly ? '' : String(process.env.DELTA_TESTNET_API_SECRET || '').trim(),
  engineSecret: process.env.ENGINE_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseAdminKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  workerId: process.env.WORKER_ID || ('delta-signal-worker-' + process.pid),
  tradetronBridgeEnabled: false,
  tradetronDynamicBridgeEnabled: false,
  // Fallback allowlist matches the reported 34-symbol Signal Bridge. An explicit
  // TRADETRON_SUPPORTED_SYMBOLS environment value remains authoritative; only list
  // symbols actually configured in the linked Tradetron strategy.
  tradetronSupportedSymbols: [...new Set(String(
    process.env.TRADETRON_SUPPORTED_SYMBOLS ||
    'AAPLXUSD,ADAUSD,ALGOUSD,AMDBUSD,AMZNXUSD,ATOMUSD,AVAXUSD,BCHUSD,BNBUSD,BTCUSD,CBRSBUSD,COINXUSD,CRCLXUSD,DOGEUSD,DRAMBUSD,ETHUSD,EWYBUSD,GOOGLXUSD,INTCBUSD,LINKUSD,LITEBUSD,LTCUSD,MATICUSD,METAXUSD,MSTRBUSD,MUBUSD,NBISBUSD,NEARUSD,PAXGUSD,SNDKBUSD,SOXLBUSD,SPCXXUSD,WDCBUSD,WIFUSD'
  ).split(',').map(x => x.trim().toUpperCase()).filter(x => /^[A-Z0-9]+USD$/.test(x)))],
  // If provided, this route table replaces the legacy single-token allowlist.
  // Each bridge id owns a distinct, fixed symbol set and linked API token.
  tradetronBridgeRoutes,
  // Options require a separately configured Tradetron strategy/token. Keep
  // this route disabled until that strategy exists and has been validated.
  tradetronOptionsBridgeEnabled: false,
  tradetronOptionsAuthToken: '',
  tradetronWebhookSecret: process.env.TRADETRON_WEBHOOK_SECRET || '',
  tradetronBaseUrl: process.env.TRADETRON_BASE_URL || 'https://api.tradetron.tech',
  // Read-only Developer API is separate from the signal-submission API base.
  tradetronDeveloperApiKey: '',
  tradetronDeveloperApiBaseUrl: String(process.env.TRADETRON_DEVELOPER_API_BASE_URL || 'https://tradetron.tech/api/v1').replace(/\/+$/, ''),
  tradetronDeveloperApiTimeoutMs: Number(process.env.TRADETRON_DEVELOPER_API_TIMEOUT_MS || 8000),
  tradetronAuthToken: '',
  tradetronTimeoutMs: Number(process.env.TRADETRON_TIMEOUT_MS || 10000),
  // Risk/sizing capital is denominated in USD. Default ~USD 51.5 corresponds to the project's INR 5,000 planning capital at ~INR 97/USD; override explicitly in USD when capital changes.
  tradetronCapitalUsd: Number(process.env.TRADETRON_CAPITAL_USD || 51.5)
});
