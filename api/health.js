import { CONFIG } from '../server/config.js';
import { select } from '../server/db.js';
import { summarizeRetentionHealth } from '../src/retention-health.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  try {
    // Health must be driven by the worker's durable heartbeat in Supabase.
    // Do not call Delta /v2/tickers here: the dashboard already polls market data
    // separately, and an extra exchange request can be rate-limited and create a
    // false "worker offline" state even while the worker is healthy.
    const [settingsRows, leaseRows, retentionLogs] = await Promise.all([
      select('dd_settings', 'id=eq.1&select=last_tick_at,worker_started_at,updated_at'),
      select('dd_engine_lease', 'id=eq.1&select=worker_id,expires_at,heartbeat_at'),
      select(
        'dd_engine_logs',
        'message=eq.%5BRetention%5D%20Run%20summary&select=created_at,message,data&order=created_at.desc&limit=100'
      ).catch(error => {
        console.error('[health] Retention telemetry unavailable:', error.message);
        return [];
      })
    ]);
    const settings = settingsRows?.[0] || {};
    const lease = leaseRows?.[0] || {};
    const retention = summarizeRetentionHealth(retentionLogs, { defaultConfigDays: 1 });

    const nowMs = Date.now();
    const workerTickMs = settings.last_tick_at ? Date.parse(settings.last_tick_at) : null;
    const heartbeatMs = lease.heartbeat_at ? Date.parse(lease.heartbeat_at) : null;
    const leaseExpiresMs = lease.expires_at ? Date.parse(lease.expires_at) : null;

    const tickAgeMs = Number.isFinite(workerTickMs) ? Math.max(0, nowMs - workerTickMs) : null;
    const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Math.max(0, nowMs - heartbeatMs) : null;
    const workerLeaseActive = Number.isFinite(leaseExpiresMs) && leaseExpiresMs > nowMs;
    const tickFresh = Number.isFinite(tickAgeMs) && tickAgeMs < 180000;
    const heartbeatFresh = Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs < 180000;

    // The worker's durable tick is the authoritative evidence that the market
    // loop is alive. Exchange health therefore remains fail-closed: if the
    // worker heartbeat/tick is stale, entries are blocked.
    const exchangeHealthy = !!(tickFresh && heartbeatFresh && workerLeaseActive);

    return res.status(200).json({
      success: true,
      environment: CONFIG.environment,
      exchange: CONFIG.signalOnly ? 'Delta Exchange India · Production Market Feed' : 'Delta Exchange India Demo',
      exchangeHealthy,
      timeDriftMs: null,
      lastTickAt: settings.last_tick_at || null,
      workerStartedAt: settings.worker_started_at || null,
      workerId: lease.worker_id || null,
      workerHeartbeat: lease.heartbeat_at || null,
      workerLeaseActive,
      tickFresh,
      heartbeatFresh,
      tickAgeMs,
      heartbeatAgeMs,
      leaseRemainingMs: workerLeaseActive ? leaseExpiresMs - nowMs : 0,
      retention,
      now: new Date().toISOString(),
      source: 'supabase-worker-heartbeat'
    });
  } catch (e) {
    return res.status(503).json({
      success: false,
      environment: 'TESTNET',
      exchangeHealthy: false,
      tickFresh: false,
      workerLeaseActive: false,
      retention: summarizeRetentionHealth([], { defaultConfigDays: 1 }),
      error: e.message
    });
  }
}
