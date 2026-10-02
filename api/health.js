import { CONFIG } from '../server/config.js';
import { select } from '../server/db.js';

export default async function handler(req, res) {
  try {
    const settings = (await select('dd_settings', 'id=eq.1&select=last_tick_at,worker_started_at,updated_at'))?.[0] || {};
    const lease = (await select('dd_engine_lease', 'id=eq.1&select=worker_id,expires_at,heartbeat_at'))?.[0] || {};
    const workerLeaseActive = !!(lease.expires_at && new Date(lease.expires_at) > new Date());
    const workerTickMs = settings.last_tick_at ? Date.parse(settings.last_tick_at) : NaN;
    const tickFresh = Number.isFinite(workerTickMs) && Date.now() - workerTickMs < 180000;
    const scanOnly = CONFIG.scanOnly;
    const exchangeHealthy = scanOnly ? tickFresh : workerLeaseActive && tickFresh;
    return res.status(200).json({
      success: true,
      environment: CONFIG.environment,
      exchange: 'Delta Exchange India Demo',
      scanOnly,
      executionReady: scanOnly ? false : workerLeaseActive && tickFresh,
      exchangeHealthy,
      timeDriftMs: null,
      lastTickAt: settings.last_tick_at || null,
      workerStartedAt: settings.worker_started_at || null,
      workerId: lease.worker_id || null,
      workerHeartbeat: lease.heartbeat_at || null,
      workerLeaseActive,
      tickFresh,
      marketDataFresh: tickFresh,
      now: new Date().toISOString()
    });
  } catch (e) {
    return res.status(503).json({ success: false, environment: 'TESTNET', exchangeHealthy: false, tickFresh: false, error: e.message });
  }
}