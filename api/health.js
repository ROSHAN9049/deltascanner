import { CONFIG } from '../server/config.js';
import { select } from '../server/db.js';
import { summarizeRetentionHealth } from '../src/retention-health.js';
import { getDeltaTestnetHealth } from '../server/delta-testnet-health.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  try {
    // Exchange health is an independent, cached probe of Delta TESTNET's public
    // products endpoint. Lease and heartbeat fields remain separate worker-health
    // observations so lease expiry cannot masquerade as exchange unavailability.
    const [settingsRows, leaseRows, retentionLogs, exchangeProbe] = await Promise.all([
      select('dd_settings', 'id=eq.1&select=last_tick_at,worker_started_at,updated_at'),
      select('dd_engine_lease', 'id=eq.1&select=worker_id,expires_at,heartbeat_at'),
      select(
        'dd_engine_logs',
        'message=eq.%5BRetention%5D%20Run%20summary&select=created_at,message,data&order=created_at.desc&limit=100'
      ).catch(error => {
        console.error('[health] Retention telemetry unavailable:', error.message);
        return [];
      }),
      getDeltaTestnetHealth()
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

    // These flags intentionally report independent facts: an exchange can be
    // reachable even while a worker lease is expired, and a live lease cannot
    // prove the exchange API is reachable.
    const exchangeHealthy = exchangeProbe?.healthy === true;

    return res.status(200).json({
      success: true,
      environment: CONFIG.environment,
      exchange: CONFIG.signalOnly ? 'Delta Exchange India · Production Market Feed' : 'Delta Exchange India Demo',
      exchangeHealthy,
      exchangeProbeAt: exchangeProbe?.checkedAt || null,
      exchangeProbeStatus: exchangeProbe?.status ?? null,
      exchangeProbeSource: exchangeProbe?.source || 'delta-testnet-public-api',
      exchangeProbeError: exchangeProbe?.healthy === true ? null : exchangeProbe?.error || 'Delta Testnet health probe unavailable',
      exchangeProbeCached: exchangeProbe?.cached === true,
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
      exchangeProbeAt: null,
      exchangeProbeStatus: null,
      exchangeProbeSource: 'delta-testnet-public-api',
      exchangeProbeError: 'Health endpoint failed before a verified exchange response was available',
      tickFresh: false,
      heartbeatFresh: false,
      workerLeaseActive: false,
      retention: summarizeRetentionHealth([], { defaultConfigDays: 1 }),
      error: e.message
    });
  }
}
