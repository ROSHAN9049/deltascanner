import { DeltaEngine } from './engine.mjs';
import { CONFIG } from '../server/config.js';
import { log } from '../server/db.js';

if (CONFIG.environment !== 'TESTNET') throw new Error('Production execution is disabled.');
if (!CONFIG.engineSecret) throw new Error('ENGINE_SECRET is required.');
if (!CONFIG.apiKey || !CONFIG.apiSecret) throw new Error('DELTA_TESTNET_API_KEY / DELTA_TESTNET_API_SECRET are required.');
if (!CONFIG.supabaseUrl || !CONFIG.supabaseServiceRoleKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required.');

const engine = new DeltaEngine();

process.on('SIGTERM', async () => { await engine.stop(); process.exit(0); });
process.on('SIGINT', async () => { await engine.stop(); process.exit(0); });

process.on('unhandledRejection', async error => {
  await log('ERROR', 'Unhandled rejection; engine remains fail-closed', { error: String(error?.message || error) });
});
process.on('uncaughtException', async error => {
  await log('ERROR', 'Uncaught exception; worker exiting fail-closed', { error: error.message });
  try { await engine.stop(); } catch {}
  process.exit(1);
});

engine.run().catch(async error => {
  await log('ERROR', 'Fatal worker startup error', { error: error.message });
  process.exit(1);
});
