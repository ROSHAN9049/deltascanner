import { CONFIG } from '../server/config.js';
import { select } from '../server/db.js';
import { publicGet } from '../server/public.js';

export default async function handler(req, res) {
  try {
    const publicResult = await publicGet('/v2/tickers', { contract_types: 'perpetual_futures' });
    const settings = (await select('dd_settings', 'id=eq.1&select=last_tick_at,worker_started_at,last_tick_at,updated_at'))?.[0] || {};
    const lease = (await select('dd_engine_lease', 'id=eq.1&select=worker_id,expires_at,heartbeat_at'))?.[0] || {};
    const serverMs = publicResult.date ? Date.parse(publicResult.date) : null;
    const workerTickMs = settings.last_tick_at ? Date.parse(settings.last_tick_at) : null;
    return res.status(200).json({
      success: true,
      environment: CONFIG.environment,
      exchange: 'Delta Exchange India Demo',
      exchangeHealthy: true,
      timeDriftMs: Number.isFinite(serverMs) ? serverMs - Date.now() : null,
      lastTickAt: settings.last_tick_at || null,
      workerStartedAt: settings.worker_started_at || null,
      workerId: lease.worker_id || null,
      workerHeartbeat: lease.heartbeat_at || null,
      workerLeaseActive: !!(lease.expires_at && new Date(lease.expires_at) > new Date()),
      tickFresh: !!(workerTickMs && Date.now() - workerTickMs < 180000),
      now: new Date().toISOString()
    });
  } catch (e) {
    return res.status(503).json({ success: false, environment: 'TESTNET', exchangeHealthy: false, error: e.message });
  }
}