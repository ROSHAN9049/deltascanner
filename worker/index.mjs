import { DeltaEngine } from './engine.mjs';
import { CONFIG } from '../server/config.js';
import * as db from '../server/db.js';
import { log } from '../server/db.js';

if (CONFIG.environment !== 'TESTNET') throw new Error('Production execution is disabled.');
if (!CONFIG.engineSecret) throw new Error('ENGINE_SECRET is required.');
if (!CONFIG.apiKey || !CONFIG.apiSecret) throw new Error('DELTA_TESTNET_API_KEY / DELTA_TESTNET_API_SECRET are required.');
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
    await engine.adapter.wallet();
    console.log('[DeltaScanner] Delta authenticated TESTNET API OK');
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function maintainExecutionPreflight() {
  let first = true;
  while (true) {
    const ok = await startupPreflight();
    if (ok) {
      await engine.setExecutionReadiness(true);
      console.log(first
        ? '[DeltaScanner] TESTNET execution preflight OK; execution gate is READY'
        : '[DeltaScanner] TESTNET execution preflight recovered; execution gate is READY');
      await sleep(300_000);
    } else {
      await engine.setExecutionReadiness(false, 'ip_not_whitelisted_for_api_key');
      console.log('[DeltaScanner] Public market scanning remains active; execution stays BLOCKED until preflight succeeds');
      await sleep(60_000);
    }
    first = false;
  }
}

console.log('[DeltaScanner] TESTNET worker entering market scanner loop; execution preflight runs independently');
await engine.setExecutionReadiness(false, 'STARTUP_PREFLIGHT_PENDING');

engine.run().catch(async error => {
  console.error('[DeltaScanner] Fatal worker startup error:', error.message);
  await log('ERROR', 'Fatal worker startup error', { error: error.message });
  process.exit(1);
});

void maintainExecutionPreflight();
