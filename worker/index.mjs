import { DeltaEngine } from './engine.mjs';
import { CONFIG } from '../server/config.js';
import * as db from '../server/db.js';
import { log } from '../server/db.js';
import { isGithubActionsPublicScanOnly } from './runtime-mode.mjs';
import { warmupBTCHourly } from './candle-warmup.mjs';
import { deltaExecutor } from './execution/delta-executor.mjs';
import { DeltaTestnetTracker } from './execution/delta-tracker.mjs';

const githubActionsPublicScanOnly = isGithubActionsPublicScanOnly();

if (!CONFIG.signalOnly || CONFIG.directDeltaExecutionEnabled) throw new Error('Scanner must run in SIGNAL_ONLY mode with direct Delta execution disabled.');
if (!CONFIG.engineSecret) throw new Error('ENGINE_SECRET is required.');
if (!CONFIG.tradetronBridgeEnabled && CONFIG.deltaExecutionMode !== 'testnet' && !githubActionsPublicScanOnly) {
  throw new Error('Tradetron signal bridge is required in SIGNAL_ONLY mode unless Delta Testnet execution or explicit GitHub Actions public scan-only mode is enabled.');
}
if (!CONFIG.supabaseUrl || !CONFIG.supabaseAdminKey) throw new Error('SUPABASE_URL / Supabase server key is required.');

const engine = new DeltaEngine();
let btcHourlyWarmupTimer = null;
let deltaTestnetTracker = null;

async function getOutboundIp() {
  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      headers: { 'User-Agent': 'DealDost-Delta-Preflight/2.0' }
    });
    if (!response.ok) return 'unavailable';
    const data = await response.json();
    return String(data.ip || 'unavailable');
  } catch {
    return 'unavailable';
  }
}

async function startupPreflight() {
  console.log('[DeltaScanner] Starting public-market signal scanner; DELTA_EXECUTION_MODE=' + CONFIG.deltaExecutionMode);
  try {
    const settings = await db.select('dd_settings', 'id=eq.1&select=id&limit=1');
    console.log('[DeltaScanner] Supabase connectivity OK; settings rows=' + (settings?.length || 0));
    await engine.adapter.health();
    console.log('[DeltaScanner] Delta India production public market API OK');
    if (CONFIG.deltaExecutionMode === 'testnet') {
      const [account, positions] = await Promise.all([
        deltaExecutor.getAccountSnapshot(),
        deltaExecutor.getOpenPositions()
      ]);
      engine.privateExecutionAvailable = true;
      console.log('[DeltaScanner] Authenticated Delta TESTNET API OK; equity=' + account.equity + '; open positions=' + positions.length);
    } else if (CONFIG.tradetronBridgeEnabled) {
      if (!engine.tradetron.isConfigured()) {
        console.warn('[DeltaScanner] Tradetron bridge enabled but auth token is missing; signals are blocked');
      } else {
        console.log('[DeltaScanner] Tradetron signal bridge enabled; Delta direct execution HARD LOCKED');
      }
      engine.privateExecutionAvailable = false;
    } else if (githubActionsPublicScanOnly) {
      engine.privateExecutionAvailable = false;
      console.log('[DeltaScanner] GitHub Actions public scan-only mode; Tradetron signal routing DISABLED; Delta direct execution HARD LOCKED');
    } else {
      try {
        await engine.adapter.wallet();
        engine.privateExecutionAvailable = true;
        console.log('[DeltaScanner] Delta authenticated TESTNET API OK');
      } catch (error) {
        const message = String(error?.message || error);
        if (message.includes('ip_not_whitelisted_for_api_key')) {
          engine.privateExecutionAvailable = false;
          console.warn('[DeltaScanner] Delta private API unavailable; scanner will remain online in public-data-only fail-safe mode');
          console.error('[DeltaScanner] Railway outbound public IP:', await getOutboundIp());
        } else {
          throw error;
        }
      }
    }
    return true;
  } catch (error) {
    const message = String(error?.message || error);
    console.error('[DeltaScanner] Startup preflight FAILED:', message);
    if (message.includes('ip_not_whitelisted_for_api_key')) {
      console.error('[DeltaScanner] Railway outbound public IP:', await getOutboundIp());
    }
    return false;
  }
}

process.on('SIGTERM', async () => { console.log('[DeltaScanner] SIGTERM received; stopping safely'); if (btcHourlyWarmupTimer) clearInterval(btcHourlyWarmupTimer); await deltaTestnetTracker?.stop(); await engine.stop(); process.exit(0); });
process.on('SIGINT', async () => { console.log('[DeltaScanner] SIGINT received; stopping safely'); if (btcHourlyWarmupTimer) clearInterval(btcHourlyWarmupTimer); await deltaTestnetTracker?.stop(); await engine.stop(); process.exit(0); });

process.on('unhandledRejection', async error => {
  console.error('[DeltaScanner] Unhandled rejection:', String(error?.message || error));
  await log('ERROR', 'Unhandled rejection; engine remains fail-closed', { error: String(error?.message || error) });
});
process.on('uncaughtException', async error => {
  console.error('[DeltaScanner] Uncaught exception:', error.message);
  await log('ERROR', 'Uncaught exception; worker exiting fail-closed', { error: error.message });
  try { await engine.stop(); } catch {}
  process.exit(1);
});

const preflightOk = await startupPreflight();
if (!preflightOk) process.exit(1);

async function runTradetronSelfTest() {
  if (CONFIG.deltaExecutionMode === 'testnet') return;
  if (String(process.env.TRADETRON_SELF_TEST || '').toLowerCase() !== 'true') return;
  if (!CONFIG.tradetronBridgeEnabled || !engine.tradetron.isConfigured()) {
    throw new Error('Tradetron self-test requires bridge enabled and a configured auth token');
  }
  const tickers = await engine.adapter.tickers();
  const btc = (Array.isArray(tickers) ? tickers : []).find(x => String(x.symbol || '').toUpperCase() === 'BTCUSD');
  const price = Number(btc?.mark_price || btc?.close || 0);
  if (!Number.isFinite(price) || price <= 0) throw new Error('BTCUSD public price unavailable for self-test');
  const sl = price * 0.99;
  const tp = price * 1.025;
  const result = await engine.tradetron.emitEntry({
    symbol: 'BTCUSD',
    side: 'BUY',
    qty: 1,
    entryPrice: price,
    sl,
    tp,
    executionId: 'TT-SELFTEST-BTCUSD'
  });
  console.log('[DeltaScanner] Tradetron self-test result:', JSON.stringify({
    ok: result.ok,
    symbol: result.symbol,
    side: result.side,
    qty: result.qty,
    triggerKey: result.triggerKey,
    responses: result.responses?.map(x => ({ key: x.key, ok: x.ok, skipped: x.skipped }))
  }));
}

await runTradetronSelfTest();

if (CONFIG.deltaExecutionMode === 'testnet') {
  deltaTestnetTracker = new DeltaTestnetTracker();
  await deltaTestnetTracker.start();
}

// Fetch the global BTC hourly regime data immediately, then refresh it hourly.
// This schedule is independent of the rotating 1m/5m/15m warmup and WebSocket.
await warmupBTCHourly(engine.adapter, engine.candles);
btcHourlyWarmupTimer = setInterval(() => {
  void warmupBTCHourly(engine.adapter, engine.candles);
}, 60 * 60 * 1000);
btcHourlyWarmupTimer.unref?.();

console.log('[DeltaScanner] Scanner worker entering engine loop; execution=' + CONFIG.deltaExecutionMode);
engine.run().catch(async error => {
  console.error('[DeltaScanner] Fatal worker startup error:', error.message);
  await log('ERROR', 'Fatal worker startup error', { error: error.message });
  process.exit(1);
});
