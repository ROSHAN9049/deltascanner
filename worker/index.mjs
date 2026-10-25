import { createServer } from 'node:http';
import { DeltaEngine } from './engine.mjs';
import { CONFIG } from '../server/config.js';
import * as db from '../server/db.js';
import { log } from '../server/db.js';
import { isGithubActionsPublicScanOnly } from './runtime-mode.mjs';
import { warmupBTCHourly } from './candle-warmup.mjs';
import { deltaExecutor } from './execution/delta-executor.mjs';
import { DeltaTestnetTracker } from './execution/delta-tracker.mjs';
import { checkDeltaTestnetPrivateApi, DELTA_TESTNET_PRIVATE_API_RETRY_MS } from './execution/testnet-private-api-health.mjs';

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
let privateApiRetryTimer = null;
let privateApiProbeInFlight = null;
let shutdownPromise = null;
let workerHalted = false;
let fatalProcessError = null;

const requestedPort = Number(process.env.PORT || 8000);
const HTTP_PORT = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
  ? requestedPort : 8000;

// Lightweight platform health endpoint. This server exposes no account data and
// runs independently of the scanner's REST/WebSocket/background scan loop.
const keepAliveServer = createServer((request, response) => {
  request.resume();
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify({
    status: workerHalted ? 'degraded' : 'healthy',
    uptime: Number(process.uptime().toFixed(1)),
    worker: workerHalted ? 'parked-fail-closed' : 'running',
    ...(workerHalted && fatalProcessError ? { reason: fatalProcessError.message } : {})
  }));
});
keepAliveServer.on('error', error => {
  const details = processErrorDetails(error);
  console.error('[DeltaScanner] Keep-alive HTTP server error:', details.stack || details.message);
  void log('ERROR', 'Keep-alive HTTP server error', details).catch(logError => {
    console.error('[DeltaScanner] Could not persist HTTP server error:', String(logError?.message || logError));
  });
});
keepAliveServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('[DeltaScanner] Keep-alive HTTP server listening on 0.0.0.0:' + HTTP_PORT);
});

function processErrorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: String(error.stack || '').slice(0, 12000),
      code: error.code || null,
      status: Number.isFinite(Number(error.status)) ? Number(error.status) : null,
      cause: error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message, stack: String(error.cause.stack || '').slice(0, 3000) }
        : error.cause === undefined ? null : String(error.cause).slice(0, 1000)
    };
  }
  let serialized;
  try { serialized = JSON.stringify(error); } catch { serialized = String(error); }
  return {
    name: typeof error,
    message: String(error?.message || error || 'Unknown process error').slice(0, 2000),
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 12000) : null,
    detail: String(serialized || error).slice(0, 4000),
    code: error?.code || null,
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null
  };
}

async function closeKeepAliveServer() {
  if (!keepAliveServer.listening) return;
  await new Promise(resolve => keepAliveServer.close(() => resolve()));
}

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

async function verifyDeltaTestnetPrivateApi(reason = 'startup') {
  if (privateApiProbeInFlight) return privateApiProbeInFlight;
  privateApiProbeInFlight = (async () => {
    try {
      const { account, positions } = await checkDeltaTestnetPrivateApi(deltaExecutor);
      const wasAvailable = engine.privateExecutionAvailable;
      engine.privateExecutionAvailable = true;

      if (reason === 'startup') {
        console.log('[DeltaScanner] Authenticated Delta TESTNET API OK; equity=' + account.equity + '; open positions=' + positions.length);
      } else if (!wasAvailable) {
        console.log('[DeltaScanner] Delta Testnet private API restored; wallet and positions verified. Order execution unlocked.');
        await log('INFO', 'Delta Testnet private API restored; wallet and positions verified; order execution unlocked', {
          equity: account.equity,
          openPositions: positions.length
        }).catch(() => {});
      }

      if (!deltaTestnetTracker) {
        const tracker = new DeltaTestnetTracker();
        try {
          await tracker.start();
          deltaTestnetTracker = tracker;
        } catch (error) {
          try { await tracker.stop(); } catch {}
          console.warn('[DeltaScanner] Delta Testnet private tracker could not start; REST health checks will continue:', String(error?.message || error));
          await log('WARN', 'Delta Testnet private tracker could not start; REST health checks continue', {
            error: String(error?.message || error).slice(0, 240)
          }).catch(() => {});
        }
      }
      return true;
    } catch (error) {
      const message = String(error?.message || error);
      engine.privateExecutionAvailable = false;
      console.warn('[DeltaScanner] Private Delta Testnet API unavailable. Continuing in SCAN-ONLY mode.', message);
      await log('WARN', 'Private Delta Testnet API unavailable. Continuing in SCAN-ONLY mode.', {
        reason,
        error: message.slice(0, 240),
        executionLocked: true,
        retryMs: DELTA_TESTNET_PRIVATE_API_RETRY_MS
      }).catch(() => {});
      if (message.includes('ip_not_whitelisted_for_api_key')) {
        console.error('[DeltaScanner] Railway outbound public IP:', await getOutboundIp());
      }
      return false;
    } finally {
      privateApiProbeInFlight = null;
    }
  })();
  return privateApiProbeInFlight;
}

async function startupPreflight() {
  console.log('[DeltaScanner] Starting public-market signal scanner; DELTA_EXECUTION_MODE=' + CONFIG.deltaExecutionMode);
  try {
    const settings = await db.select('dd_settings', 'id=eq.1&select=id&limit=1');
    console.log('[DeltaScanner] Supabase connectivity OK; settings rows=' + (settings?.length || 0));
    await engine.adapter.health();
    console.log('[DeltaScanner] Delta India production public market API OK');
    if (CONFIG.deltaExecutionMode === 'testnet') {
      // Private API failures are non-fatal to the public scanner; execution stays locked
      // until a later wallet + positions verification succeeds.
      await verifyDeltaTestnetPrivateApi('startup');
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
    const details = processErrorDetails(error);
    const message = String(error?.message || error);
    console.error('[DeltaScanner] Startup preflight FAILED:', details.stack || details.message);
    await log('ERROR', 'Startup preflight failed with full error details', details).catch(logError => {
      console.error('[DeltaScanner] Could not persist startup preflight error:', String(logError?.message || logError));
    });
    if (message.includes('ip_not_whitelisted_for_api_key')) {
      console.error('[DeltaScanner] Railway outbound public IP:', await getOutboundIp());
    }
    return false;
  }
}

async function startupPreflightWithRetry() {
  let attempt = 0;
  while (!workerHalted && !shutdownPromise) {
    if (await startupPreflight()) return !workerHalted && !shutdownPromise;
    attempt += 1;
    const delayMs = Math.min(60_000, 5_000 * (2 ** Math.min(attempt - 1, 4)));
    console.warn('[DeltaScanner] Startup preflight retry scheduled; worker remains online', JSON.stringify({
      attempt,
      retryDelayMs: delayMs
    }));
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

async function runEngineWithRecovery() {
  let failureCount = 0;
  while (!workerHalted && !shutdownPromise) {
    try {
      await engine.run();
      if (workerHalted || shutdownPromise) return;
      throw new Error('Engine loop returned unexpectedly without a shutdown signal');
    } catch (error) {
      if (workerHalted || shutdownPromise) return;
      failureCount += 1;
      const details = processErrorDetails(error);
      const delayMs = Math.min(60_000, 5_000 * (2 ** Math.min(failureCount - 1, 4)));
      console.error('[DeltaScanner] Engine loop failed; worker remains alive and will retry:', details.stack || details.message);
      await log('ERROR', 'Engine loop failed; retry scheduled without process exit', {
        ...details,
        retryAttempt: failureCount,
        retryDelayMs: delayMs,
        pid: process.pid,
        uptimeSeconds: Number(process.uptime().toFixed(1))
      }).catch(logError => {
        console.error('[DeltaScanner] Could not persist engine retry error:', String(logError?.message || logError));
      });

      const trackerToStop = deltaTestnetTracker;
      deltaTestnetTracker = null;
      const cleanupResults = await Promise.allSettled([
        Promise.resolve().then(() => trackerToStop?.stop()),
        Promise.resolve().then(() => engine.stop())
      ]);
      for (const result of cleanupResults) {
        if (result.status === 'rejected') {
          console.error('[DeltaScanner] Engine retry cleanup failed:', processErrorDetails(result.reason).stack || String(result.reason));
        }
      }
      if (!workerHalted && !shutdownPromise) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
}

async function shutdownWorker(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.warn('[DeltaScanner] ' + signal + ' received; stopping safely', JSON.stringify({
      pid: process.pid,
      uptimeSeconds: Number(process.uptime().toFixed(1)),
      httpHealthServerListening: keepAliveServer.listening,
      privateApiAvailable: engine.privateExecutionAvailable
    }));
    if (btcHourlyWarmupTimer) clearInterval(btcHourlyWarmupTimer);
    if (privateApiRetryTimer) clearInterval(privateApiRetryTimer);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => deltaTestnetTracker?.stop()),
      Promise.resolve().then(() => engine.stop())
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[DeltaScanner] Shutdown cleanup failed:', processErrorDetails(result.reason).stack || String(result.reason));
      }
    }
    await closeKeepAliveServer().catch(error => {
      console.error('[DeltaScanner] Keep-alive HTTP shutdown failed:', processErrorDetails(error).stack || String(error));
    });
    console.log('[DeltaScanner] Graceful shutdown finished; exitCode=0');
    process.exit(0);
  })();
  return shutdownPromise;
}

process.on('SIGTERM', () => {
  void shutdownWorker('SIGTERM').catch(error => {
    console.error('[DeltaScanner] SIGTERM shutdown failed:', processErrorDetails(error).stack || String(error));
    process.exit(1);
  });
});
process.on('SIGINT', () => {
  void shutdownWorker('SIGINT').catch(error => {
    console.error('[DeltaScanner] SIGINT shutdown failed:', processErrorDetails(error).stack || String(error));
    process.exit(1);
  });
});

process.on('exit', code => {
  console.warn('[DeltaScanner] Process exit event', JSON.stringify({
    exitCode: code, pid: process.pid, uptimeSeconds: Number(process.uptime().toFixed(1))
  }));
});

process.on('unhandledRejection', (reason, promise) => {
  const details = processErrorDetails(reason);
  console.error('[DeltaScanner] Unhandled promise rejection:', details.stack || details.message, {
    code: details.code, status: details.status
  });
  if (CONFIG.deltaExecutionMode === 'testnet') {
    engine.privateExecutionAvailable = false;
    console.error('[DeltaScanner] Private execution locked after unhandled rejection; scanner will continue fail-closed.');
  }
  void log('ERROR', 'Unhandled promise rejection; exact rejection captured and private execution fail-closed', {
    ...details,
    pid: process.pid,
    uptimeSeconds: Number(process.uptime().toFixed(1)),
    promiseType: typeof promise
  }).catch(logError => {
    console.error('[DeltaScanner] Could not persist unhandled rejection:', String(logError?.message || logError));
  });
});
process.on('uncaughtException', (error, origin) => {
  const details = processErrorDetails(error);
  if (workerHalted) {
    console.error('[FATAL] Additional uncaught exception while worker is already parked:', details.message, details.stack || '');
    return;
  }

  // Do not resume trading after an uncaught exception. Park the scanner fail-closed,
  // release its resources, and keep the HTTP listener alive for platform health checks.
  workerHalted = true;
  fatalProcessError = { name: details.name, message: details.message };
  engine.privateExecutionAvailable = false;
  console.error('[FATAL] Uncaught Exception:', details.message, details.stack || '', JSON.stringify({
    origin,
    pid: process.pid,
    uptimeSeconds: Number(process.uptime().toFixed(1)),
    scannerState: 'parked-fail-closed'
  }));

  if (btcHourlyWarmupTimer) clearInterval(btcHourlyWarmupTimer);
  if (privateApiRetryTimer) clearInterval(privateApiRetryTimer);

  void (async () => {
    try {
      await log('ERROR', 'Uncaught exception; exact stack captured before fail-closed exit of scanner loop; process remains alive', {
        ...details,
        origin,
        pid: process.pid,
        uptimeSeconds: Number(process.uptime().toFixed(1)),
        scannerState: 'parked-fail-closed'
      });
    } catch (logError) {
      console.error('[DeltaScanner] Could not persist uncaught exception:', String(logError?.message || logError));
    }

    try { await deltaTestnetTracker?.stop(); } catch (stopError) {
      console.error('[DeltaScanner] Private tracker cleanup after uncaught exception failed:', String(stopError?.message || stopError));
    }
    try { await engine.stop(); } catch (stopError) {
      console.error('[DeltaScanner] Engine cleanup after uncaught exception failed:', String(stopError?.message || stopError));
    }
    console.error('[DeltaScanner] Worker parked in fail-closed mode; HTTP health listener remains available.');
  })().catch(handlerError => {
    console.error('[FATAL] Fail-closed exception handler cleanup failed:', processErrorDetails(handlerError).stack || String(handlerError));
  });
});

const preflightOk = await startupPreflightWithRetry();
if (preflightOk && !workerHalted) {

if (CONFIG.deltaExecutionMode === 'testnet') {
  privateApiRetryTimer = setInterval(() => {
    if (engine.privateExecutionAvailable) return;
    void verifyDeltaTestnetPrivateApi('retry').catch(error => {
      console.error('[DeltaScanner] Delta Testnet private API retry failed safely:', String(error?.message || error));
    });
  }, DELTA_TESTNET_PRIVATE_API_RETRY_MS);
  privateApiRetryTimer.unref?.();
}

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

try {
  await runTradetronSelfTest();
} catch (error) {
  const details = processErrorDetails(error);
  console.warn('[DeltaScanner] Optional Tradetron self-test failed; worker startup will continue without the test signal:', details.stack || details.message);
  await log('WARN', 'Optional Tradetron self-test failed; worker continues without test signal', details).catch(logError => {
    console.error('[DeltaScanner] Could not persist self-test warning:', String(logError?.message || logError));
  });
}

// Fetch the global BTC hourly regime data immediately, then refresh it hourly.
// This schedule is independent of the rotating 1m/5m/15m warmup and WebSocket.
if (!workerHalted && !shutdownPromise) {
  await warmupBTCHourly(engine.adapter, engine.candles).catch(error => {
    console.warn('[DeltaScanner] Initial BTC hourly warmup failed; worker will continue and retry on the next scheduled refresh:', String(error?.message || error));
  });
}
if (!workerHalted && !shutdownPromise) {
  btcHourlyWarmupTimer = setInterval(() => {
    void warmupBTCHourly(engine.adapter, engine.candles).catch(error => {
      console.warn('[DeltaScanner] Scheduled BTC hourly warmup failed:', String(error?.message || error));
    });
  }, 60 * 60 * 1000);
  btcHourlyWarmupTimer.unref?.();

  console.log('[DeltaScanner] Scanner worker entering engine loop; execution=' + CONFIG.deltaExecutionMode);
  void runEngineWithRecovery();
} else {
  console.warn('[DeltaScanner] Shutdown requested or fatal state latched during startup; engine launch skipped.');
}
} else {
  console.error('[DeltaScanner] Worker is parked; engine startup skipped.');
}
