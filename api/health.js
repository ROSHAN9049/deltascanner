import { CONFIG } from '../server/config.js';
import { select } from '../server/db.js';

export default async function handler(req, res) {
  try {
    // Health must be driven by the worker's durable heartbeat in Supabase.
    // Do not call Delta /v2/tickers here: the dashboard already polls market data
    // separately, and an extra exchange request can be rate-limited and create a
    // false "worker offline" state even while the worker is healthy.
    const settings = (await select(
      'dd_settings',
      'id=eq.1&select=last_tick_at,worker_started_at,updated_at'
    ))?.[0] || {};
    const lease = (await select(
      'dd_engine_lease',
      'id=eq.1&select=worker_id,expires_at,heartbeat_at'
    ))?.[0] || {};

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
      exchange: 'Delta Exchange India Demo',
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
      error: e.message
    });
  }
}
