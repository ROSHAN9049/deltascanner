import { DeltaEngine } from './engine.mjs';
import { CONFIG } from '../server/config.js';
import * as db from '../server/db.js';
import { log } from '../server/db.js';

if (CONFIG.environment !== 'TESTNET') throw new Error('Production execution is disabled.');
if (!CONFIG.engineSecret) throw new Error('ENGINE_SECRET is required.');
if (!CONFIG.tradetronBridgeEnabled && (!CONFIG.apiKey || !CONFIG.apiSecret)) {
  throw new Error('DELTA_TESTNET_API_KEY / DELTA_TESTNET_API_SECRET are required for direct Delta execution.');
}
if (!CONFIG.supabaseUrl || !CONFIG.supabaseAdminKey) throw new Error('SUPABASE_URL / Supabase server key is required.');

const engine = new DeltaEngine();

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
  console.log('[DeltaScanner] Starting TESTNET worker preflight');
  try {
    const settings = await db.select('dd_settings', 'id=eq.1&select=id&limit=1');
    console.log('[DeltaScanner] Supabase connectivity OK; settings rows=' + (settings?.length || 0));
    await engine.adapter.health();
    console.log('[DeltaScanner] Delta public TESTNET API OK');
    if (CONFIG.tradetronBridgeEnabled) {
      if (!engine.tradetron.isConfigured()) {
        console.warn('[DeltaScanner] Tradetron bridge enabled but auth token is missing; execution is blocked until a new token is configured');
      } else {
        console.log('[DeltaScanner] Tradetron bridge mode enabled; Delta private API preflight skipped');
      }
    } else {
      await engine.adapter.wallet();
      console.log('[DeltaScanner] Delta authenticated TESTNET API OK');
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

process.on('SIGTERM', async () => { console.log('[DeltaScanner] SIGTERM received; stopping safely'); await engine.stop(); process.exit(0); });
process.on('SIGINT', async () => { console.log('[DeltaScanner] SIGINT received; stopping safely'); await engine.stop(); process.exit(0); });

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

console.log('[DeltaScanner] TESTNET worker entering engine loop');
engine.run().catch(async error => {
  console.error('[DeltaScanner] Fatal worker startup error:', error.message);
  await log('ERROR', 'Fatal worker startup error', { error: error.message });
  process.exit(1);
});
