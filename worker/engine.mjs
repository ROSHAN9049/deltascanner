import crypto from 'node:crypto';
import WebSocket from 'ws';
import { CONFIG } from '../server/config.js';
import { DeltaAdapter } from './delta-adapter.mjs';
import { analyse, analyseOption, trimDetails, atr as calculateAtr, calculateNormalizedScores } from './strategy.mjs';
import { calculateCreditSpreadSizing, calculateLongOptionSizing, parseDeltaOptionSymbol, selectOptionContractsForScan } from './execution/delta-options-policy.mjs';
import * as db from '../server/db.js';
import { SIGNAL_RESERVATION_TTL_MS, TradetronBridge, withSignalReservations } from '../server/tradetron.js';
import { buildTradetronPnlHistoryRows, TradetronDeveloperApi } from '../server/tradetron-developer-api.mjs';
import { buildTradetronSnapshotRiskState, TRADETRON_SNAPSHOT_MAX_AGE_MS } from '../src/tradetron-position-sync.js';
import { indiaDateKey } from '../src/date-utils.js';
import { createGridState, evaluateGridTick } from './grid-strategy.mjs';
import { CANDLE_WARMUP_BATCH_SIZE, CANDLE_WARMUP_RETRY_MS, CANDLE_TESTNET_WARMUP_BATCH_SIZE, CANDLE_TESTNET_WARMUP_CONCURRENCY, CANDLE_TESTNET_WARMUP_RETRY_MS, planCandleWarmup } from './candle-warmup.mjs';
import { shouldWriteMarketCache } from './market-cache-policy.mjs';
import { MIN_RAW_CANDLES_FOR_ATR, mergeCandleUpdate, normalizeCandleBatch, normalizeEpochSeconds, candleMaxAgeIntervals } from './candle-normalization.mjs';
import { detectAtrSpike, replaceOutlierCandleWithPrevious } from './atr-spike-guard.mjs';
import { shouldEmitThrottledLog, websocketReconnectDelay, WS_ERROR_LOG_COOLDOWN_MS } from './ws-resilience.mjs';
import { isOptionsExecutionAllowed, OPTIONS_EXECUTION_LOCK_REASON } from './options-execution-lock.mjs';
import { classifyTradetronSignalFailure, sanitizeTradetronFailureDetail } from './signal-failure-diagnostics.mjs';
import { gateBTCRegime } from '../src/indicators/risk-gates.mjs';
import { buildApiDerivedTrackingPlan, strategyForDerivedTrade } from './tradetron-derived-trades.mjs';
import { deltaExecutor } from './execution/delta-executor.mjs';
import { manageDeltaTestnetGrid } from './execution/delta-grid-engine.mjs';
import { assertDirectDeltaExecutionMode, getExecutionRouteBlockReason } from './execution/execution-route-policy.mjs';
import { canExecuteDeltaTestnetOrders, checkDeltaTestnetPrivateApi, isPrivateApiConnectivityError } from './execution/testnet-private-api-health.mjs';
import { DEFAULT_CANDLE_CACHE_SYMBOL_LIMIT, pruneCandleCacheState, resolveCandleCacheSymbolLimit, selectTopCandleSymbols } from './candle-cache-policy.mjs';
import { formatMemoryLog, MEMORY_LOG_INTERVAL_MS, summarizeMemoryUsage } from './memory-monitor.mjs';
import { cleanupWebSocketListeners } from './websocket-lifecycle.mjs';
import { evaluateGlobalPositionCap, routeUnlessGlobalPositionCapBlocked } from './global-position-cap.mjs';
import { createConfirmedSignalTelegramNotifier } from './telegram-alerts.mjs';
import { createLeaseManager, getLeaseTtlSeconds } from './lease-manager.mjs';
import { createDeltaOptionsExecutor } from './execution/delta-options-executor.mjs';
import { createDeltaOptionsExecutionManager } from './execution/delta-options-execution-manager.mjs';
import { createDeltaOptionsOrderLedger } from './execution/delta-options-order-ledger.mjs';
import { createDeltaOptionsOrderCoordinator } from './execution/delta-options-order-coordinator.mjs';
import { createDeltaOptionsSupervisor } from './execution/delta-options-supervisor.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = v => Number.isFinite(+v) ? +v : 0;
const iso = () => new Date().toISOString();
const today = () => indiaDateKey(new Date());
const sideExit = side => side === 'BUY' ? 'sell' : 'buy';
const clientId = (prefix, symbol) => (prefix + '-' + symbol.slice(0, 12) + '-' + Date.now().toString(36)).slice(0, 32);
const roundDown = (v, step) => {
  const s = Math.max(1, n(step) || 1);
  return Math.floor(v / s) * s;
};
const roundTick = (v, tick) => tick > 0 ? Math.round(v / tick) * tick : v;
export const OPTION_UNDERLYINGS = Object.freeze(['BTC', 'ETH', 'XAUT']);

export function correlationGroupForSymbol(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/USD$/, '');
  if (['BTC', 'ETH', 'SOL', 'BNB'].includes(s)) return 'MAJORS';
  if (['PAXG', 'XAUT'].includes(s)) return 'GOLD';
  if (['DOGE', 'SHIB', 'WIF'].includes(s)) return 'MEME';
  // Explicitly cover stock-token roots that do not end in X, including AMDBUSD.
  if (/^(AMDB|QQQX|SNDKB|TSLAX|AAPLX|AMZNX|COINX|METAX|MSFTX|NVDAX|GOOGLX|NFLXX|MSTRX)/.test(s.replace(/\s/g,''))) return 'STOCK_TOKENS';
  // Common equity-token suffixes: classify unknown listed equity tokens conservatively.
  if (/^[A-Z]{2,8}X$/.test(s) || /^(AMDB|QQQ|TSLA|AAPL|NVDA|SNDK|MSFT|AMZN|GOOGL|META|NFLX|MSTR)/.test(s)) return 'STOCK_TOKENS';
  return null;
}

export function assessCorrelatedEntry({ symbol, side, positions = [], maxSameSide = 3, aggressive = false }) {
  const wantedSide = String(side || '').toUpperCase();
  const sameSideCount = positions.filter(p => String(p.side || (Number(p.size ?? p.qty) < 0 ? 'SELL' : 'BUY')).toUpperCase() === wantedSide
    && Math.abs(Number(p.qty ?? p.size) || 0) > 0).length;
  if (sameSideCount >= maxSameSide) return { blocked: true, reason: 'MAX_SAME_SIDE_POSITIONS', sameSideCount, group: correlationGroupForSymbol(symbol) };
  if (aggressive) return { blocked: false, reason: null, sameSideCount, group: correlationGroupForSymbol(symbol) };
  const group = correlationGroupForSymbol(symbol);
  if (group) {
    const conflict = positions.find(p => correlationGroupForSymbol(p.symbol || p.product_symbol) === group
      && Math.abs(Number(p.qty ?? p.size) || 0) > 0);
    if (conflict) return { blocked: true, reason: 'CORRELATION_GROUP_LIMIT', sameSideCount, group, conflictingSymbol: String(conflict.symbol || conflict.product_symbol).toUpperCase() };
  }
  return { blocked: false, reason: null, sameSideCount, group };
}


function envBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.warn(`[Config] Invalid ${name}; using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function hasMaintenanceDatabaseUrl() {
  return [process.env.DATABASE_URL, process.env.SUPABASE_DB_URL]
    .some(value => typeof value === 'string' && value.trim().length > 0);
}

function safeMaintenanceError(error) {
  let message = String(error?.message || error || 'Unknown maintenance error');
  if (process.env.DATABASE_URL) message = message.split(process.env.DATABASE_URL).join('[REDACTED]');
  if (process.env.SUPABASE_DB_URL) message = message.split(process.env.SUPABASE_DB_URL).join('[REDACTED]');
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'\x60]+/gi, '[REDACTED DATABASE URL]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}

const RETENTION_ENABLED = envBoolean('RETENTION_ENABLED', true);
const RETENTION_DAYS = envInteger('RETENTION_DAYS', 1, 1, 3650);
const RETENTION_BATCH_SIZE = envInteger('RETENTION_BATCH_SIZE', 5000, 1, 5000);
const DEDUP_ENABLED = envBoolean('DEDUP_ENABLED', true);
// Bound persistent analytics history for a symbol/strategy across all stage/side transitions.
// This affects historical sampling only; scan decisions, stage calculation, and routing are unchanged.
const SIGNAL_HISTORY_SAMPLE_MINUTES = envInteger('SIGNAL_HISTORY_SAMPLE_MINUTES', 120, 1, 1440);
const DEDUP_CACHE_MAX = envInteger('DEDUP_CACHE_MAX', 5000, 1, 100000);
const DISK_WARN_ROWS = envInteger('DISK_WARN_ROWS', 250000, 1, 1000000000);
const DISK_CRITICAL_ROWS = envInteger('DISK_CRITICAL_ROWS', 500000, 1, 1000000000);
const RETENTION_OLD_ROWS_TRIGGER = envInteger('RETENTION_OLD_ROWS_TRIGGER', 50000, 1, 1000000000);
// Pause bulky signal-history writes with at least 20 MiB of headroom below the 400 MiB operational target.
// Keep the configured value capped even if the deployment still defines an older 430 MiB value.
const SIGNAL_HISTORY_PAUSE_DB_MB = envInteger('SIGNAL_HISTORY_PAUSE_DB_MB', 370, 300, 380);
const SIGNAL_HISTORY_RESUME_DB_MB = Math.max(280, SIGNAL_HISTORY_PAUSE_DB_MB - 20);
const MAINTENANCE_START_DELAY_MS = 5 * 60 * 1000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DISK_MONITOR_INTERVAL_MS = 30 * 60 * 1000;
const MB_BYTES = 1024 * 1024;
const SIGNAL_RETENTION_DELETE_SQL = `
  WITH batch AS (
    SELECT id
    FROM public.dd_signals
    WHERE captured_at < NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY captured_at ASC
    LIMIT $2::int
  )
  DELETE FROM public.dd_signals AS target
  USING batch
  WHERE target.id = batch.id
  RETURNING target.id
`;
const ENGINE_LOG_RETENTION_DELETE_SQL = `
  WITH batch AS (
    SELECT id
    FROM public.dd_engine_logs
    WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY created_at ASC
    LIMIT $2::int
  )
  DELETE FROM public.dd_engine_logs AS target
  USING batch
  WHERE target.id = batch.id
  RETURNING target.id
`;

export function duplicatePositionBlocker(openPositions, symbol) {
  const selected = String(symbol || '').toUpperCase();
  return (Array.isArray(openPositions) ? openPositions : []).some(position =>
    String(position?.symbol || '').toUpperCase() === selected && n(position?.qty) > 0
  ) ? 'Duplicate symbol' : '';
}

export function tradetronRouteBlocker({ signalOnly, bridgeEnabled, strategy, signal, bridge }) {
  const engine = String(strategy || '').toUpperCase();
  if (!signalOnly || !['MOMENTUM', 'SCALPING'].includes(engine)) return '';
  if (String(signal?.stage || '').toUpperCase() !== 'CONFIRMED' || !signal?.side) return '';
  if (bridgeEnabled && bridge && typeof bridge.isConfigured === 'function' && bridge.isConfigured()) return '';
  return 'Tradetron route unavailable: ' + String(signal?.symbol || '').toUpperCase();
}

const cleanPrice = v => {
  const x = n(v);
  if (!(x > 0)) return String(v);
  return x.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
};

export class DeltaEngine {
  constructor() {
    this.adapter = new DeltaAdapter();
    this.tradetron = new TradetronBridge();
    this.tradetronDeveloperApi = new TradetronDeveloperApi();
    this.lastTradetronDeveloperSyncAt = 0;
    this.lastTradetronDeveloperPnlCleanupAt = 0;
    this.lastTradetronSnapshotRiskState = null;
    this.lastTradetronSnapshotRiskStateAt = 0;
    this.tradetronSnapshotRiskStateInFlight = null;
    this.lastTradetronEntrySafetyLogAt = 0;
    this.lastGridEntrySafety = null;
    this.lastGridTestnetSkipLogAt = 0;
    this.lastTestnetExecutionLockLogAt = 0;
    this.lastSignalReservationExpiryAt = 0;
    this.tradetronDeveloperSyncInFlight = null;
    this.tradetronDeveloperApiStatus = CONFIG.tradetronDeveloperApiKey ? 'WAITING_FOR_FIRST_SYNC' : 'NOT_CONFIGURED';
    this.tradetronOptions = new TradetronBridge({ enabled: CONFIG.tradetronOptionsBridgeEnabled, authToken: CONFIG.tradetronOptionsAuthToken });
    this.tradetronRouteBridges = new Map((CONFIG.tradetronBridgeRoutes || []).map(route => [
      route.id,
      new TradetronBridge({ enabled: CONFIG.tradetronBridgeEnabled, authToken: route.authToken, supportedSymbols: route.symbols })
    ]));
    this.unsupportedBridgeWarnings = new Set();
    this.leaseId = crypto.randomUUID();
    this.leaseManager = createLeaseManager({
      leaseId: this.leaseId,
      workerId: CONFIG.workerId,
      ttlSeconds: getLeaseTtlSeconds(),
      renewEveryMs: 15_000,
      acquireFn: async ({ leaseId, workerId, ttlSeconds }) => {
        const result = await db.rpc('acquire_dd_lease', {
          p_lease_id: leaseId,
          p_worker_id: workerId,
          p_ttl_seconds: ttlSeconds
        });
        return Array.isArray(result)
          ? result.some(value => value === true || value?.acquire_dd_lease === true)
          : result === true;
      },
      renewFn: async ({ leaseId, workerId, ttlSeconds }) => {
        const result = await db.rpc('acquire_dd_lease', {
          p_lease_id: leaseId,
          p_worker_id: workerId,
          p_ttl_seconds: ttlSeconds
        });
        return Array.isArray(result)
          ? result.some(value => value === true || value?.acquire_dd_lease === true)
          : result === true;
      },
      releaseFn: async ({ leaseId }) => {
        const result = await db.rpc('release_dd_lease', { p_lease_id: leaseId });
        return Array.isArray(result)
          ? result.some(value => value === true || value?.release_dd_lease === true)
          : result === true;
      },
      onError: async error => {
        await this.log('ERROR', 'Trading lease manager operation failed', {
          workerId: CONFIG.workerId,
          leaseTtlSeconds: this.leaseManager?.ttlSeconds ?? null,
          leaseHeld: this.leaseManager?.isHeld ?? false,
          error: String(error?.message || error).slice(0, 240)
        });
      },
      onLeaseLost: async error => {
        this.running = false;
        await this.log('ERROR', 'Trading lease ownership lost; worker stopped its scan loop', {
          workerId: CONFIG.workerId,
          leaseTtlSeconds: this.leaseManager?.ttlSeconds ?? null,
          error: String(error?.message || error).slice(0, 240)
        });
      }
    });
    this.startedAt = Date.now();
    this.lastTickAt = 0;
    this.lastTickerFetch = 0;
    this.lastUniverseRefresh = 0;
    this.lastCandleRefresh = 0;
    this.lastAnalysis = 0;
    this.lastReconcile = 0;
    this.lastAccount = 0;
    this.lastGridCandleRefresh = 0;
    this.gridCandleSymbol = '';
    this.lastSignals = [];
    this.lastOptionSignals = [];
    this.optionTickerMap = new Map();
    this.optionProductMap = new Map();
    this.lastOptionProductFetch = 0;
    this.lastOptionTickerFetch = 0;
    this.tickerMap = new Map();
    this.products = [];
    this.productMap = new Map();
    this.candles = new Map();
    this.candleCacheLimit = resolveCandleCacheSymbolLimit(process.env.CANDLE_CACHE_MAX_SYMBOLS, DEFAULT_CANDLE_CACHE_SYMBOL_LIMIT);
    this.candleCacheSymbols = new Set();
    this.lastCandleCachePruneLogAt = 0;
    this.memoryMonitorInterval = null;
    this.wsCandleSubscribedSymbols = new Set();
    this.ws = null;
    this.wsRetry = 0;
    this.wsReconnectTimer = null;
    this.wsOpenedAt = 0;
    this.wsRateLimited = false;
    this.lastWsWarningAt = 0;
    this.running = false;
    this.leaseEnforced = false;
    this.activeScanPromise = null;
    this.privateExecutionAvailable = false;
    this.lastOptionsSupervisorRunAt = 0;
    this.lastOptionsSupervisorLogAt = 0;
    this.lastOptionsSupervisorStatus = 'NOT_RUN';
    this.optionsExecutionManager = createDeltaOptionsExecutionManager({ database: db });
    this.optionsOrderLedger = createDeltaOptionsOrderLedger({ database: db });
    this.optionsExecutor = createDeltaOptionsExecutor();
    // Constructed for the later supervised state machine; never invoked from
    // scan/signal routing while the source-code Options execution lock is false.
    this.optionsOrderCoordinator = createDeltaOptionsOrderCoordinator({
      manager: this.optionsExecutionManager,
      executor: this.optionsExecutor,
      ledger: this.optionsOrderLedger
    });
    this.optionsSupervisor = createDeltaOptionsSupervisor({
      database: db,
      manager: this.optionsExecutionManager,
      executor: this.optionsExecutor,
      ledger: this.optionsOrderLedger
    });
    this.lastMarketCacheWrite = 0;
    this.candleWarmCursor = 0;
    this.candleFetchAt = new Map();
    this.candleFailureLogAt = new Map();
    this.candleUpdateCounts = new Map();
    this.lastObservedAtr = new Map();
    this.lastAtrJumpLogAt = new Map();
    this.candleHealingInFlight = new Set();
    this.wsConnected = false;
    this.candleRestHealingNeeded = false;
    this.lastLeaseContentionLogAt = 0;
    this.consecutiveLeaseFailures = 0;
    this.lastDuplicateWorkerLogAt = 0;

    // Maintenance uses the direct PostgreSQL pool only; scanner writes remain
    // on the existing Supabase REST adapter.
    this.maintenancePool = null;
    this.maintenancePoolPromise = null;
    this.closeMaintenancePool = null;
    this.maintenanceStarted = false;
    this.retentionStartupTimer = null;
    this.retentionInterval = null;
    this.diskMonitorInterval = null;
    this.retentionInFlight = null;
    this.retentionInFlightDays = null;
    this.pendingRetentionRequest = null;

    this.signalDedupCache = new Map();
    this.signalHistoryStateHydrated = false;
    this.signalHistoryWritesPaused = false;
    this.dedupAnalysisCycles = 0;
    this.dedupTotalCandidates = 0;
    this.dedupSkippedCount = 0;
    this.dedupInsertedCount = 0;
    this.globalPositionCapLogged = new Set();
    this.telegramSignalAlerts = createConfirmedSignalTelegramNotifier({
      env: process.env,
      database: db,
      log: (...args) => this.log(...args)
    });
  }

  async log(level, message, data) {
    await db.log(level, message, data);
  }

  async acquireLease() {
    await this.leaseManager.start();
    await this.log('INFO', 'Trading lease acquired for worker lifetime', {
      workerId: CONFIG.workerId,
      leaseTtlSeconds: this.leaseManager.ttlSeconds,
      renewalIntervalMs: this.leaseManager.renewEveryMs
    });
    return true;
  }

  async releaseLease() {
    const released = await this.leaseManager.release();
    if (!released) {
      await this.log('WARN', 'Trading lease release failed; database TTL will expire the lease', {
        workerId: CONFIG.workerId,
        leaseTtlSeconds: this.leaseManager.ttlSeconds
      }).catch(() => {});
    }
    return released;
  }

  async loadSettings() {
    const rows = await db.select('dd_settings', 'id=eq.1&select=*');
    return rows && rows[0] ? rows[0] : {};
  }

  async updateEngineState(patch) {
    try { await db.update('dd_settings', 'id=eq.1', { ...patch, updated_at: iso() }); } catch (e) { await this.log('ERROR', 'State persistence failed', { error: e.message }); }
  }

  async syncTradetronDeveloperApi() {
    if (!this.tradetronDeveloperApi.isConfigured()) return;
    if (this.tradetronDeveloperSyncInFlight) return this.tradetronDeveloperSyncInFlight;
    if (Date.now() - this.lastTradetronDeveloperSyncAt < 60000) return;
    this.lastTradetronDeveloperSyncAt = Date.now();
    const attemptedAt = iso();

    this.tradetronDeveloperSyncInFlight = (async () => {
      try {
        const result = await this.tradetronDeveloperApi.fetchSnapshot();
        let notificationResult = null;
        let notificationFetchError = null;
        try {
          notificationResult = await this.tradetronDeveloperApi.listNotifications();
        } catch (notificationError) {
          notificationFetchError = notificationError;
        }
        // Record API poll transitions in a separate, display-only store. These
        // observations never feed dd_trades, sizing, caps, gates or order logic.
        await this.trackTradetronDerivedPositions(
          result.snapshots,
          notificationResult?.notifications || [],
          attemptedAt
        );
        // Save the verified read-only snapshot separately from webhook dd_positions.
        // Do not create fills or convert these records into trade-ledger rows.
        if (Array.isArray(result.snapshots) && result.snapshots.length) {
          await db.upsertMany('dd_tradetron_developer_snapshots', result.snapshots, 'deployment_id');
        }
        // Keep an account-level P&L trail without inventing individual fills.
        // Repeated polls within a five-minute window update one bucket per deployment.
        try {
          const historyRows = buildTradetronPnlHistoryRows(result.snapshots, attemptedAt);
          if (historyRows.length) {
            await db.upsertMany('dd_tradetron_developer_pnl_history', historyRows, 'snapshot_id');
          }
          if (Date.now() - this.lastTradetronDeveloperPnlCleanupAt > 86400000) {
            this.lastTradetronDeveloperPnlCleanupAt = Date.now();
            const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
            await db.remove('dd_tradetron_developer_pnl_history', 'captured_at=lt.' + encodeURIComponent(cutoff));
          }
        } catch (historyError) {
          await this.log('WARN', 'Tradetron P&L history sampling failed; current snapshots remain independent', {
            error: String(historyError?.message || historyError).slice(0, 240)
          });
        }
        const stateRow = {
          id: 1,
          status: result.status,
          last_attempt_at: attemptedAt,
          deployment_count: result.deploymentCount,
          position_count: result.positionCount,
          last_error: result.error,
          details: {
            deploymentIds: result.deploymentIds,
            failedDeploymentIds: result.failedDeploymentIds,
            lastPage: result.lastPage,
            source: 'Tradetron Developer API read-only'
          },
          updated_at: iso()
        };
        if (result.status === 'OK') stateRow.last_success_at = result.lastSuccessAt || attemptedAt;
        await db.upsert('dd_tradetron_developer_sync_state', stateRow, 'id');
        this.tradetronDeveloperApiStatus = result.status;
        await this.log(result.status === 'OK' ? 'INFO' : 'WARN', 'Tradetron Developer API read-only sync', {
          status: result.status,
          deploymentCount: result.deploymentCount,
          positionCount: result.positionCount,
          failedDeploymentIds: result.failedDeploymentIds,
          error: result.error
        });

        // The notifications endpoint is read-only and is persisted separately
        // from authenticated fill events. Notification text is never promoted
        // to a dd_positions/dd_trades ledger row.
        if (notificationResult) {
          try {
            if (notificationResult.notifications.length) {
              await db.upsertMany('dd_tradetron_developer_notifications', notificationResult.notifications, 'notification_id');
            }
            await db.upsert('dd_tradetron_developer_notification_sync_state', {
              id: 1,
              status: 'OK',
              last_attempt_at: attemptedAt,
              last_success_at: notificationResult.capturedAt,
              notification_count: notificationResult.returnedCount,
              last_error: null,
              updated_at: iso()
            }, 'id');
            await this.log('INFO', 'Tradetron Developer API notifications sync', {
              returnedCount: notificationResult.returnedCount,
              storedCount: notificationResult.storedCount
            });
          } catch (notificationError) {
            const cleanMessage = String(notificationError?.message || 'Tradetron Developer API notifications sync failed').slice(0, 300);
            await db.upsert('dd_tradetron_developer_notification_sync_state', {
              id: 1, status: 'ERROR', last_attempt_at: attemptedAt, last_error: cleanMessage, updated_at: iso()
            }, 'id').catch(() => {});
            await this.log('WARN', 'Tradetron Developer API notifications persistence failed', {
              code: notificationError?.code || null, status: notificationError?.status || null, error: cleanMessage
            });
          }
        } else if (notificationFetchError) {
          const cleanMessage = String(notificationFetchError?.message || 'Tradetron Developer API notifications sync failed').slice(0, 300);
          await db.upsert('dd_tradetron_developer_notification_sync_state', {
            id: 1, status: 'ERROR', last_attempt_at: attemptedAt, last_error: cleanMessage, updated_at: iso()
          }, 'id').catch(() => {});
          await this.log('WARN', 'Tradetron Developer API notifications sync failed', {
            code: notificationFetchError?.code || null, status: notificationFetchError?.status || null, error: cleanMessage
          });
        }
      } catch (error) {
        this.tradetronDeveloperApiStatus = 'ERROR';
        const cleanMessage = String(error?.message || 'Tradetron Developer API sync failed').slice(0, 300);
        await db.update('dd_tradetron_developer_sync_state', 'id=eq.1', {
          status: 'ERROR',
          last_attempt_at: attemptedAt,
          last_error: cleanMessage,
          updated_at: iso()
        }).catch(() => {});
        await this.log('WARN', 'Tradetron Developer API sync failed', {
          code: error?.code || null,
          status: error?.status || null,
          error: cleanMessage
        });
      }
    })();

    try { await this.tradetronDeveloperSyncInFlight; }
    finally { this.tradetronDeveloperSyncInFlight = null; }
  }

  async trackTradetronDerivedPositions(snapshots, notifications, detectedAt) {
    try {
      const previous = await db.select(
        'dd_api_derived_position_snapshots',
        'is_current=eq.true&select=*&limit=5000'
      );
      const plan = buildApiDerivedTrackingPlan({
        previousObservations: previous || [],
        snapshots: Array.isArray(snapshots) ? snapshots : [],
        notifications: Array.isArray(notifications) ? notifications : [],
        detectedAt
      });

      // Strategy is not included in Tradetron's raw position snapshots. Attach
      // a display-only best-effort label from the current signal cache at the
      // detection moment; this is never treated as authenticated trade provenance.
      let signalCacheRows = [];
      const closeSymbols = [...new Set(plan.trades
        .map(trade => String(trade?.symbol || '').trim().toUpperCase())
        .filter(Boolean))];
      if (closeSymbols.length) {
        try {
          signalCacheRows = await db.select(
            'dd_signal_cache',
            'symbol=in.(' + closeSymbols.join(',') + ')' +
              '&strategy=in.(MOMENTUM,SCALPING)' +
              '&select=symbol,strategy,stage,score,ready,cached_at' +
              '&order=ready.desc,score.desc,cached_at.desc&limit=1000'
          ) || [];
        } catch (error) {
          await this.log('WARN', 'Could not annotate API-derived close strategy from signal cache', {
            symbols: closeSymbols,
            error: String(error?.message || error).slice(0, 240),
            note: 'Close observations will still be stored with unknown strategy; display-only labels are best-effort.'
          });
        }
      }
      const derivedTrades = plan.trades.map(trade => ({
        ...trade,
        strategy: strategyForDerivedTrade(trade, signalCacheRows)
      }));

      // Insert close observations first; if persistence fails, do not advance the
      // position cursor, so the next poll can retry the same close transition.
      for (const trade of derivedTrades) {
        await db.insertIgnore('dd_api_derived_trades', trade, 'source_fingerprint');
      }
      for (const action of plan.observationActions) {
        if (action.type === 'update') {
          if (!action.previous_id) continue;
          await db.update(
            'dd_api_derived_position_snapshots',
            'id=eq.' + encodeURIComponent(action.previous_id) + '&is_current=eq.true',
            action.row
          );
          continue;
        }
        if (action.previous_id) {
          await db.update(
            'dd_api_derived_position_snapshots',
            'id=eq.' + encodeURIComponent(action.previous_id) + '&is_current=eq.true',
            { is_current: false }
          );
        }
        await db.insert('dd_api_derived_position_snapshots', action.row);
      }
      if (plan.trades.length || plan.observationActions.length) {
        await this.log('INFO', 'Tradetron API-derived position tracking', {
          tradesObserved: derivedTrades.length,
          transitions: derivedTrades.filter(row => row.derived_from === 'poll_transition').length,
          closedSnapshotObservations: derivedTrades.filter(row => row.derived_from === 'snapshot_closed').length,
          strategyLabels: derivedTrades.filter(row => row.strategy).length,
          observationWrites: plan.observationActions.length,
          displayOnly: true,
          verifiedFills: false
        });
      }
    } catch (error) {
      await this.log('WARN', 'Tradetron API-derived position tracking failed; read-only snapshot sync continues', {
        error: String(error?.message || error).slice(0, 240)
      });
    }
  }

  async manageGridStrategy(settings, account) {
    if (CONFIG.deltaExecutionMode === 'testnet') {
      const symbol = ['BTCUSD', 'ETHUSD'].includes(String(settings.grid_symbol || '').toUpperCase())
        ? String(settings.grid_symbol || '').toUpperCase() : 'ETHUSD';
      const ticker = this.tickerMap.get(symbol);
      const product = this.productMap.get(symbol) || {};
      const needsRefresh = this.gridCandleSymbol !== symbol || Date.now() - this.lastGridCandleRefresh >= 15000;
      if (settings.grid_enabled === true || (Array.isArray(settings.grid_state?.positions) && settings.grid_state.positions.length > 0)) {
        if (needsRefresh) {
          try {
            await this.refreshCandle(symbol, '1m');
            this.gridCandleSymbol = symbol;
            this.lastGridCandleRefresh = Date.now();
          } catch (error) {
            await this.log('WARN', 'Delta Testnet Grid candle refresh failed; new entries remain blocked', {
              symbol, error: String(error?.message || error).slice(0, 220)
            });
          }
        }
      }
      const dataFresh = this.gridCandleSymbol === symbol &&
        Date.now() - this.lastGridCandleRefresh < 60000 &&
        this.getCandles(symbol, '1m').length >= 6;
      const result = await manageDeltaTestnetGrid({
        settings, account, ticker, product,
        candles: this.getCandles(symbol, '1m'),
        dataFresh, database: db, executor: deltaExecutor
      });
      this.lastGridEntrySafety = result.safety;
      settings.grid_state = result.state;
      return;
    }
    let priorState = settings.grid_state;
    if (typeof priorState === 'string') {
      try { priorState = JSON.parse(priorState); } catch { priorState = null; }
    }
    if (!priorState || typeof priorState !== 'object' || Array.isArray(priorState)) priorState = createGridState();
    const symbol = ['BTCUSD', 'ETHUSD'].includes(String(settings.grid_symbol || '').toUpperCase())
      ? String(settings.grid_symbol || 'ETHUSD').toUpperCase() : 'ETHUSD';
    const ticker = this.tickerMap.get(symbol);
    const product = this.productMap.get(symbol) || {};
    const mark = n(ticker?.mark_price || ticker?.close);
    if (!(mark > 0)) {
      await this.log('WARN', 'Grid strategy waiting for selected symbol price', { symbol });
      return;
    }

    // Production Grid signals reuse the already-configured futures Tradetron
    // bridge. Its symbol-specific exit flag controls one net position, so Grid
    // is deliberately limited to one open position in SIGNAL_ONLY mode.
    const tradetronMode = CONFIG.signalOnly === true;
    const bridge = tradetronMode ? this.getTradetronBridgeForSymbol(symbol) : null;
    const bridgeReady = !tradetronMode || (
      CONFIG.tradetronBridgeEnabled &&
      bridge &&
      bridge.isConfigured() &&
      typeof bridge.supportsFuturesSymbol === 'function' &&
      bridge.supportsFuturesSymbol(symbol)
    );
    if (tradetronMode && settings.grid_enabled === true && !bridgeReady) {
      const warningKey = 'GRID:' + symbol;
      if (!this.unsupportedBridgeWarnings.has(warningKey)) {
        this.unsupportedBridgeWarnings.add(warningKey);
        await this.log('WARN', 'Grid entry blocked: no configured Tradetron route for selected symbol', {
          symbol,
          configured: !!bridge?.isConfigured?.(),
          note: 'Grid uses the existing Momentum/Scalping signal bridge; no direct Delta order fallback exists'
        });
      }
    }
    if (tradetronMode && Array.isArray(priorState.positions) &&
        priorState.positions.some(position => position?.bridgeExecutionId) && !bridgeReady) {
      priorState.pausedReason = 'GRID_BRIDGE_UNAVAILABLE';
      priorState.status = 'HALTED';
      priorState.lastTickAt = iso();
      await db.update('dd_settings', 'id=eq.1', {
        grid_state: priorState,
        updated_at: iso()
      });
      settings.grid_state = priorState;
      return;
    }

    let dataFresh = settings.grid_enabled !== true;
    if (settings.grid_enabled === true || (Array.isArray(priorState.positions) && priorState.positions.length > 0)) {
      const needsRefresh = this.gridCandleSymbol !== symbol || Date.now() - this.lastGridCandleRefresh >= 15000;
      if (needsRefresh) {
        try {
          await this.refreshCandle(symbol, '1m');
          this.gridCandleSymbol = symbol;
          this.lastGridCandleRefresh = Date.now();
        } catch (error) {
          await this.log('WARN', 'Grid candle refresh failed; new entries remain blocked', { symbol, error: error.message });
        }
      }
      dataFresh = this.gridCandleSymbol === symbol &&
        Date.now() - this.lastGridCandleRefresh < 60000 &&
        this.getCandles(symbol, '1m').length >= 6;
    }

    const snapshotSafety = await this.getTradetronSnapshotRiskState();
    if (snapshotSafety.configured) this.lastTradetronEntrySafety = snapshotSafety;
    const localGridPositionOpen = Array.isArray(priorState.positions) &&
      priorState.positions.some(position => Math.abs(n(position?.qty)) > 0 && !!position?.bridgeExecutionId);
    const blockingSnapshotPosition = snapshotSafety.configured && snapshotSafety.trusted === true
      ? snapshotSafety.openPositions.find(position => String(position.symbol || '').toUpperCase() === symbol) || null
      : null;
    const snapshotPositionOnGridSymbol = !!blockingSnapshotPosition;
    const snapshotEntryBlocked = tradetronMode && CONFIG.tradetronBridgeEnabled && (
      snapshotSafety.trusted !== true || (snapshotPositionOnGridSymbol && !localGridPositionOpen)
    );
    this.lastGridEntrySafety = {
      configured: snapshotSafety.configured === true,
      trusted: typeof snapshotSafety.trusted === 'boolean' ? snapshotSafety.trusted : null,
      blocked: snapshotEntryBlocked,
      blockingSymbol: snapshotPositionOnGridSymbol && !localGridPositionOpen
        ? String(blockingSnapshotPosition?.symbol || symbol).toUpperCase() : null,
      blockingQty: snapshotPositionOnGridSymbol && !localGridPositionOpen && blockingSnapshotPosition
        ? (['SELL', 'SHORT'].includes(String(blockingSnapshotPosition.side || '').toUpperCase())
          ? -Math.abs(n(blockingSnapshotPosition.qty)) : Math.abs(n(blockingSnapshotPosition.qty)))
        : null,
      reason: !snapshotSafety.configured ? 'DEVELOPER_API_NOT_CONFIGURED'
        : snapshotSafety.trusted !== true ? snapshotSafety.reason
          : snapshotPositionOnGridSymbol && !localGridPositionOpen ? 'SAME_SYMBOL_OPEN_POSITION' : null
    };
    if (settings.grid_enabled === true && snapshotEntryBlocked) {
      const safetyKey = 'GRID-SNAPSHOT:' + symbol + ':' + (snapshotSafety.reason || 'SAME_SYMBOL_OPEN');
      if (!this.unsupportedBridgeWarnings.has(safetyKey)) {
        this.unsupportedBridgeWarnings.add(safetyKey);
        await this.log('WARN', 'Grid new entry blocked by Tradetron position snapshot safety', {
          symbol,
          reason: snapshotSafety.reason || (snapshotPositionOnGridSymbol ? 'SAME_SYMBOL_OPEN_POSITION' : 'SNAPSHOT_UNTRUSTED'),
          lastSuccessAt: snapshotSafety.lastSuccessAt || null,
          note: 'Existing Grid positions still use their own simulated exit rules; API snapshots never confirm exits or fills'
        });
      }
    }
    const testnetGridEntryHold = CONFIG.deltaExecutionMode === 'testnet';
    if (settings.grid_enabled === true && testnetGridEntryHold) {
      const warningKey = 'GRID:DELTA_TESTNET_ENTRY_HOLD';
      if (!this.unsupportedBridgeWarnings.has(warningKey)) {
        this.unsupportedBridgeWarnings.add(warningKey);
        await this.log('WARN', 'Grid new entries are held in Delta Testnet mode; existing bridged Grid exits are preserved', {
          symbol,
          note: 'Grid order sizing and multi-rung lifecycle have not been migrated to the single-position Delta Testnet executor'
        });
      }
    }
    const effectiveEnabled = settings.grid_enabled === true && bridgeReady && !snapshotEntryBlocked && !testnetGridEntryHold;
    const evaluationSettings = {
      ...settings,
      grid_symbol: symbol,
      grid_enabled: effectiveEnabled,
      grid_max_positions: tradetronMode ? 1 : settings.grid_max_positions
    };
    const result = evaluateGridTick({
      settings: evaluationSettings,
      state: priorState,
      price: mark,
      equity: n(account?.equity),
      available: n(account?.available),
      contractValue: n(product.contract_value) || 1,
      makerFeeRate: Number.isFinite(Number(product.maker_commission_rate)) ? Number(product.maker_commission_rate) : 0.0002,
      slippagePct: 0.02,
      candles: this.getCandles(symbol, '1m'),
      dataFresh,
      emergencyStop: settings.emergency_stop === true,
      timestamp: Date.now(),
      maxLeverage: n(settings.max_leverage) || 3
    });
    const gridState = result.state;
    let bridgeActionThisCycle = false;

    if (tradetronMode && bridgeReady) {
      // Route exits first. A failed/ambiguous exit restores the local position
      // and hard-stops the grid rather than pretending the Tradetron position closed.
      for (const trade of result.exited) {
        const parentExecutionId = String(trade.bridgeExecutionId || '');
        if (!parentExecutionId) continue; // legacy local-only position; never invent an external exit
        const exitExecutionId = parentExecutionId + '-X-' + Math.floor(Date.now() / 1000).toString(36);
        const rawExit = {
          source: 'tradetron_grid_bridge',
          parent_execution_id: parentExecutionId,
          grid_level: n(trade.levelIndex) + 1,
          exit_price: n(trade.exitPrice),
          reason: String(trade.reason || 'GRID_EXIT')
        };
        try {
          await db.upsert('dd_orders', {
            id: exitExecutionId,
            product_id: n(product.id),
            symbol,
            side: 'sell',
            order_type: 'tradetron_grid_exit',
            size: n(trade.qty),
            state: 'PENDING',
            client_order_id: exitExecutionId,
            role: 'EXIT',
            strategy: 'GRID',
            execution_id: exitExecutionId,
            raw: rawExit
          }, 'client_order_id');
          const sent = await bridge.emitExit({
            symbol,
            side: 'BUY',
            reason: trade.reason || 'GRID_TARGET',
            executionId: exitExecutionId
          });
          if (!sent?.ok) throw new Error(sent?.reason || 'Tradetron Grid exit was not accepted');
          await db.update('dd_orders', 'client_order_id=eq.' + encodeURIComponent(exitExecutionId), {
            state: 'SIGNAL_SENT',
            updated_at: iso(),
            raw: { ...rawExit, bridge_accepted: true, bridge_response: sent.response || 'Ok', trigger_key: sent.triggerKey || null }
          });
          await db.update('dd_orders', 'client_order_id=eq.' + encodeURIComponent(parentExecutionId), {
            state: 'EXITED',
            updated_at: iso(),
            raw: {
              source: 'tradetron_grid_bridge',
              bridge_accepted: true,
              entry_price: n(trade.entryPrice),
              stop_price: n(trade.stopPrice),
              tp_price: n(trade.targetPrice),
              exit_price: n(trade.exitPrice),
              exit_reason: String(trade.reason || 'GRID_EXIT'),
              closed_at: iso()
            }
          });
          bridgeActionThisCycle = true;
          await this.log('INFO', 'Tradetron Grid exit signal accepted; direct Delta order skipped', {
            symbol, strategy: 'GRID', qty: n(trade.qty), exit: n(trade.exitPrice),
            reason: trade.reason, executionId: exitExecutionId, parentExecutionId,
            triggerKey: sent.triggerKey || null, tradetronMode: 'LIVE_OFFLINE'
          });
        } catch (error) {
          const originalPosition = (priorState.positions || []).find(position => String(position.id) === String(trade.id));
          if (originalPosition && !gridState.positions.some(position => String(position.id) === String(originalPosition.id))) {
            gridState.positions.push({ ...originalPosition });
          }
          gridState.realizedPnl = n(gridState.realizedPnl) - n(trade.netPnl);
          gridState.dayPnl = n(gridState.dayPnl) - n(trade.netPnl);
          gridState.trades = (gridState.trades || []).filter(row => String(row.id) !== String(trade.id));
          gridState.openRiskUsd = gridState.positions.reduce((sum, position) => sum + Math.max(0, n(position.riskUsd)), 0);
          gridState.pausedReason = 'GRID_BRIDGE_EXIT_UNCONFIRMED';
          gridState.status = 'HALTED';
          gridState.events = [...(gridState.events || []), {
            type: 'HALT', reason: gridState.pausedReason, symbol, at: iso(), price: mark
          }].slice(-80);
          await this.log('ERROR', 'Tradetron Grid exit unconfirmed; grid halted fail-closed', {
            symbol, qty: n(trade.qty), reason: trade.reason, executionId: exitExecutionId,
            parentExecutionId, error: error.message
          });
        }
      }

      // New entries are sent only after the target/range/stop logic passes.
      // Store a PENDING reservation before calling Tradetron so another scanner
      // strategy cannot race the same symbol while the API response is unknown.
      for (const position of result.entered) {
        const executionId = 'TTG-' + symbol + '-' + (n(position.levelIndex) + 1) + '-' + Date.now().toString(36);
        position.bridgeExecutionId = executionId;
        const rawEntry = {
          source: 'tradetron_grid_bridge',
          grid_level: n(position.levelIndex) + 1,
          entry_price: n(position.entryPrice),
          stop_price: n(position.stopPrice),
          tp_price: n(position.targetPrice),
          bridge_accepted: false
        };
        try {
          await db.upsert('dd_orders', {
            id: executionId,
            product_id: n(product.id),
            symbol,
            side: 'buy',
            order_type: 'tradetron_signal',
            size: n(position.qty),
            state: 'PENDING',
            client_order_id: executionId,
            role: 'ENTRY',
            strategy: 'GRID',
            execution_id: executionId,
            raw: rawEntry
          }, 'client_order_id');
          const sent = await bridge.emitEntry({
            symbol,
            side: 'BUY',
            qty: position.qty,
            entryPrice: position.entryPrice,
            sl: position.stopPrice,
            tp1: position.targetPrice,
            tp: position.targetPrice,
            executionId,
            strategy: 'GRID'
          });
          if (sent?.positionSafetyBlocked === true) {
            await db.update('dd_orders', 'client_order_id=eq.' + encodeURIComponent(executionId), {
              state: 'FAILED',
              updated_at: iso(),
              raw: { ...rawEntry, position_safety_blocked: true, global_position_cap_blocked: sent.globalPositionCapBlocked === true, block_reason: sent.reason || 'POSITION_SAFETY_BLOCKED' }
            });
            gridState.positions = (gridState.positions || []).filter(row =>
              String(row?.id ?? '') !== String(position?.id ?? '') &&
              String(row?.bridgeExecutionId || '') !== executionId
            );
            gridState.openRiskUsd = gridState.positions.reduce((sum, row) => sum + Math.max(0, n(row.riskUsd)), 0);
            gridState.events = [...(gridState.events || []), {
              type: 'BLOCK',
              reason: sent.globalPositionCapBlocked === true ? 'GLOBAL_OPEN_POSITION_LIMIT' : 'POSITION_SAFETY_BLOCKED',
              detail: sent.reason || null,
              symbol, at: iso(), price: mark, levelIndex: n(position.levelIndex)
            }].slice(-80);
            await this.log('WARN', 'Grid entry blocked by final Tradetron position-cap safety guard', {
              symbol, qty: n(position.qty), gridLevel: n(position.levelIndex) + 1,
              executionId, reason: sent.reason || 'POSITION_SAFETY_BLOCKED',
              globalPositionCapBlocked: sent.globalPositionCapBlocked === true
            });
            continue;
          }
          if (!sent?.ok) throw new Error(sent?.reason || 'Tradetron Grid entry was not accepted');
          await db.update('dd_orders', 'client_order_id=eq.' + encodeURIComponent(executionId), {
            state: 'SIGNAL_SENT',
            updated_at: iso(),
            raw: { ...rawEntry, bridge_accepted: true, bridge_response: sent.response || 'Ok', trigger_key: sent.triggerKey || null }
          });
          bridgeActionThisCycle = true;
          await this.log('INFO', 'Tradetron Grid entry signal accepted; direct Delta order skipped', {
            symbol, strategy: 'GRID', side: 'BUY', qty: n(position.qty),
            entry: n(position.entryPrice), sl: n(position.stopPrice), tp: n(position.targetPrice),
            gridLevel: n(position.levelIndex) + 1, executionId,
            triggerKey: sent.triggerKey || null, tradetronMode: 'LIVE_OFFLINE'
          });
        } catch (error) {
          // The request may have reached Tradetron even if the response was
          // lost. Keep the pending reservation and position record, then stop
          // rather than resubmit or accidentally overlap a Momentum/Scalping entry.
          gridState.pausedReason = 'GRID_BRIDGE_ENTRY_UNCONFIRMED';
          gridState.status = 'HALTED';
          gridState.events = [...(gridState.events || []), {
            type: 'HALT', reason: gridState.pausedReason, symbol, at: iso(), price: mark,
            levelIndex: position.levelIndex
          }].slice(-80);
          await this.log('ERROR', 'Tradetron Grid entry unconfirmed; grid halted fail-closed', {
            symbol, qty: n(position.qty), gridLevel: n(position.levelIndex) + 1,
            executionId, error: error.message
          });
        }
      }

      // Keep the Grid entry reservation fresh while the single Tradetron net
      // position is managed, so Momentum/Scalping cannot open a duplicate ETH/BTC position.
      for (const position of gridState.positions || []) {
        const executionId = String(position.bridgeExecutionId || '');
        if (!executionId) continue;
        try {
          await db.update('dd_orders',
            'client_order_id=eq.' + encodeURIComponent(executionId) + '&state=in.(PENDING,SIGNAL_SENT)',
            { updated_at: iso() });
        } catch (error) {
          await this.log('WARN', 'Grid Tradetron reservation refresh failed', {
            symbol, executionId, error: error.message
          });
        }
      }
    }

    await db.update('dd_settings', 'id=eq.1', { grid_state: gridState, updated_at: iso() });
    settings.grid_state = gridState;
    settings.grid_bridge_action_this_cycle = bridgeActionThisCycle;

    const eventTime = result.state.lastTickAt;
    const newEvents = (gridState.events || []).filter(event => event.at === eventTime);
    for (const event of newEvents) {
      if (!['ENTRY', 'EXIT', 'HALT', 'PAUSE', 'BLOCK'].includes(event.type)) continue;
      await this.log(event.type === 'HALT' ? 'WARN' : event.type === 'BLOCK' ? 'WARN' : 'INFO',
        'Grid strategy ' + event.type,
        {
          symbol, ...event,
          simulatorOnly: !tradetronMode,
          tradetronSignalMode: tradetronMode,
          liveOrdersSent: false
        });
    }
  }

  async refreshProducts() {
    const raw = await this.adapter.products();
    const active = (Array.isArray(raw) ? raw : []).filter(p =>
      p.contract_type === 'perpetual_futures' &&
      p.state === 'live' &&
      p.trading_status === 'operational' &&
      p.only_reduce_only_orders_allowed !== true
    );
    this.products = active;
    this.productMap = new Map(active.map(p => [p.symbol, p]));
    this.lastUniverseRefresh = Date.now();
    await this.log('INFO', 'Delta product universe refreshed', { active: active.length });
  }

  async refreshTickers() {
    const raw = await this.adapter.tickers();
    const all = (Array.isArray(raw) ? raw : []).filter(x => x.contract_type === 'perpetual_futures');
    const next = new Map();
    for (const t of all) {
      const symbol = String(t.symbol || '').toUpperCase();
      const p = this.productMap.get(symbol);
      if (!p) continue;
      next.set(symbol, { ...t, symbol });
    }
    const ranked = [...next.values()].sort((a, b) => n(b.turnover_usd || b.turnover) - n(a.turnover_usd || a.turnover));
    this.tickerMap = new Map(ranked.map(x => [x.symbol, x]));
    this.updateCandleCacheUniverse(ranked);
    if (ranked.length) this.lastTickAt = Date.now();
    this.lastTickerFetch = Date.now();
  }

  async cacheMarketState() {
    // This persists dashboard-facing market metadata only. Trading calculations
    // continue to use the independently refreshed in-memory ticker/candle data.
    // Avoid sending the full contract universe to Supabase on every ticker refresh.
    if (!shouldWriteMarketCache(this.lastMarketCacheWrite, Date.now())) return;
    const rows = [...this.tickerMap.values()]
      .sort((a, b) => n(b.turnover_usd || b.turnover) - n(a.turnover_usd || a.turnover))
      .map((ticker, index) => {
        const p = this.productMap.get(ticker.symbol) || {};
        const bid = n(ticker.quotes?.best_bid ?? ticker.best_bid);
        const ask = n(ticker.quotes?.best_ask ?? ticker.best_ask);
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
        return {
          symbol: ticker.symbol,
          product_id: n(p.id),
          contract_type: p.contract_type || 'perpetual_futures',
          state: p.state || 'live',
          trading_status: p.trading_status || 'operational',
          underlying_asset: String(p.underlying_asset || p.contract_unit_currency || ticker.symbol || '').replace(/USD$/i, ''),
          price: n(ticker.mark_price || ticker.close),
          mark_price: n(ticker.mark_price),
          change_24h: n(ticker.ltp_change_24h),
          turnover_usd: n(ticker.turnover_usd || ticker.turnover),
          volume: n(ticker.volume),
          open_interest: n(ticker.open_interest),
          bid, ask,
          spread_pct: mid > 0 ? (ask - bid) / mid * 100 : 0,
          tick_size: n(p.tick_size),
          contract_value: n(p.contract_value),
          notional_type: p.notional_type || null,
          max_leverage: n(p.default_leverage),
          max_leverage_notional: n(p.max_leverage_notional),
          position_notional_limit: n(p.position_notional_limit || p.position_limit_notional),
          market_rank: index + 1,
          active: true,
          cached_at: iso(),
          details: {
            description: p.description || null,
            shortDescription: p.short_description || null,
            makerFee: n(p.maker_commission_rate),
            takerFee: n(p.taker_commission_rate),
            launchTime: p.launch_time || null,
            settlementTime: p.settlement_time || null,
            productSpecs: p.product_specs || null,
            tags: p.tags || p.ui_config?.tags || []
          }
        };
      });
    await db.upsertMany('dd_market_cache', rows, 'symbol');
    await this.removeStaleUniverseRows('dd_market_cache', rows.map(row => row.symbol));
    this.lastMarketCacheWrite = Date.now();
    await this.log('INFO', 'Full Delta market cache refreshed', { perpetuals: rows.length });
  }

  async removeStaleUniverseRows(table, symbols) {
    const keep = [...new Set((Array.isArray(symbols) ? symbols : [])
      .map(value => String(value || '').toUpperCase())
      .filter(value => /^[A-Z0-9]+USD$/.test(value)))];
    if (!keep.length) return; // Fail closed: never delete cache rows when the active universe is empty.
    try {
      await db.remove(table, 'symbol=not.in.(' + keep.join(',') + ')');
    } catch (error) {
      await this.log('WARN', 'Stale market-universe cache cleanup failed', { table, error: error.message });
    }
  }

  shouldLogCandleFailure(key, now = Date.now()) {
    const cooldownMs = CONFIG.deltaExecutionMode === 'testnet'
      ? CANDLE_TESTNET_WARMUP_RETRY_MS
      : CANDLE_WARMUP_RETRY_MS;
    const previous = this.candleFailureLogAt.get(key) || 0;
    if (!shouldEmitThrottledLog(previous, now, cooldownMs)) return false;
    this.candleFailureLogAt.set(key, now);
    return true;
  }

  shouldLogWebSocketWarning(now = Date.now()) {
    if (!shouldEmitThrottledLog(this.lastWsWarningAt, now, WS_ERROR_LOG_COOLDOWN_MS)) return false;
    this.lastWsWarningAt = now;
    return true;
  }

  async refreshCandle(symbol, resolution) {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    if (!['1m', '5m', '15m'].includes(resolution) || !this.candleCacheSymbols.has(normalizedSymbol)) return [];
    symbol = normalizedSymbol;
    const key = resolution + ':' + symbol;
    // Track attempts even when the API fails or returns a partial series. Testnet
    // mode uses a longer cooldown so thin/empty products cannot trigger retry storms.
    this.candleFetchAt.set(key, Date.now());
    const value = await this.adapter.candles(symbol, resolution, 100);
    const normalized = normalizeCandleBatch(value, resolution, {
      minCandles: MIN_RAW_CANDLES_FOR_ATR,
      maxAgeIntervals: candleMaxAgeIntervals(resolution, CONFIG.deltaExecutionMode === 'testnet')
    });
    if (!normalized.ok) {
      const detail = {
        symbol, resolution, reason: normalized.reason,
        count: normalized.count ?? (Array.isArray(value) ? value.length : null),
        index: normalized.index ?? null,
        latestTimestamp: normalized.latest ?? null,
        ageSeconds: normalized.ageSeconds ?? null,
        preservedCandleCount: this.getCandles(symbol, resolution).length,
        retryAfterMs: CONFIG.deltaExecutionMode === 'testnet'
          ? CANDLE_TESTNET_WARMUP_RETRY_MS : CANDLE_WARMUP_RETRY_MS
      };
      if (this.shouldLogCandleFailure(key)) {
        await this.log('WARN', 'Candle REST batch rejected; preserving prior valid series', detail);
      }
      throw new Error('candle_batch_rejected:' + normalized.reason);
    }
    const rows = normalized.candles.slice(-120);
    const previousRows = this.getCandles(symbol, resolution);
    if (this.rejectAtrSpike(symbol, resolution, previousRows, rows, 'REST')) return this.getCandles(symbol, resolution);
    this.candles.set(key, rows);
    this.candleFailureLogAt.delete(key);
    await this.log('INFO', 'Candle REST batch normalized', {
      symbol, resolution, candleCount: rows.length,
      firstTimestamp: rows[0]?.time ?? null,
      lastTimestamp: rows.at(-1)?.time ?? null
    });
    return rows;
  }

  preserveCandleCacheForHealing(reason) {
    const symbols = new Set(this.candleCacheSymbols);
    // Do not throw away validated history on a transient socket outage.
    // Stale series trigger REST rewarm after cooldown and are blocked from
    // generating executable signals by applyTestnetCandleFreshness().
    this.candleWarmCursor = 0;
    this.candleRestHealingNeeded = true;
    if (this.shouldLogWebSocketWarning()) {
      void this.log('WARN', 'WebSocket disconnected; preserving cached candles for REST fallback', {
        reason, symbolCount: symbols.size,
        cachedSeriesCount: [...this.candles.keys()].filter(key => /^(1m|5m|15m):/.test(key)).length,
        note: 'Stale candle series are blocked from entries until they refresh'
      }).catch(() => {});
    }
  }

  rejectAtrSpike(symbol, resolution, previousCandles, candidateCandles, source = 'unknown') {
    if (!Array.isArray(previousCandles) || !Array.isArray(candidateCandles) || previousCandles.length < 16 || candidateCandles.length < 16) return false;
    const previousAtr = calculateAtr(previousCandles);
    const candidateAtr = calculateAtr(candidateCandles);
    const jump = detectAtrSpike(previousAtr, candidateAtr, 3);
    if (!jump) return false;
    const key = resolution + ':' + symbol;
    const now = Date.now();
    const cooldownMs = CONFIG.deltaExecutionMode === 'testnet' ? CANDLE_TESTNET_WARMUP_RETRY_MS : CANDLE_WARMUP_RETRY_MS;
    let tailSanitized = false;
    const previousTail = previousCandles.at(-1);
    const candidatePreviousTail = candidateCandles.at(-2);
    const candidateTail = candidateCandles.at(-1);
    // On a new time bucket, the previously-forming candle becomes closed. If
    // that exact candle causes the 3x jump, replace its OHLCV with the prior
    // valid bar while retaining its timestamp so subsequent buckets can advance.
    if (previousTail && candidatePreviousTail && candidateTail &&
        Number(candidatePreviousTail.time) === Number(previousTail.time) &&
        Number(candidateTail.time) > Number(previousTail.time)) {
      const sanitized = replaceOutlierCandleWithPrevious(previousCandles);
      if (sanitized) {
        this.candles.set(key, sanitized.slice(-120));
        tailSanitized = true;
      }
    }

    const previousLogAt = this.lastAtrJumpLogAt.get(key) || 0;
    if (shouldEmitThrottledLog(previousLogAt, now, cooldownMs)) {
      this.lastAtrJumpLogAt.set(key, now);
      void this.log('DEBUG', 'ATR 3x jump ignored; preserving previous valid candle series', {
        symbol, resolution, source,
        previousAtr: Number(jump.previousAtr.toFixed(10)), candidateAtr: Number(jump.candidateAtr.toFixed(10)),
        ratio: Number(jump.ratio.toFixed(3)),
        previousCandleTimestamp: previousTail?.time ?? null,
        candidateCandleTimestamp: candidateTail?.time ?? null,
        tailSanitized,
        action: tailSanitized
          ? 'suspect candle OHLCV replaced with previous valid candle values'
          : 'candidate candle series rejected; previous valid cache retained'
      }).catch(() => {});
    }
    return true;
  }

  recordAtrDiagnostics(signal) {
    const symbol = String(signal?.symbol || '').toUpperCase();
    if (!symbol) return;
    for (const item of [
      { resolution: '5m', value: Number(signal.atr5) },
      { resolution: '15m', value: Number(signal.atr15) }
    ]) {
      if (!Number.isFinite(item.value) || item.value <= 0) continue;
      const key = item.resolution + ':' + symbol;
      const previous = this.lastObservedAtr.get(key);
      if (Number.isFinite(previous) && previous > 0) {
        const ratio = Math.max(previous, item.value) / Math.min(previous, item.value);
        if (ratio >= 3) {
          const candles = this.getCandles(symbol, item.resolution);
          void this.log('DEBUG', 'ATR changed by at least 3x between analyses; candle guard retained the last valid series when applicable', {
            symbol, resolution: item.resolution, previousAtr: previous,
            currentAtr: item.value, ratio: Number(ratio.toFixed(3)),
            candleCount: candles.length,
            firstTimestamp: candles[0]?.time ?? null,
            lastTimestamp: candles.at(-1)?.time ?? null,
            candlesFresh: signal.candlesFresh === true
          }).catch(() => {});
        }
      }
      this.lastObservedAtr.set(key, item.value);
    }
  }

  scheduleCandleHealing(symbol, resolution, reason) {
    const key = resolution + ':' + symbol;
    if (this.candleHealingInFlight.has(key)) return;
    this.candleHealingInFlight.add(key);
    void (async () => {
      try {
        if (CONFIG.deltaExecutionMode !== 'testnet' && this.shouldLogCandleFailure(key)) {
          await this.log('WARN', 'Starting REST candle healing after rejected WebSocket update', {
            symbol, resolution, reason
          });
        }
        await this.refreshCandle(symbol, resolution);
      } catch (error) {
        if (this.shouldLogCandleFailure(key)) {
          await this.log('WARN', 'REST candle healing failed; previous validated cache preserved', {
            symbol, resolution, reason, error: String(error?.message || error).slice(0, 200),
            preservedCandleCount: this.getCandles(symbol, resolution).length,
            retryAfterMs: CONFIG.deltaExecutionMode === 'testnet'
              ? CANDLE_TESTNET_WARMUP_RETRY_MS : CANDLE_WARMUP_RETRY_MS
          });
        }
      } finally {
        this.candleHealingInFlight.delete(key);
      }
    })();
  }

  updateCandleCacheUniverse(rankedTickers = [...this.tickerMap.values()]) {
    const nextSymbols = selectTopCandleSymbols(rankedTickers, this.candleCacheLimit);
    this.candleCacheSymbols = nextSymbols;
    const pruned = pruneCandleCacheState({
      candles: this.candles,
      eligibleSymbols: nextSymbols,
      metadataMaps: [
        this.candleFetchAt,
        this.candleFailureLogAt,
        this.candleUpdateCounts,
        this.lastObservedAtr,
        this.lastAtrJumpLogAt
      ],
      healingInFlight: this.candleHealingInFlight
    });
    const removed = pruned.removedSeries + pruned.removedMetadataEntries + pruned.removedHealingKeys;
    this.syncCandleWebSocketSubscription();
    if (removed > 0 && Date.now() - this.lastCandleCachePruneLogAt >= 60_000) {
      this.lastCandleCachePruneLogAt = Date.now();
      void this.log('INFO', 'Candle cache bounded to top turnover-ranked symbols', {
        cacheLimit: this.candleCacheLimit,
        eligibleSymbols: nextSymbols.size,
        cachedSeries: this.candles.size,
        removedSeries: pruned.removedSeries,
        removedMetadataEntries: pruned.removedMetadataEntries,
        removedHealingKeys: pruned.removedHealingKeys
      }).catch(() => {});
    }
    return nextSymbols;
  }

  async refreshCandleWarmup() {
    const ranked = [...this.tickerMap.values()]
      .sort((a, b) => n(b.turnover_usd || b.turnover) - n(a.turnover_usd || a.turnover));
    if (!ranked.length) return;
    this.updateCandleCacheUniverse(ranked);
    const cacheRanked = ranked.filter(row => this.candleCacheSymbols.has(String(row.symbol || '').toUpperCase()));
    if (!cacheRanked.length) return;

    const testnetCandleMode = CONFIG.deltaExecutionMode === 'testnet';
    const warmupBatchSize = testnetCandleMode
      ? CANDLE_TESTNET_WARMUP_BATCH_SIZE : CANDLE_WARMUP_BATCH_SIZE;
    const retryAfterMs = testnetCandleMode
      ? CANDLE_TESTNET_WARMUP_RETRY_MS : CANDLE_WARMUP_RETRY_MS;
    const plan = planCandleWarmup(
      cacheRanked.map(row => row.symbol),
      this.candles,
      this.candleFetchAt,
      this.candleWarmCursor,
      warmupBatchSize,
      Date.now(),
      retryAfterMs,
      testnetCandleMode
    );
    this.candleWarmCursor = plan.nextCursor;
    if (!plan.work.length) return;

    let cursor = 0;
    let warmed = 0;
    let failed = 0;
    const runner = async () => {
      while (cursor < plan.work.length) {
        const [symbol, resolution] = plan.work[cursor++];
        try {
          const rows = await this.refreshCandle(symbol, resolution);
          const minimumRows = resolution === '1m' ? 21 : 31;
          if (rows.length >= minimumRows) warmed++;
        } catch (e) {
          failed++;
          const key = resolution + ':' + symbol;
          if (this.shouldLogCandleFailure(key)) {
            await this.log('WARN', testnetCandleMode
              ? 'Testnet candle refresh unavailable; cached history preserved'
              : 'Candle warmup failed', {
              symbol, resolution, error: e.message,
              preservedCandleCount: this.getCandles(symbol, resolution).length,
              retryAfterMs
            });
          }
        }
      }
    };
    // Production keeps the normal high-throughput batch. Testnet execution uses
    // two concurrent REST reads and a smaller batch to avoid error/retry floods.
    const concurrency = testnetCandleMode ? CANDLE_TESTNET_WARMUP_CONCURRENCY : 6;
    await Promise.all(Array.from({ length: concurrency }, () => runner()));
    this.lastCandleRefresh = Date.now();
    await this.log('INFO', 'Candle warm-up batch finished', {
      symbolsQueued: plan.symbols.length,
      seriesQueued: plan.work.length,
      seriesReady: warmed,
      seriesFailed: failed,
      nextCursor: plan.nextCursor,
      universe: ranked.length,
      candleCacheUniverse: cacheRanked.length,
      candleCacheLimit: this.candleCacheLimit
    });
  }

  candleSeriesIsFresh(symbol, resolution, now = Date.now()) {
    const series = this.getCandles(symbol, resolution);
    const intervalSeconds = ({ '1m': 60, '5m': 300, '15m': 900 })[resolution];
    if (!intervalSeconds || !series.length) return false;
    const latest = normalizeEpochSeconds(series.at(-1)?.time);
    if (latest === null) return false;
    const ageSeconds = now / 1000 - latest;
    return Number.isFinite(ageSeconds) && ageSeconds >= -intervalSeconds && ageSeconds <= intervalSeconds * candleMaxAgeIntervals(resolution, CONFIG.deltaExecutionMode === 'testnet');
  }

  applyTestnetCandleFreshness(signal, entryResolution) {
    if (CONFIG.deltaExecutionMode !== 'testnet' || !signal) return;
    const resolutions = [...new Set([entryResolution, '5m', '15m'])];
    const stale = resolutions.filter(resolution => !this.candleSeriesIsFresh(signal.symbol, resolution));
    if (!stale.length) return;
    signal.candlesFresh = false;
    signal.ready = false;
    signal.blocked = [...new Set([
      ...(Array.isArray(signal.blocked) ? signal.blocked : []),
      'Fresh candles unavailable or stale: ' + stale.join(', ')
    ])];
  }

  getCandles(symbol, resolution) {
    return this.candles.get(resolution + ':' + symbol) || [];
  }

  btcSymbol() {
    if (this.productMap.has('BTCUSD')) return 'BTCUSD';
    return [...this.productMap.keys()].find(x => x.toUpperCase().startsWith('BTC')) || '';
  }

  positionSizing(signal, account, settings) {
    const testnet = CONFIG.deltaExecutionMode === 'testnet';
    const symbol = String(signal?.symbol || 'UNKNOWN').toUpperCase();
    const equity = n(account?.equity);
    const available = n(account?.available);
    const contractValue = n(signal?.contractValue);
    const price = n(signal?.price);
    const stopPrice = n(signal?.sl);
    const stopDistance = stopPrice > 0 ? Math.abs(price - stopPrice) : 0;
    const riskPct = n(settings?.risk_pct || 1);
    const riskBudget = equity * riskPct / 100;
    const maxLeverage = Math.max(1, n(settings?.max_leverage || 3));

    const logSizing = (qty, reason = null, details = {}) => {
      if (!testnet) return;
      const message =
        `[Sizing] Symbol: ${symbol} | Risk: $${riskBudget.toFixed(2)} | SL: $${stopDistance.toFixed(6)} | Qty: ${qty}`;
      console.info(message, JSON.stringify({
        environment: 'testnet',
        equity,
        availableMargin: available,
        riskPct,
        contractValue,
        entryPrice: price,
        stopPrice,
        stopDistance,
        notionalPerContract: price * contractValue,
        riskPerContract: stopDistance * contractValue,
        reason,
        ...details
      }));
    };

    const stage = String(signal?.stage || '').toUpperCase();
    if (stage !== 'CONFIRMED') {
      logSizing(0, `signal stage ${stage || 'UNKNOWN'} is not CONFIRMED`, {
        stage,
        ready: signal?.ready === true
      });
      return null;
    }
    if (signal?.ready !== true) {
      logSizing(0, 'signal ready flag is not true', { stage, ready: false });
      return null;
    }
    if (!(Number.isFinite(Number(signal?.sl)) && Number(signal.sl) > 0)) {
      logSizing(0, `Invalid SL price (${signal?.sl === undefined || signal?.sl === null ? 'missing' : String(signal.sl)})`, {
        invalidStopPrice: signal?.sl ?? null
      });
      return null;
    }
    if (!(Number.isFinite(Number(signal?.tp)) && Number(signal.tp) > 0)) {
      logSizing(0, `Invalid TP price (${signal?.tp === undefined || signal?.tp === null ? 'missing' : String(signal.tp)})`, {
        invalidTakeProfitPrice: signal?.tp ?? null
      });
      return null;
    }
    if (
      !(equity > 0) ||
      !(contractValue > 0) ||
      !(Number.isFinite(price) && price > 0) ||
      !(Number.isFinite(stopDistance) && stopDistance > 0) ||
      !(riskBudget > 0)
    ) {
      logSizing(0, 'invalid equity, contract value, entry price, stop distance, or risk budget');
      return null;
    }

    if (signal.notionalType && signal.notionalType !== 'vanilla') {
      logSizing(0, 'unsupported contract notional type', {
        notionalType: signal.notionalType
      });
      return null;
    }

    const notionalPerContract = price * contractValue;
    const riskPerContract = stopDistance * contractValue;

    if (
      !Number.isFinite(notionalPerContract) ||
      !Number.isFinite(riskPerContract) ||
      !(notionalPerContract > 0) ||
      !(riskPerContract > 0)
    ) {
      logSizing(0, 'invalid per-contract notional or risk', {
        notionalPerContract,
        riskPerContract
      });
      return null;
    }

    const riskQty = Math.floor(riskBudget / riskPerContract);

    // Cap gross notional independently of leverage. Defaults to 2x equity;
    // deployments may lower/raise this with DD_MAX_NOTIONAL_EQUITY_MULTIPLIER.
    const rawNotionalMultiplier = process.env.DD_MAX_NOTIONAL_EQUITY_MULTIPLIER;
    const parsedNotionalMultiplier = rawNotionalMultiplier === undefined || String(rawNotionalMultiplier).trim() === ''
      ? 2
      : Number(rawNotionalMultiplier);
    const maxNotionalEquityMultiplier =
      Number.isFinite(parsedNotionalMultiplier) && parsedNotionalMultiplier > 0 && parsedNotionalMultiplier <= 100
        ? parsedNotionalMultiplier
        : 2;
    const configuredNotionalCap = equity * maxNotionalEquityMultiplier;
    const productNotionalCap = n(signal.maxLeverageNotional) > 0
      ? n(signal.maxLeverageNotional)
      : configuredNotionalCap;
    const notionalCap = Math.min(configuredNotionalCap, productNotionalCap);
    const maxQtyByNotional = Math.floor(notionalCap / notionalPerContract);

    const marginPerContract = notionalPerContract / maxLeverage;
    // Leave at least 90% of currently available margin unallocated for each
    // new entry. This extra Testnet liquidation buffer is deliberately
    // conservative; zero/unknown available margin produces zero margin qty.
    const maxMarginPerTrade = available > 0 ? available * 0.10 : 0;
    const maxQtyByMargin = marginPerContract > 0
      ? Math.floor(maxMarginPerTrade / marginPerContract)
      : 0;

    // Do not bypass any cap for a one-contract fallback: final quantity must
    // satisfy risk, product/equity notional, and available-margin constraints.
    const qty = Math.min(riskQty, maxQtyByNotional, maxQtyByMargin);

    if (qty < 1) {
      logSizing(0, 'BELOW_MIN_CONTRACT', {
        riskQty,
        maxQtyByNotional,
        maxQtyByMargin,
        notionalCap,
        maxNotionalEquityMultiplier,
        maxMarginPerTrade,
        marginPerContract,
        finalQty: 0
      });
      return null;
    }

    const notional = qty * notionalPerContract;
    const risk = qty * riskPerContract;
    const marginEstimate = notional / maxLeverage;

    // Defense in depth in every execution mode: missing margin data cannot
    // be treated as proof of affordability, and the final size must stay
    // within the 10% available-margin budget.
    if (!(available > 0) || marginEstimate > maxMarginPerTrade) {
      logSizing(0, 'estimated margin exceeds 10% per-trade margin cap or available margin is unavailable', {
        qty,
        notional,
        risk,
        marginEstimate,
        available,
        maxMarginPerTrade,
        maxQtyByMargin,
        finalQty: 0
      });
      return null;
    }

    logSizing(qty, null, {
      riskQty,
      maxQtyByNotional,
      maxQtyByMargin,
      notionalCap,
      maxNotionalEquityMultiplier,
      maxMarginPerTrade,
      notional,
      risk,
      marginEstimate,
      finalQty: qty
    });

    return {
      qty,
      notional,
      risk,
      marginEstimate,
      riskBudget,
      riskPerContract,
      notionalPerContract,
      riskQty,
      maxQtyByNotional,
      maxQtyByMargin,
      notionalCap,
      maxNotionalEquityMultiplier,
      maxMarginPerTrade
    };
  }

  async accountSnapshot(settings = {}) {
    if (CONFIG.deltaExecutionMode === 'testnet') {
      if (!this.privateExecutionAvailable) {
        return { equity: 0, available: 0, unrealized: 0, positions: [], privateApiAvailable: false };
      }
      try {
        const { account: wallet, positions: deltaPositions } = await checkDeltaTestnetPrivateApi(deltaExecutor);
        const positions = deltaPositions.map(position => ({
          ...position,
          size: position.signedSize,
          qty: Math.abs(n(position.signedSize)),
          mark_price: n(position.current_price),
          unrealized_pnl: n(position.unrealized_pnl),
          product_id: position.product_id
        }));
        return {
          equity: wallet.equity,
          available: wallet.available,
          unrealized: positions.reduce((sum, position) => sum + n(position.unrealized_pnl), 0),
          positions,
          privateApiAvailable: true
        };
      } catch (error) {
        this.privateExecutionAvailable = false;
        await this.log('WARN', 'Private Delta Testnet API unavailable. Continuing in SCAN-ONLY mode.', {
          error: String(error?.message || error).slice(0, 240),
          executionLocked: true
        }).catch(() => {});
        return { equity: 0, available: 0, unrealized: 0, positions: [], privateApiAvailable: false };
      }
    }
    // No external bridge or production-wallet fallback exists. When direct
    // Delta Testnet is disabled, account data is unknown and entry sizing must
    // fail closed instead of manufacturing capital or querying a live wallet.
    return {
      equity: 0,
      available: 0,
      unrealized: 0,
      positions: [],
      privateApiAvailable: false,
      executionLocked: true
    };
  }

  async recentTrades() {
    return db.select('dd_trades', 'order=closed_at.desc&limit=200');
  }

  async riskGate(signal, strategy, account, settings, openPositions, trades) {
    const reasons = [...(signal.blocked || [])];
    const continuous = settings.continuous_mode !== false;

    if (this.leaseEnforced && (!this.running || !this.leaseManager.isHeld)) {
      reasons.push('Trading lease not held');
    }

    if (strategy === 'MOMENTUM' || strategy === 'SCALPING') {
      const normalizedScore = Number(signal?.normalizedScore);
      const normalizedScorePass =
        Number.isFinite(normalizedScore) && normalizedScore >= 80;
      if (!normalizedScorePass) {
        reasons.push('Normalized score below 80 or unavailable');
      }
    }

    if (settings.emergency_stop) reasons.push('Emergency Stop');
    if (!settings.enabled || !settings.auto_trade) reasons.push('Auto OFF');
    const routeBlock = getExecutionRouteBlockReason(CONFIG.deltaExecutionMode);
    if (routeBlock) reasons.push(routeBlock);
    const duplicateBlocker = duplicatePositionBlocker(openPositions, signal.symbol);
    if (duplicateBlocker) reasons.push(duplicateBlocker);
    // There is deliberately no scanner-side global, per-engine, or total-open-position cap.
    // Actual platform/product/margin limits are still validated, and duplicate-symbol
    // protection prevents repeated same-instrument entries while a position is open.
    const optionsStrategy = strategy === 'OPTIONS_BUY' || strategy === 'OPTIONS_SELL';
    if (optionsStrategy) {
      const optionStage = String(signal?.stage || '').toUpperCase();
      if (optionStage !== 'CONFIRMED') reasons.push(`Signal stage ${optionStage || 'UNKNOWN'} is not CONFIRMED`);
      if (signal?.ready !== true) reasons.push('Signal ready flag is not true');
      if (signal?.underlyingReady !== true) reasons.push('Underlying signal is not ready (fresh-candle or risk gate failed)');
    } else if (!signal.candlesFresh) {
      reasons.push('Fresh closed candles unavailable');
    }
    if (n(account.equity) <= 0) reasons.push('Account equity unavailable');

    let size = null;
    if (strategy === 'OPTIONS_BUY') {
      const sizing = this.optionSizing(signal, account, settings);
      const qty = sizing.qty;
      if (qty < 1) reasons.push(sizing.reason || 'Full-premium risk budget below one contract');
      else size = {
        qty,
        notional: sizing.premiumNotional,
        risk: sizing.totalRisk,
        marginEstimate: sizing.premiumNotional,
        riskModel: 'FULL_PREMIUM_PLUS_TWO_SIDE_FEES'
      };
      if (signal.executionLocked) reasons.push('Option execution route locked');
      if (CONFIG.deltaExecutionMode === 'testnet' && signal.ticker?.testnet_product_verified !== true) {
        reasons.push('Option contract is not verified in the Delta Testnet product catalogue');
      }
    } else if (strategy === 'OPTIONS_SELL') {
      const sizing = this.optionSellSizing(signal, account, settings);
      if (sizing.qty < 1) reasons.push(sizing.reason || 'Defined-risk credit spread size is below one contract');
      else size = {
        qty: sizing.qty,
        notional: sizing.qty * sizing.netCreditPerContract,
        risk: sizing.totalRisk,
        marginEstimate: sizing.totalMarginReserve,
        riskModel: 'DEFINED_RISK_CREDIT_SPREAD_PLUS_FEES'
      };
      if (signal.definedRiskOnly !== true || !signal.hedgeSymbol || !signal.hedgeTicker) {
        reasons.push('A verified protective option leg is required; naked option selling is disabled');
      }
      if (signal.executionLocked) reasons.push('Option execution route locked');
      if (CONFIG.deltaExecutionMode === 'testnet' &&
          (signal.ticker?.testnet_product_verified !== true ||
           signal.hedgeTicker?.testnet_product_verified !== true)) {
        reasons.push('Both spread legs must match live Delta Testnet products');
      }
    } else if (signal.side) {
      const stage = String(signal?.stage || '').toUpperCase();
      const confirmedReady = stage === 'CONFIRMED' && signal?.ready === true;
      const stop = Number(signal?.sl);
      const target = Number(signal?.tp);

      if (stage !== 'CONFIRMED') reasons.push(`Signal stage ${stage || 'UNKNOWN'} is not CONFIRMED`);
      if (signal?.ready !== true) reasons.push('Signal ready flag is not true');

      if (!confirmedReady) {
        size = null;
      } else if (!(Number.isFinite(stop) && stop > 0)) {
        reasons.push('Invalid SL price (must be finite and > 0)');
      } else if (!(Number.isFinite(target) && target > 0)) {
        reasons.push('Invalid TP price (must be finite and > 0)');
      } else {
        size = this.positionSizing(signal, account, settings);
        if (!size) reasons.push('Margin / minimum contract size');
        if (n(signal.feeRiskRatio) > n(signal.costGateRatio)) reasons.push('Fee + spread exceeds 1R cost budget');
      }
    }

    // Tradetron route readiness is enforced above so a technical CONFIRMED
    // setup outside a configured bridge basket is never marked READY.

    // Scanner-side daily loss and daily trade-count quotas are disabled by request.
    // Keep emergency stop, per-trade sizing, margin, fee/slippage and signal-quality gates.

    if (!continuous) {
      // No fixed per-engine or total position cap. The non-continuous mode may
      // still apply signal-quality cooldown/expectancy throttles below.
      const symbolTrades = trades.filter(t => t.symbol === signal.symbol);
      const last = symbolTrades[0];
      if (last && Date.now() - new Date(last.closed_at || 0).getTime() < 15 * 60 * 1000) reasons.push('15m cooldown');
      if (last && n(last.net_pnl) < 0 && Date.now() - new Date(last.closed_at || 0).getTime() < 90 * 60 * 1000) reasons.push('90m losing-symbol cooldown');

      const recent = trades.filter(t => t.strategy === strategy).slice(0, 20);
      const wins = recent.filter(t => n(t.net_pnl) > 0).length;
      const recentNet = recent.reduce((s, t) => s + n(t.net_pnl), 0);
      if (recent.length >= 10 && (wins / recent.length < 0.35 || recentNet < 0)) reasons.push('Engine expectancy throttle');

      const losses = trades.filter(t => n(t.net_pnl) < 0).slice(0, 2);
      if (losses.length >= 2) {
        const a = new Date(losses[0].closed_at || 0).getTime();
        const b = new Date(losses[1].closed_at || 0).getTime();
        if (a >= b && a - b < 90 * 60 * 1000) reasons.push('2 consecutive losses');
      }
    }
    return { reasons: [...new Set(reasons)], size };
  }

  async refreshOptionTickers(settings = {}) {
    // Public India tickers supply quotes/Greeks. In Testnet mode every symbol
    // must first match a LIVE product from the Testnet catalogue so a public
    // production product_id can never leak into a future Testnet order.
    const testnetMode = CONFIG.deltaExecutionMode === 'testnet';
    const underlyings = testnetMode
      ? OPTION_UNDERLYINGS.filter(asset => ['BTC', 'ETH'].includes(asset))
      : [...OPTION_UNDERLYINGS];
    const now = Date.now();

    if (testnetMode && (
      !this.lastOptionProductFetch ||
      now - this.lastOptionProductFetch >= 5 * 60 * 1000
    )) {
      try {
        const products = await this.adapter.optionProducts();
        const productMap = new Map();
        for (const product of Array.isArray(products) ? products : []) {
          const symbol = String(product?.symbol || '').toUpperCase();
          const contractType = String(product?.contract_type || '').toLowerCase();
          const match = symbol.match(/^[CP]-([A-Z0-9]+)-/);
          if (!match || !['BTC', 'ETH'].includes(match[1]) ||
              !['call_options', 'put_options'].includes(contractType)) continue;
          if (product.state && String(product.state).toLowerCase() !== 'live') continue;

          const spot = n(this.tickerMap.get(match[1] + 'USD')?.mark_price ||
            this.tickerMap.get(match[1] + 'USD')?.close);
          const parsed = parseDeltaOptionSymbol(symbol, match[1], now);
          const productId = n(product.id ?? product.product_id);
          if (!parsed || !Number.isSafeInteger(productId) || productId <= 0 ||
              parsed.dte < Math.max(2, n(settings.options_min_days_to_expiry) || 2) ||
              parsed.dte > Math.max(2, n(settings.options_max_days_to_expiry) || 14) ||
              !(spot > 0) || Math.abs(parsed.strike - spot) / spot > 0.20) continue;

          productMap.set(symbol, {
            product_id: productId,
            contract_type: contractType,
            contract_value: product.contract_value,
            tick_size: product.tick_size,
            taker_commission_rate: product.taker_commission_rate,
            state: product.state || 'live',
            testnet_product_verified: true
          });
        }
        this.optionProductMap = productMap;
        this.lastOptionProductFetch = now;
      } catch (error) {
        this.optionProductMap.clear();
        this.lastOptionProductFetch = now;
        await this.log('WARN', 'Testnet option product catalogue unavailable; Options remain analysis-blocked', {
          error: String(error?.message || error).slice(0, 240)
        });
      }
    }

    const next = new Map();
    const counts = {};
    // Fetch one underlying at a time and retain only a small, near-the-money
    // 2–14 DTE chain so the Hostless 256 MB worker does not cache full chains.
    for (const underlying of underlyings) {
      try {
        const spotTicker = this.tickerMap.get(underlying + 'USD');
        const spot = n(spotTicker?.mark_price || spotTicker?.close);
        if (!(spot > 0)) {
          counts[underlying] = 0;
          continue;
        }

        const rows = await this.adapter.optionTickers(underlying);
        const joined = [];
        for (const ticker of Array.isArray(rows) ? rows : []) {
          const symbol = String(ticker?.symbol || '').toUpperCase();
          if (!symbol || !/^[CP]-/.test(symbol)) continue;
          const product = testnetMode ? this.optionProductMap.get(symbol) : null;
          if (testnetMode && !product) continue;
          joined.push({
            ...ticker,
            ...(product || {}),
            symbol,
            underlying,
            underlying_spot: spot
          });
        }

        const selected = selectOptionContractsForScan({
          rows: joined,
          underlying,
          spotPrice: spot,
          now,
          minDays: settings.options_min_days_to_expiry,
          maxDays: settings.options_max_days_to_expiry,
          maxContracts: 24,
          maxMoneynessPct: 20
        });
        counts[underlying] = selected.length;
        for (const ticker of selected) next.set(ticker.symbol, ticker);
      } catch (error) {
        counts[underlying] = 0;
        await this.log('WARN', 'Option chain refresh failed', {
          underlying,
          error: String(error?.message || error).slice(0, 240)
        });
      }
    }

    this.optionTickerMap = next;
    this.lastOptionTickerFetch = now;
    await this.log('INFO', 'Bounded option universe refreshed', {
      contracts: next.size,
      underlyings,
      counts,
      maxContractsPerUnderlying: 24,
      testnetProductCatalogueMatched: testnetMode
    });
  }

  optionRiskBudget(account, settings) {
    const equity = n(account?.equity);
    const pct = Math.max(0.05, n(settings.options_max_risk_pct || 0.30));
    return equity > 0 ? equity * pct / 100 : 0;
  }

  optionSizing(signal, account, settings) {
    const ticker = signal?.ticker || {};
    return calculateLongOptionSizing({
      equity: account?.equity,
      available: account?.available,
      ask: signal?.ask ?? ticker?.quotes?.best_ask ?? ticker?.best_ask ?? ticker?.ask,
      spotPrice: ticker?.underlying_spot,
      contractValue: ticker?.contract_value,
      riskPct: settings?.options_max_risk_pct ?? 0.30
    });
  }

  optionSellSizing(signal, account, settings) {
    const shortTicker = signal?.ticker || {};
    const hedgeTicker = signal?.hedgeTicker || {};
    return calculateCreditSpreadSizing({
      equity: account?.equity,
      available: account?.available,
      spotPrice: shortTicker?.underlying_spot,
      shortBid: signal?.bid ?? shortTicker?.quotes?.best_bid ?? shortTicker?.best_bid ?? shortTicker?.bid,
      hedgeAsk: signal?.hedgeAsk ?? hedgeTicker?.quotes?.best_ask ?? hedgeTicker?.best_ask ?? hedgeTicker?.ask,
      shortStrike: signal?.strike,
      hedgeStrike: signal?.hedgeStrike,
      shortContractValue: shortTicker?.contract_value,
      hedgeContractValue: hedgeTicker?.contract_value,
      riskPct: settings?.options_max_risk_pct ?? 0.30
    });
  }

  optionQuantity(signal, account, settings) {
    return this.optionSizing(signal, account, settings).qty;
  }

  pickOptionHedge(shortSignal, chain) {
    return chain
      .filter(x => String(x.optionType).toUpperCase() === String(shortSignal.optionType).toUpperCase())
      .filter(x => n(x.expiryMs) === n(shortSignal.expiryMs))
      .filter(x => n(x.mark) > 0 && n(x.ask) > 0 && n(x.strike) > 0)
      .filter(x => Math.abs(n(x.delta)) >= 0.05 && Math.abs(n(x.delta)) <= 0.15)
      .filter(x => shortSignal.optionType === 'CALL'
        ? n(x.strike) > n(shortSignal.strike)
        : n(x.strike) < n(shortSignal.strike))
      .sort((a, b) => Math.abs(Math.abs(n(a.delta)) - 0.10) - Math.abs(Math.abs(n(b.delta)) - 0.10))[0] || null;
  }


  async maintenanceLog(level, message, data = {}) {
    const writer = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    writer(message);
    try {
      await this.log(level, message, data);
    } catch (error) {
      console.warn('[Maintenance] Log persistence failed:', safeMaintenanceError(error));
    }
  }

  async getMaintenancePool() {
    if (!hasMaintenanceDatabaseUrl()) return null;
    if (this.maintenancePool) return this.maintenancePool;
    if (!this.maintenancePoolPromise) {
      this.maintenancePoolPromise = import('../src/ledger/pg-adapter.mjs')
        .then(adapter => {
          this.maintenancePool = adapter.pool;
          this.closeMaintenancePool = adapter.closePool;
          return adapter.pool;
        })
        .catch(error => {
          this.maintenancePoolPromise = null;
          throw error;
        });
    }
    return this.maintenancePoolPromise;
  }

  startMaintenanceTasks() {
    if (this.maintenanceStarted) return;
    this.maintenanceStarted = true;

    if (!hasMaintenanceDatabaseUrl()) {
      const retentionMessage = '[Retention] Retention disabled (no DATABASE_URL or SUPABASE_DB_URL)';
      const diskMessage = '[Disk] Disk monitor disabled (no DATABASE_URL or SUPABASE_DB_URL)';
      console.warn(retentionMessage);
      console.warn(diskMessage);
      void this.log('WARN', retentionMessage, {}).catch(() => {});
      void this.log('WARN', diskMessage, {}).catch(() => {});
      return;
    }

    if (RETENTION_ENABLED) {
      this.retentionStartupTimer = setTimeout(() => {
        this.retentionStartupTimer = null;
        void (async () => {
          await this.runSignalRetention({ reason: 'startup' });
          if (this.running && !this.retentionInterval) {
            this.retentionInterval = setInterval(() => {
              void this.runSignalRetention({ reason: 'scheduled' });
            }, RETENTION_INTERVAL_MS);
            this.retentionInterval.unref?.();
          }
        })().catch(error => {
          console.warn('[Retention] Scheduler error; worker continues:', safeMaintenanceError(error));
        });
      }, MAINTENANCE_START_DELAY_MS);
      this.retentionStartupTimer.unref?.();
    } else {
      const message = '[Retention] Retention disabled (RETENTION_ENABLED=false)';
      console.warn(message);
      void this.log('WARN', message, {}).catch(() => {});
    }

    this.diskMonitorInterval = setInterval(() => {
      void this.checkDiskHealth();
    }, DISK_MONITOR_INTERVAL_MS);
    this.diskMonitorInterval.unref?.();
  }

  async runSignalRetention({ daysOverride = null, reason = 'scheduled' } = {}) {
    if (!hasMaintenanceDatabaseUrl()) {
      await this.maintenanceLog('WARN', '[Retention] Retention disabled (no DATABASE_URL or SUPABASE_DB_URL)', { reason });
      return;
    }
    if (!RETENTION_ENABLED) {
      await this.maintenanceLog('WARN', '[Retention] Skipped because RETENTION_ENABLED=false', { reason });
      return;
    }

    const requestedDays = Number.isInteger(daysOverride) && daysOverride >= 1 && daysOverride <= 3650
      ? daysOverride
      : RETENTION_DAYS;

    if (this.retentionInFlight) {
      if (requestedDays < (this.retentionInFlightDays ?? RETENTION_DAYS) &&
          (!this.pendingRetentionRequest || requestedDays < this.pendingRetentionRequest.days)) {
        this.pendingRetentionRequest = { daysOverride: requestedDays, days: requestedDays, reason };
      }
      await this.retentionInFlight;
      return;
    }

    const runStartedAt = iso();
    this.retentionInFlightDays = requestedDays;
    this.retentionInFlight = this.performSignalRetention(requestedDays, reason);
    let result = { success: false, effectiveDays: requestedDays, totalDeleted: 0, totalEngineLogsDeleted: 0 };
    let effectiveDays = requestedDays;
    try {
      result = await this.retentionInFlight;
      effectiveDays = result?.effectiveDays ?? requestedDays;
    } catch (error) {
      result = { success: false, effectiveDays, totalDeleted: 0, totalEngineLogsDeleted: 0 };
      await this.maintenanceLog('WARN', '[Retention] Task failed; worker continues: ' + safeMaintenanceError(error), { reason });
    } finally {
      this.retentionInFlight = null;
      this.retentionInFlightDays = null;
    }

    const rowsDeleted = Number.isSafeInteger(result?.totalDeleted) && result.totalDeleted >= 0
      ? result.totalDeleted
      : 0;
    const engineLogRowsDeleted = Number.isSafeInteger(result?.totalEngineLogsDeleted) && result.totalEngineLogsDeleted >= 0
      ? result.totalEngineLogsDeleted
      : 0;
    await this.maintenanceLog(result?.success === true ? 'INFO' : 'WARN', '[Retention] Run summary', {
      status: result?.success === true ? 'SUCCESS' : 'FAILURE',
      runStartedAt,
      runCompletedAt: iso(),
      rowsDeleted,
      engineLogRowsDeleted,
      configDays: RETENTION_DAYS,
      effectiveDays,
      reason
    });

    const pending = this.pendingRetentionRequest;
    this.pendingRetentionRequest = null;
    if (pending && pending.days < effectiveDays && this.running) {
      await this.runSignalRetention({ daysOverride: pending.daysOverride, reason: pending.reason });
    }
  }

  async performSignalRetention(requestedDays, reason) {
    const startedAt = Date.now();
    let totalDeleted = 0;
    let totalEngineLogsDeleted = 0;
    let effectiveDays = requestedDays;

    try {
      const pool = await this.getMaintenancePool();
      if (!pool) {
        await this.maintenanceLog('WARN', '[Retention] Retention disabled (no DATABASE_URL)', { reason });
        return { success: false, effectiveDays, totalDeleted, totalEngineLogsDeleted };
      }

      const countResult = await pool.query('SELECT COUNT(*)::text AS signal_rows FROM public.dd_signals');
      const rowCount = Number(countResult.rows?.[0]?.signal_rows || 0);
      if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
        throw new Error('Retention query returned an invalid dd_signals row count');
      }
      if (rowCount > DISK_CRITICAL_ROWS) {
        // A row-count alarm must not silently shrink a configured 7-day sample
        // window to 1 day. Disk monitoring pauses new history writes before the
        // database approaches its provider limit; retention only removes rows
        // older than the configured window.
        await this.maintenanceLog('WARN',
          `[Retention] Critical row-count threshold exceeded (${rowCount}); preserving the configured ${effectiveDays}-day history window`,
          { reason, signalRows: rowCount, requestedDays, effectiveDays });
      } else {
        await this.maintenanceLog('INFO',
          `[Retention] Starting ${effectiveDays}-day dd_signals retention`,
          { reason, signalRows: rowCount, batchSize: RETENTION_BATCH_SIZE });
      }

      while (true) {
        const result = await pool.query(SIGNAL_RETENTION_DELETE_SQL, [effectiveDays, RETENTION_BATCH_SIZE]);
        const deleted = Array.isArray(result.rows) ? result.rows.length : 0;
        totalDeleted += deleted;
        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        await this.maintenanceLog('INFO',
          `[Retention] Deleted ${deleted} rows (total ${totalDeleted}, elapsed ${elapsedSeconds}s)`,
          { reason, batch: deleted, totalDeleted, elapsedSeconds: Number(elapsedSeconds), retentionDays: effectiveDays });

        if (deleted === 0 || deleted < RETENTION_BATCH_SIZE) break;
        await sleep(100);
      }

      while (true) {
        const logResult = await pool.query(ENGINE_LOG_RETENTION_DELETE_SQL, [effectiveDays, RETENTION_BATCH_SIZE]);
        const deleted = Array.isArray(logResult.rows) ? logResult.rows.length : 0;
        totalEngineLogsDeleted += deleted;
        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        await this.maintenanceLog('INFO',
          `[Retention] Deleted ${deleted} engine log rows (total ${totalEngineLogsDeleted}, elapsed ${elapsedSeconds}s)`,
          { reason, batch: deleted, totalDeleted: totalEngineLogsDeleted, elapsedSeconds: Number(elapsedSeconds), retentionDays: effectiveDays });
        if (deleted === 0 || deleted < RETENTION_BATCH_SIZE) break;
        await sleep(100);
      }

      return { success: true, effectiveDays, totalDeleted, totalEngineLogsDeleted };
    } catch (error) {
      await this.maintenanceLog('WARN',
        '[Retention] Task failed; worker continues: ' + safeMaintenanceError(error),
        { reason, totalDeleted, totalEngineLogsDeleted, retentionDays: effectiveDays });
      return { success: false, effectiveDays, totalDeleted, totalEngineLogsDeleted };
    }
  }

  async checkDiskHealth() {
    if (!hasMaintenanceDatabaseUrl()) {
      await this.maintenanceLog('WARN', '[Disk] Disk monitor disabled (no DATABASE_URL or SUPABASE_DB_URL)', {});
      return;
    }

    try {
      const pool = await this.getMaintenancePool();
      if (!pool) return;
      const result = await pool.query(`
        SELECT
          pg_database_size(current_database()) AS db_bytes,
          COUNT(*)::text AS signal_rows,
          COUNT(*) FILTER (
            WHERE captured_at < NOW() - (INTERVAL '1 day' * $1::int)
          )::text AS expired_rows
        FROM public.dd_signals
      `, [RETENTION_DAYS]);
      const row = result.rows?.[0] || {};
      const dbBytes = Number(row.db_bytes);
      const signalRows = Number(row.signal_rows);
      const expiredRows = Number(row.expired_rows);
      if (!Number.isFinite(dbBytes) || !Number.isSafeInteger(signalRows) || signalRows < 0 ||
          !Number.isSafeInteger(expiredRows) || expiredRows < 0) {
        throw new Error('Disk health query returned invalid size or dd_signals counts');
      }

      const dbMb = dbBytes / MB_BYTES;
      await this.maintenanceLog('INFO',
        `[Disk] DB: ${dbMb.toFixed(1)} MB, signals: ${signalRows} rows, expired_${RETENTION_DAYS}d: ${expiredRows}`,
        {
          signalRows,
          expiredRows,
          retentionDays: RETENTION_DAYS,
          dbBytes,
          dbMb: Number(dbMb.toFixed(2)),
          warnRows: DISK_WARN_ROWS,
          criticalRows: DISK_CRITICAL_ROWS,
          olderRowsTrigger: RETENTION_OLD_ROWS_TRIGGER,
          pauseAtMb: SIGNAL_HISTORY_PAUSE_DB_MB,
          resumeAtMb: SIGNAL_HISTORY_RESUME_DB_MB,
          historyWritesPaused: this.signalHistoryWritesPaused
        });

      if (dbMb >= SIGNAL_HISTORY_PAUSE_DB_MB && !this.signalHistoryWritesPaused) {
        this.signalHistoryWritesPaused = true;
        await this.maintenanceLog('WARN',
          `[Disk] Database reached ${dbMb.toFixed(1)} MB; pausing new dd_signals history writes to protect provider capacity`,
          { dbMb: Number(dbMb.toFixed(2)), pauseAtMb: SIGNAL_HISTORY_PAUSE_DB_MB, signalRows });
      } else if (this.signalHistoryWritesPaused && dbMb <= SIGNAL_HISTORY_RESUME_DB_MB) {
        this.signalHistoryWritesPaused = false;
        await this.maintenanceLog('INFO',
          `[Disk] Database fell to ${dbMb.toFixed(1)} MB; resuming dd_signals history writes`,
          { dbMb: Number(dbMb.toFixed(2)), resumeAtMb: SIGNAL_HISTORY_RESUME_DB_MB, signalRows });
      }

      if (signalRows > DISK_WARN_ROWS) {
        await this.maintenanceLog('WARN',
          `[Disk] WARNING: signal row count ${signalRows} exceeds ${DISK_WARN_ROWS}`,
          { signalRows, thresholdRows: DISK_WARN_ROWS, expiredRows });
      }

      if (signalRows > DISK_CRITICAL_ROWS) {
        await this.maintenanceLog('WARN',
          `[Disk] CRITICAL: signal row count ${signalRows} exceeds ${DISK_CRITICAL_ROWS}; requesting configured ${RETENTION_DAYS}-day retention`,
          { signalRows, thresholdRows: DISK_CRITICAL_ROWS, expiredRows, retentionDays: RETENTION_DAYS });
        await this.runSignalRetention({ reason: 'row-count-critical' });
      } else if (expiredRows > RETENTION_OLD_ROWS_TRIGGER) {
        await this.maintenanceLog('WARN',
          `[Disk] Retention backlog: ${expiredRows} rows older than configured ${RETENTION_DAYS}-day window exceeds ${RETENTION_OLD_ROWS_TRIGGER}; requesting configured retention`,
          { signalRows, expiredRows, thresholdRows: RETENTION_OLD_ROWS_TRIGGER, retentionDays: RETENTION_DAYS });
        await this.runSignalRetention({ reason: 'retention-window-backlog' });
      }
    } catch (error) {
      await this.maintenanceLog('WARN',
        '[Disk] Monitor check failed; worker continues: ' + safeMaintenanceError(error),
        {});
    }
  }

  async stopMaintenanceTasks() {
    if (this.retentionStartupTimer) clearTimeout(this.retentionStartupTimer);
    if (this.retentionInterval) clearInterval(this.retentionInterval);
    if (this.diskMonitorInterval) clearInterval(this.diskMonitorInterval);
    this.retentionStartupTimer = null;
    this.retentionInterval = null;
    this.diskMonitorInterval = null;

    if (this.closeMaintenancePool) {
      try {
        await this.closeMaintenancePool();
      } catch (error) {
        console.warn('[Maintenance] Failed to close PostgreSQL pool:', safeMaintenanceError(error));
      }
    }
    this.maintenancePool = null;
    this.maintenancePoolPromise = null;
    this.closeMaintenancePool = null;
  }

  isDuplicateSignalObservation(row, now = Date.now()) {
    if (!DEDUP_ENABLED) return false;
    const key = `${String(row?.symbol || '').toUpperCase()}:${String(row?.strategy || '').toUpperCase()}`;
    const cached = this.signalDedupCache.get(key);
    if (!cached) return false;
    const elapsed = now - cached.insertedAt;
    const withinSampleWindow = Number.isFinite(elapsed) && elapsed >= 0 &&
      elapsed < SIGNAL_HISTORY_SAMPLE_MINUTES * 60 * 1000;
    // Keep one persisted observation per symbol/strategy per sample window.
    // Stage/side transitions still affect live decisions immediately, but do not bypass this history-only cap.
    return withinSampleWindow;
  }

  rememberSignalObservation(row, insertedAt = Date.now()) {
    if (!DEDUP_ENABLED) return;
    const key = `${String(row?.symbol || '').toUpperCase()}:${String(row?.strategy || '').toUpperCase()}`;
    if (!key || key === ':') return;
    if (this.signalDedupCache.has(key)) this.signalDedupCache.delete(key);
    this.signalDedupCache.set(key, {
      score: n(row?.score),
      stage: String(row?.stage || ''),
      side: String(row?.side || ''),
      insertedAt
    });
    while (this.signalDedupCache.size > DEDUP_CACHE_MAX) {
      const oldest = this.signalDedupCache.keys().next().value;
      if (oldest === undefined) break;
      this.signalDedupCache.delete(oldest);
    }
  }

  async hydrateSignalDedupCache() {
    if (this.signalHistoryStateHydrated) return this.signalDedupCache.size;
    this.signalHistoryStateHydrated = true;
    try {
      // The worker may restart between scheduled GitHub Actions sessions. Warm the
      // sampler from persisted history so each session does not repeat a full-universe burst.
      const rows = await db.select('dd_signals',
        'select=symbol,strategy,score,stage,side,captured_at&order=captured_at.desc&limit=1000');
      const seen = new Set();
      for (const row of Array.isArray(rows) ? rows : []) {
        const symbol = String(row?.symbol || '').toUpperCase();
        const strategy = String(row?.strategy || '').toUpperCase();
        const key = symbol + ':' + strategy;
        const capturedAt = Date.parse(row?.captured_at || '');
        if (!symbol || !strategy || seen.has(key) || !Number.isFinite(capturedAt)) continue;
        this.rememberSignalObservation(row, capturedAt);
        seen.add(key);
      }
      console.log(`[Dedup] Hydrated persisted signal history state for ${seen.size} symbol/strategy pairs`);
      return seen.size;
    } catch (error) {
      const message = safeMaintenanceError(error);
      console.warn('[Dedup] Persisted history hydration failed; first scan may write extra samples:', message);
      await this.log('WARN', 'Persisted signal-history dedup hydration failed; first scan may write extra samples', {
        error: message
      });
      return 0;
    }
  }

  async insertSignalHistoryRow(row) {
    this.dedupTotalCandidates += 1;
    if (this.signalHistoryWritesPaused) {
      this.dedupSkippedCount += 1;
      return false;
    }
    let duplicate = false;
    try {
      duplicate = this.isDuplicateSignalObservation(row);
    } catch (error) {
      console.warn('[Dedup] Cache check failed; persisting observation:', safeMaintenanceError(error));
    }
    if (duplicate) {
      this.dedupSkippedCount += 1;
      return false;
    }

    await db.insert('dd_signals', row);
    this.dedupInsertedCount += 1;
    try {
      this.rememberSignalObservation(row);
    } catch (error) {
      console.warn('[Dedup] Cache update failed; persistence succeeded:', safeMaintenanceError(error));
    }
    return true;
  }

  async insertSignalHistoryBatch(rows) {
    const candidates = Array.isArray(rows) ? rows : [];
    this.dedupTotalCandidates += candidates.length;
    if (this.signalHistoryWritesPaused) {
      this.dedupSkippedCount += candidates.length;
      return 0;
    }
    const acceptedByKey = new Map();
    const acceptedWithoutKey = [];

    for (const row of candidates) {
      const symbol = String(row?.symbol || '').toUpperCase();
      const strategy = String(row?.strategy || '').toUpperCase();
      const key = symbol + ':' + strategy;
      if (!symbol || !strategy) {
        acceptedWithoutKey.push(row);
        continue;
      }
      if (acceptedByKey.has(key)) {
        // Keep the latest observation for a key if a single analysis batch contains duplicates.
        this.dedupSkippedCount += 1;
        acceptedByKey.set(key, row);
        continue;
      }

      let duplicate = false;
      try {
        duplicate = this.isDuplicateSignalObservation(row);
      } catch (error) {
        // A broken cache must not suppress a database write.
        console.warn('[Dedup] Cache check failed; persisting observation:', safeMaintenanceError(error));
      }
      if (duplicate) {
        this.dedupSkippedCount += 1;
      } else {
        acceptedByKey.set(key, row);
      }
    }

    const accepted = [...acceptedByKey.values(), ...acceptedWithoutKey];
    if (accepted.length === 0) return 0;
    await db.insertMany('dd_signals', accepted);
    this.dedupInsertedCount += accepted.length;
    for (const row of accepted) {
      try {
        this.rememberSignalObservation(row);
      } catch (error) {
        console.warn('[Dedup] Cache update failed; persistence succeeded:', safeMaintenanceError(error));
      }
    }
    return accepted.length;
  }

  async logDedupStatsIfDue() {
    if (this.dedupAnalysisCycles === 0 || this.dedupAnalysisCycles % 1000 !== 0) return;
    const reduction = this.dedupTotalCandidates
      ? (this.dedupSkippedCount / this.dedupTotalCandidates) * 100
      : 0;
    const message = `[Dedup] Skipped ${this.dedupSkippedCount} / ${this.dedupTotalCandidates} (${reduction.toFixed(1)}% reduction)`;
    console.log(message);
    try {
      await this.log('INFO', message, {
        analysisCycles: this.dedupAnalysisCycles,
        totalCandidates: this.dedupTotalCandidates,
        skippedCount: this.dedupSkippedCount,
        insertedCount: this.dedupInsertedCount,
        reductionPct: Number(reduction.toFixed(2))
      });
    } catch (error) {
      console.warn('[Dedup] Stats logging failed; worker continues:', safeMaintenanceError(error));
    }
  }

  async analyseOptions(futuresItems, account, settings, openPositions) {
    if (settings.options_enabled === false) {
      this.lastOptionSignals = [];
      return [];
    }
    const cfg = {
      buyMinDelta: settings.options_buy_min_delta,
      buyMaxDelta: settings.options_buy_max_delta,
      sellMinDelta: settings.options_sell_min_delta,
      sellMaxDelta: settings.options_sell_max_delta,
      minOi: settings.options_min_oi,
      minVolume: settings.options_min_volume,
      maxSpreadPct: settings.options_max_spread_pct,
      minDays: settings.options_min_days_to_expiry,
      maxDays: settings.options_max_days_to_expiry,
      scoreMin: Math.max(80, n(settings.score_min || 80)),
      buyStopPct: settings.options_buy_stop_pct,
      buyTp1Pct: settings.options_buy_tp1_pct,
      buyTpPct: settings.options_buy_tp_pct
    };
    const chains = new Map();
    for (const ticker of this.optionTickerMap.values()) {
      const rawAsset = String(ticker.underlying || '').toUpperCase();
      const optionSymbol = String(ticker.symbol || '').toUpperCase();
      const parts = optionSymbol.split('-');
      const asset = rawAsset || parts[1] || optionSymbol;
      if (!asset) continue;
      if (!chains.has(asset)) chains.set(asset, []);
      chains.get(asset).push(ticker);
    }

    const out = [];
    for (const item of futuresItems || []) {
      const underlying = [item.mom, item.scalp].filter(Boolean).sort((a, b) => n(b.score) - n(a.score))[0];
      const asset = String(item.ticker?.symbol || '').toUpperCase().replace(/USD$/, '');
      if (!OPTION_UNDERLYINGS.includes(asset)) continue;
      const chain = chains.get(asset) || [];
      if (!underlying || !chain.length) continue;

      if (settings.options_buy_enabled !== false) {
        const candidates = chain
          .map(ticker => ({ ticker, signal: analyseOption(ticker, underlying, 'OPTIONS_BUY', cfg) }))
          .filter(x => x.signal.targetType === (underlying.side === 'BUY' ? 'CALL' : 'PUT'))
          .sort((a, b) => n(b.signal.score) - n(a.signal.score));
        const best = candidates[0];
        if (best) {
          const s = best.signal;
          const sizing = this.optionSizing({ ...s, ticker: best.ticker }, account, settings);
          const q = sizing.qty;
          const duplicate = (openPositions || []).some(p => String(p.symbol) === s.symbol && n(p.qty) > 0);
          const routeConfigured = false;
          const executionLocked = true;
          const blocked = [...s.blocked];
          if (q < 1) blocked.push(sizing.reason || 'Full-premium risk budget below one contract');
          if (duplicate) blocked.push('Duplicate option position');
          blocked.push('Direct Delta Testnet single-leg option order lifecycle is not verified');
          blocked.push(OPTIONS_EXECUTION_LOCK_REASON);
          const ready = s.ready && q >= 1 && !duplicate && routeConfigured && !executionLocked;
          const row = { ...s, ticker: best.ticker, strategy: 'OPTIONS_BUY', qty: q,
            notional: sizing.premiumNotional,
            risk: sizing.totalRisk,
            blocked, executionLocked, ready };
          await this.insertSignalHistoryRow({
            symbol: row.symbol, product_id: n(best.ticker.product_id || best.ticker.id),
            rank: 1, strategy: 'OPTIONS_BUY', price: row.mark, change_24h: row.underlyingChange,
            turnover_usd: n(best.ticker.turnover_usd || best.ticker.turnover), spread_pct: row.spreadPct,
            volume_spike: row.volume, score: row.score, stage: row.stage, side: 'BUY',
            rsi: underlying.rsi, trend: underlying.trend, confirm_trend: underlying.confirmTrend,
            btc_trend: underlying.btcTrend, ema21: underlying.ema21, atr_5m: underlying.atr5,
            atr_15m: underlying.atr15, support: underlying.support, resistance: underlying.resistance,
            stop_price: row.sl, tp1_price: row.tp1, tp_price: row.tp, qty_contracts: row.qty,
            notional: row.notional, risk_usd: row.risk, fee_risk_ratio: 0, ready,
            blocked_reasons: blocked,
            details: trimDetails({ engine: 'OPTIONS_BUY', optionType: row.optionType, strike: row.strike,
              dte: row.dte, expiryMs: row.expiryMs, delta: row.delta, gamma: row.gamma, theta: row.theta,
              vega: row.vega, bid: row.bid, ask: row.ask, openInterest: row.oi, volume: row.volume,
              underlyingSymbol: row.underlyingSymbol, underlyingScore: row.underlyingScore,
              executionLocked, routeConfigured, signalOnly: CONFIG.signalOnly, testnetProductVerified: best.ticker.testnet_product_verified === true, riskModel: 'FULL_PREMIUM_PLUS_TWO_SIDE_FEES' }, 'OPTIONS_BUY')
          });
          out.push(row);
        }
      }

      if (settings.options_sell_enabled !== false) {
        const candidates = chain
          .map(ticker => ({ ticker, signal: analyseOption(ticker, underlying, 'OPTIONS_SELL', cfg) }))
          .filter(x => x.signal.targetType === (underlying.side === 'BUY' ? 'PUT' : 'CALL'))
          .sort((a, b) => n(b.signal.score) - n(a.signal.score));
        const best = candidates[0];
        if (best) {
          const s = best.signal;
          const hedge = this.pickOptionHedge(s,
            chain.map(ticker => analyseOption(ticker, underlying, 'OPTIONS_SELL', cfg)));
          const hedgeTicker = hedge
            ? chain.find(ticker => String(ticker.symbol).toUpperCase() === String(hedge.symbol).toUpperCase()) || null
            : null;
          const hedgeAsk = hedge?.ask || 0;
          const credit = hedge ? n(s.bid) - n(hedgeAsk) : 0;
          const width = hedge ? Math.abs(n(s.strike) - n(hedge.strike)) : 0;
          const definedRiskOnly = settings.options_sell_defined_risk_only !== false &&
            !!hedge && !!hedgeTicker && width > 0;
          const sizing = this.optionSellSizing({
            ...s,
            ticker: best.ticker,
            hedgeTicker,
            hedgeSymbol: hedge?.symbol || '',
            hedgeStrike: hedge?.strike || 0,
            hedgeAsk
          }, account, settings);
          const q = sizing.qty;
          const bothProductsVerified = best.ticker?.testnet_product_verified === true &&
            hedgeTicker?.testnet_product_verified === true;
          const duplicateShort = (openPositions || []).some(p =>
            String(p.symbol).toUpperCase() === String(s.symbol).toUpperCase() && n(p.qty) > 0);
          const duplicateHedge = hedge?.symbol && (openPositions || []).some(p =>
            String(p.symbol).toUpperCase() === String(hedge.symbol).toUpperCase() && n(p.qty) > 0);
          const optionRouteReady = false;
          const executionLocked = true;
          const blocked = [...s.blocked];
          if (!definedRiskOnly) blocked.push('A same-expiry protective wing is mandatory; naked option selling is disabled');
          if (!(credit > 0)) blocked.push('Net credit is not positive after hedge premium');
          if (q < 1) blocked.push(sizing.reason || 'Defined-risk spread size is below one contract');
          if (CONFIG.deltaExecutionMode === 'testnet' && !bothProductsVerified) {
            blocked.push('Both short and protective legs must match live Delta Testnet products');
          }
          if (duplicateShort || duplicateHedge) blocked.push('One of the option spread legs already has an open position');
          blocked.push('Direct Delta Testnet paired-leg order, fill and unwind lifecycle is not verified');
          blocked.push(OPTIONS_EXECUTION_LOCK_REASON);
          const ready = s.ready && definedRiskOnly && credit > 0 && q >= 1 &&
            bothProductsVerified && !duplicateShort && !duplicateHedge &&
            optionRouteReady && !executionLocked;
          const row = {
            ...s,
            ticker: best.ticker,
            hedgeTicker,
            strategy: 'OPTIONS_SELL',
            qty: q,
            hedgeSymbol: hedge?.symbol || '',
            hedgeStrike: hedge?.strike || 0,
            hedgeDelta: hedge?.delta || 0,
            hedgeAsk,
            hedgeProductId: n(hedgeTicker?.product_id || hedgeTicker?.id) || null,
            credit,
            maxRiskPerSpread: sizing.maxLossPerContract,
            marginReservePerSpread: sizing.marginReservePerContract,
            entryFeesPerSpread: sizing.entryFeesPerContract,
            exitFeeReservePerSpread: sizing.exitFeeReservePerContract,
            notional: q * sizing.netCreditPerContract,
            risk: sizing.totalRisk,
            marginEstimate: sizing.totalMarginReserve,
            definedRiskOnly,
            blocked,
            executionLocked,
            ready,
            optionRouteReady,
            riskModel: 'DEFINED_RISK_CREDIT_SPREAD_PLUS_FEES'
          };
          await this.insertSignalHistoryRow({
            symbol: row.symbol, product_id: n(best.ticker.product_id || best.ticker.id),
            rank: 1, strategy: 'OPTIONS_SELL', price: row.mark, change_24h: row.underlyingChange,
            turnover_usd: n(best.ticker.turnover_usd || best.ticker.turnover), spread_pct: row.spreadPct,
            volume_spike: row.volume, score: row.score, stage: row.stage, side: 'SELL',
            rsi: underlying.rsi, trend: underlying.trend, confirm_trend: underlying.confirmTrend,
            btc_trend: underlying.btcTrend, ema21: underlying.ema21, atr_5m: underlying.atr5,
            atr_15m: underlying.atr15, support: underlying.support, resistance: underlying.resistance,
            stop_price: 0, tp1_price: 0, tp_price: 0, qty_contracts: row.qty,
            notional: row.notional, risk_usd: row.risk, fee_risk_ratio: 0, ready: row.ready,
            blocked_reasons: blocked,
            details: trimDetails({
              engine: 'OPTIONS_SELL',
              optionType: row.optionType,
              strike: row.strike,
              expiryMs: row.expiryMs,
              dte: row.dte,
              delta: row.delta,
              bid: row.bid,
              ask: row.ask,
              hedgeSymbol: row.hedgeSymbol,
              hedgeProductId: row.hedgeProductId,
              hedgeStrike: row.hedgeStrike,
              hedgeDelta: row.hedgeDelta,
              hedgeAsk: row.hedgeAsk,
              credit: row.credit,
              maxRiskPerSpread: row.maxRiskPerSpread,
              marginReservePerSpread: row.marginReservePerSpread,
              estimatedFeesPerSpread: row.entryFeesPerSpread + row.exitFeeReservePerSpread,
              definedRiskOnly: row.definedRiskOnly,
              executionLocked,
              optionRouteReady,
              signalOnly: CONFIG.signalOnly,
              riskModel: row.riskModel
            }, 'OPTIONS_SELL')
          });
          out.push(row);
        }
      }
    }
    this.lastOptionSignals = out;
    return out;
  }

  async analyseUniverse(account, settings, openPositions, trades) {
    this.dedupAnalysisCycles += 1;
    const btc = this.btcSymbol();
    if (!btc) {
      this.lastSignals = [];
      await this.log('WARN', 'BTC regime unavailable; entries fail closed', {});
      await this.logDedupStatsIfDue();
      return;
    }
    const btc5 = this.getCandles(btc, '5m');
    const btc15 = this.getCandles(btc, '15m');

    // Shadow-only hourly BTC regime: deliberately separate from the legacy
    // btc5/btc15 arrays passed into analyse(), so live signal decisions remain unchanged.
    let shadowRegime = null;
    const btc1h = this.getCandles('BTCUSD', '1h');
    if (btc1h && btc1h.length >= 201) {
      try {
        const btcTicker = this.tickerMap.get('BTCUSD') || this.tickerMap.get(btc);
        const currentBtcPrice = n(btcTicker?.mark_price || btcTicker?.close || btcTicker?.price);
        const result = gateBTCRegime(btc1h, currentBtcPrice);
        shadowRegime = {
          btcRegime: result.regime ?? 'UNAVAILABLE',
          btcRegimeStatus: result.status ?? 'BLOCK',
          btcRegimeReason: result.reason ?? 'BTC shadow regime returned no reason',
          btcRegimeSource: 'live-1h',
          btcAtrPct: Number.isFinite(result.observed) ? result.observed : null,
          btcRegimeComputedAt: new Date().toISOString()
        };
      } catch (err) {
        console.warn('[DeltaScanner] BTC shadow regime failed:', String(err?.message || err).slice(0, 240));
      }
    }

    const out = [];
    const signalCacheRows = [];
    const signalHistoryRows = [];
    const tickers = [...this.tickerMap.values()].filter(ticker =>
      this.candleCacheSymbols.has(String(ticker.symbol || '').toUpperCase())
    );

    // Shadow pre-pass computes normalized scores from unchanged feature data.
    // The final analysis pass consumes each score for the normalized readiness
    // gate; feature extraction in this pre-pass does not depend on stage/ready.
    const normalizationUniverses = { MOMENTUM: [], SCALPING: [] };
    for (const ticker of tickers) {
      const product = this.productMap.get(ticker.symbol);
      if (!product) continue;
      const c1 = this.getCandles(ticker.symbol, '1m');
      const c5 = this.getCandles(ticker.symbol, '5m');
      const c15 = this.getCandles(ticker.symbol, '15m');
      const momShadow = analyse(ticker, product, c1, c5, c15, btc5, btc15, 'MOMENTUM', {
        minStopPct: n(settings.momentum_sl_min_pct || 0.95),
        rr: n(settings.momentum_rr || 2.0),
        volumeMin: n(settings.volume_min || 0.75),
        antiChasePct: n(settings.anti_chase_pct || 15),
        rangeAtrMax: n(settings.range_atr_max || 4.0),
        emaDistanceMax: n(settings.ema_distance_max || 3.5),
        spreadMaxPct: n(settings.spread_max_pct || 0.35),
        costGateRatio: 0.20,
        btcOverrideScoreMin: n(settings.btc_override_score_min || 90),
        btcOverrideVolumeMin: n(settings.btc_override_volume_min || 1.5)
      });
      const scalpShadow = analyse(ticker, product, c1, c5, c15, btc5, btc15, 'SCALPING', {
        minStopPct: n(settings.scalping_sl_min_pct || 0.75),
        rr: n(settings.scalping_rr || 2.0),
        volumeMin: n(settings.volume_min || 1.25),
        antiChasePct: n(settings.anti_chase_pct || 15),
        rangeAtrMax: n(settings.range_atr_max || 3.0),
        emaDistanceMax: n(settings.ema_distance_max || 2.5),
        spreadMaxPct: n(settings.spread_max_pct || 0.35),
        costGateRatio: 0.25,
        btcOverrideScoreMin: n(settings.btc_override_score_min || 90),
        btcOverrideVolumeMin: n(settings.btc_override_volume_min || 1.5)
      });
      normalizationUniverses.MOMENTUM.push(momShadow);
      normalizationUniverses.SCALPING.push(scalpShadow);
    }
    const normalizedScores = new Map();
    for (const strategyName of ['MOMENTUM', 'SCALPING']) {
      const universe = normalizationUniverses[strategyName];
      const scores = calculateNormalizedScores(universe);
      for (const signal of universe) {
        normalizedScores.set(strategyName + ':' + signal.symbol, scores.get(String(signal.symbol || '').toUpperCase()) ?? null);
      }
    }

    // Keep the original sequential signal -> riskGate -> cache order below.
    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i], p = this.productMap.get(ticker.symbol);
      if (!p) continue;
      const c1 = this.getCandles(ticker.symbol, '1m');
      const c5 = this.getCandles(ticker.symbol, '5m');
      const c15 = this.getCandles(ticker.symbol, '15m');
      const momNormalizedScore =
        normalizedScores.get('MOMENTUM:' + ticker.symbol) ?? null;
      const scalpNormalizedScore =
        normalizedScores.get('SCALPING:' + ticker.symbol) ?? null;
      const mom = analyse(ticker, p, c1, c5, c15, btc5, btc15, 'MOMENTUM', {
        minStopPct: n(settings.momentum_sl_min_pct || 0.95),
        rr: n(settings.momentum_rr || 2.0),
        normalizedScore: momNormalizedScore,
        volumeMin: n(settings.volume_min || 0.75),
        antiChasePct: n(settings.anti_chase_pct || 15),
        rangeAtrMax: n(settings.range_atr_max || 4.0),
        emaDistanceMax: n(settings.ema_distance_max || 3.5),
        spreadMaxPct: n(settings.spread_max_pct || 0.35),
        costGateRatio: 0.20,
        btcOverrideScoreMin: n(settings.btc_override_score_min || 90),
        btcOverrideVolumeMin: n(settings.btc_override_volume_min || 1.5)
      });
      const scalp = analyse(ticker, p, c1, c5, c15, btc5, btc15, 'SCALPING', {
        minStopPct: n(settings.scalping_sl_min_pct || 0.75),
        rr: n(settings.scalping_rr || 2.0),
        normalizedScore: scalpNormalizedScore,
        volumeMin: n(settings.volume_min || 1.25),
        antiChasePct: n(settings.anti_chase_pct || 15),
        rangeAtrMax: n(settings.range_atr_max || 3.0),
        emaDistanceMax: n(settings.ema_distance_max || 2.5),
        spreadMaxPct: n(settings.spread_max_pct || 0.35),
        costGateRatio: 0.25,
        btcOverrideScoreMin: n(settings.btc_override_score_min || 90),
        btcOverrideVolumeMin: n(settings.btc_override_volume_min || 1.5)
      });
      mom.normalizedScore = momNormalizedScore;
      scalp.normalizedScore = scalpNormalizedScore;
      this.applyTestnetCandleFreshness(mom, '5m');
      this.applyTestnetCandleFreshness(scalp, '1m');
      this.recordAtrDiagnostics(mom);
      this.recordAtrDiagnostics(scalp);
      for (const s of [mom, scalp]) {
        const sizingCandidate = String(s?.stage || '').toUpperCase() === 'CONFIRMED' && s?.ready === true;
        const size = sizingCandidate ? this.positionSizing(s, account, settings) : null;
        const gate = await this.riskGate(s, s === mom ? 'MOMENTUM' : 'SCALPING', account, settings, openPositions, trades);
        const strategyName = s === mom ? 'MOMENTUM' : 'SCALPING';
        const validEntryBrackets =
          Number.isFinite(Number(s?.sl)) && Number(s.sl) > 0 &&
          Number.isFinite(Number(s?.tp)) && Number(s.tp) > 0;
        const insufficientCapital = sizingCandidate && validEntryBrackets && (!size || n(size.qty) < 1);
        if (insufficientCapital) {
          const capitalReason = 'Risk budget insufficient for 1 contract';
          s.stage = 'SKIPPED_INSUFFICIENT_CAPITAL';
          s.ready = false;
          s.blocked = [...new Set([
            ...(Array.isArray(s.blocked) ? s.blocked : [])
              .filter(reason => String(reason) !== 'Margin / minimum contract size'),
            capitalReason
          ])];
          gate.reasons = [...new Set([
            ...(Array.isArray(gate.reasons) ? gate.reasons : [])
              .filter(reason => String(reason) !== 'Margin / minimum contract size'),
            capitalReason
          ])];
        }
        const cacheRow = {
          cache_key: s.symbol + ':' + strategyName,
          symbol: s.symbol, product_id: s.productId, strategy: strategyName,
          price: s.price, change_24h: s.change, turnover_usd: s.turnover, spread_pct: s.spreadPct,
          volume_spike: s.volumeSpike, score: s.score, stage: s.stage, side: s.side,
          rsi: s.rsi, trend: s.trend, confirm_trend: s.confirmTrend, btc_trend: s.btcTrend,
          ema21: s.ema21, atr_5m: s.atr5, atr_15m: s.atr15, support: s.support, resistance: s.resistance,
          stop_price: s.sl, tp1_price: s.tp1, tp_price: s.tp,
          qty_contracts: size ? size.qty : 0, notional: size ? size.notional : 0,
          risk_usd: size ? size.risk : 0, fee_risk_ratio: s.feeRiskRatio,
          ready: s.ready && gate.reasons.length === 0, blocked_reasons: gate.reasons,
          cached_at: iso(),
          details: trimDetails({
            normalizedScore: s.normalizedScore,
            rsi: s.rsi, vwap: s.vwap, fee: s.takerFee, candlesFresh: s.candlesFresh,
            localScore: s.localScore, btcRegimeOverride: s.btcRegimeOverride,
            btcOverrideScoreMin: s.btcOverrideScoreMin, btcOverrideVolumeMin: s.btcOverrideVolumeMin,
            rangeAtr: s.rangeAtr,
            emaDistanceAtr: s.emaDistanceAtr,
            btcTrend5m: s.btcTrend,
            btcTrend15m: s.btcConfirmTrend,
            btcRegime: shadowRegime?.btcRegime ?? null,
            btcRegimeStatus: shadowRegime?.btcRegimeStatus ?? null,
            btcRegimeReason: shadowRegime?.btcRegimeReason ?? null,
            btcRegimeSource: shadowRegime ? 'live-1h' : null,
            btcAtrPct: shadowRegime?.btcAtrPct ?? null,
            btcRegimeComputedAt: shadowRegime?.btcRegimeComputedAt ?? null,
            fullMarketScan: tickers.length === this.tickerMap.size,
            analysisUniverse: 'TOP_TURNOVER_CANDLE_CACHE',
            candleCacheUniverseSize: this.candleCacheSymbols.size,
            candleCacheSymbolLimit: this.candleCacheLimit
          }, strategyName)
        };
        signalCacheRows.push(cacheRow);
        // Persist every stage observation to the history candidate batch. The
        // in-memory deduplicator suppresses unchanged WATCH rows but always allows
        // stage/side transitions such as WATCH -> SETUP -> CONFIRMED.
        signalHistoryRows.push({
          symbol: s.symbol, product_id: s.productId, rank: i + 1,
          strategy: strategyName, price: s.price, change_24h: s.change,
          turnover_usd: s.turnover, spread_pct: s.spreadPct, volume_spike: s.volumeSpike,
          score: s.score, stage: s.stage, side: s.side, rsi: s.rsi, trend: s.trend,
          confirm_trend: s.confirmTrend, btc_trend: s.btcTrend, ema21: s.ema21,
          atr_5m: s.atr5, atr_15m: s.atr15, support: s.support, resistance: s.resistance,
          stop_price: s.sl, tp1_price: s.tp1, tp_price: s.tp,
          qty_contracts: size ? size.qty : 0, notional: size ? size.notional : 0,
          risk_usd: size ? size.risk : 0, fee_risk_ratio: s.feeRiskRatio,
          ready: cacheRow.ready, blocked_reasons: gate.reasons,
          details: cacheRow.details
        });
      }
      out.push({ ticker, product: p, mom, scalp });
    }
    // Persist compact stage history in one request before caching/routing.
    // Unchanged observations (including WATCH) are filtered by the dedup cache.
    if (signalHistoryRows.length) await this.insertSignalHistoryBatch(signalHistoryRows);
    const optionSignals = await this.analyseOptions(out, account, settings, openPositions || []);
    const byUnderlying = new Map();
    for (const s of optionSignals) {
      const key = String(s.underlyingSymbol || '').toUpperCase();
      if (!byUnderlying.has(key)) byUnderlying.set(key, {});
      if (s.strategy === 'OPTIONS_BUY') byUnderlying.get(key).buy = s;
      if (s.strategy === 'OPTIONS_SELL') byUnderlying.get(key).sell = s;
    }
    for (const item of out) {
      const symbol = String(item.ticker?.symbol || '').toUpperCase();
      const key = symbol.endsWith('USD') ? symbol.slice(0, -3) : symbol;
      item.options = byUnderlying.get(key) || {};
    }
    await db.upsertMany('dd_signal_cache', signalCacheRows, 'cache_key');
    // Notification-only side effect: use the fully gated cache rows and never feed results back into routing.
    void this.telegramSignalAlerts.observe(signalCacheRows).catch(error => {
      console.warn('[Telegram] Confirmed signal observer failed; scanner continues:', safeMaintenanceError(error));
    });
    await this.removeStaleUniverseRows('dd_signal_cache', signalCacheRows.map(row => row.symbol));

    const optionCache = new Map();
    for (const s of optionSignals) {
      const underlying = String(s.underlyingSymbol || '').toUpperCase().replace(/USD$/, '');
      const key = underlying + ':' + s.strategy;
      const previous = optionCache.get(key);
      if (!previous || n(s.score) > n(previous.score)) optionCache.set(key, s);
    }
    const optionCacheRows = [...optionCache.values()].map(s => ({
      cache_key: String(s.underlyingSymbol || '').toUpperCase().replace(/USD$/, '') + ':' + s.strategy,
      underlying: String(s.underlyingSymbol || '').toUpperCase().replace(/USD$/, ''),
      strategy: s.strategy,
      symbol: s.symbol,
      product_id: n(s.ticker?.product_id || s.productId),
      option_type: s.optionType,
      strike: s.strike,
      expiry_ms: Math.round(n(s.expiryMs)),
      dte: s.dte,
      mark: s.mark,
      bid: s.bid,
      ask: s.ask,
      spread_pct: s.spreadPct,
      oi: s.oi,
      volume: s.volume,
      delta: s.delta,
      gamma: s.gamma,
      theta: s.theta,
      vega: s.vega,
      score: s.score,
      stage: s.stage,
      side: s.side,
      ready: s.ready,
      blocked_reasons: s.blocked || [],
      cached_at: iso(),
      details: {
        optionType: s.optionType,
        strike: s.strike,
        dte: s.dte,
        expiryMs: s.expiryMs,
        underlyingSymbol: s.underlyingSymbol,
        underlyingAsset: s.underlyingAsset || String(s.underlyingSymbol || '').replace(/USD$/, ''),
        underlyingScore: s.underlyingScore,
        underlyingSide: s.underlyingSide,
        underlyingChange: s.underlyingChange,
        bid: s.bid,
        ask: s.ask,
        volume: s.volume,
        openInterest: s.oi,
        fullMarketScan: true,
        goldOptionSettlement: String(s.underlyingSymbol || '').toUpperCase().startsWith('XAUT')
      }
    }));
    await db.upsertMany('dd_option_cache', optionCacheRows, 'cache_key');

    this.lastSignals = out;
    await this.logDedupStatsIfDue();
  }

  async findExistingClient(client) {

    try { return await this.adapter.clientOrder(client); } catch { return null; }
  }

  async findBridgeExecution(executionId) {
    try {
      const rows = await db.select('dd_orders', 'client_order_id=eq.' + encodeURIComponent(executionId) + '&select=state,updated_at&limit=1');
      return rows && rows[0] ? rows[0] : null;
    } catch (e) {
      await this.log('ERROR', 'Tradetron bridge idempotency lookup failed; entry blocked', { executionId, error: e.message });
      return { state: 'DB_ERROR' };
    }
  }

  async waitPosition(symbol) {
    for (let i = 0; i < 12; i++) {
      const rows = await this.adapter.positions(symbol);
      const list = Array.isArray(rows) ? rows : (rows && typeof rows === 'object' ? [rows] : []);
      const p = list.find(x =>
        String(x.product_symbol || x.symbol || '').toUpperCase() === symbol.toUpperCase() &&
        Math.abs(n(x.size)) > 0
      );
      if (p) return p;
      await sleep(400);
    }
    return null;
  }

  async executeSignal(signal, strategy, qty, clientOrderId) {
    assertDirectDeltaExecutionMode(CONFIG.deltaExecutionMode);
    if (CONFIG.deltaExecutionMode === 'testnet') {
      if (!canExecuteDeltaTestnetOrders(CONFIG.deltaExecutionMode, this.privateExecutionAvailable)) {
        throw new Error('Delta Testnet private API unavailable; order execution is hard-locked in SCAN-ONLY mode');
      }
      try {
        return await deltaExecutor.placeBracketOrder(
          signal.symbol, signal.side, qty, signal.price, signal.sl, signal.tp,
          { strategy, clientOrderId }
        );
      } catch (error) {
        if (isPrivateApiConnectivityError(error)) {
          this.privateExecutionAvailable = false;
          await this.log('WARN', 'Private Delta Testnet API unavailable. Continuing in SCAN-ONLY mode.', {
            error: String(error?.message || error).slice(0, 240),
            symbol: signal.symbol,
            executionLocked: true
          }).catch(() => {});
        }
        throw error;
      }
    }
    throw new Error('Unreachable execution route: only direct Delta Testnet is permitted');
  }

  async openTrade(item, strategy, signal, account, settings, openPositions, trades) {
    if (this.leaseEnforced && (!this.running || !this.leaseManager.isHeld)) {
      await this.log('WARN', 'Entry blocked because the worker lease is not held', {
        symbol: signal?.symbol || null,
        strategy,
        workerId: CONFIG.workerId,
        leaseHeld: this.leaseManager.isHeld,
        workerRunning: this.running
      }).catch(() => {});
      return false;
    }
    // A disabled/unknown mode is scan-only. Do not reach either legacy
    // bridge routing or the adapter's production-host fallback.
    if (CONFIG.deltaExecutionMode !== 'testnet') {
      await this.log('WARN', 'Order entry blocked: only direct Delta Testnet execution is supported; scanner remains scan-only.', {
        executionMode: CONFIG.deltaExecutionMode,
        symbol: signal?.symbol ?? null,
        strategy,
        executionLocked: true
      }).catch(() => {});
      return false;
    }

    if (strategy === 'OPTIONS_BUY' || strategy === 'OPTIONS_SELL') {
      // Options are locked until direct Delta Testnet option execution has its
      // own verified contract sizing and exchange-side protection path.
      // Never route options through a legacy external strategy bridge.
      return false;
    }
    const normalizedScore = Number(signal?.normalizedScore);
    const normalizedScorePass =
      Number.isFinite(normalizedScore) && normalizedScore >= 80;

    if (
      String(signal?.stage || '').toUpperCase() !== 'CONFIRMED' ||
      signal?.ready !== true ||
      !normalizedScorePass
    ) return false;

    const validatedEntryPrice = Number(signal?.price);
    const validatedStopPrice = Number(signal?.sl);
    const validatedTakeProfitPrice = Number(signal?.tp);
    if (
      !(Number.isFinite(validatedEntryPrice) && validatedEntryPrice > 0) ||
      !(Number.isFinite(validatedStopPrice) && validatedStopPrice > 0) ||
      !(Number.isFinite(validatedTakeProfitPrice) && validatedTakeProfitPrice > 0)
    ) {
      await this.log('WARN', '[Executor] Entry blocked: entry, SL and TP must be finite positive prices', {
        symbol: signal?.symbol ?? null,
        stage: signal?.stage ?? null,
        ready: signal?.ready === true,
        entryPrice: signal?.price ?? null,
        stopLossPrice: signal?.sl ?? null,
        takeProfitPrice: signal?.tp ?? null,
        executionBlocked: true
      }).catch(() => {});
      return false;
    }
    if (
      CONFIG.deltaExecutionMode === 'testnet' &&
      ['MOMENTUM', 'SCALPING'].includes(strategy) &&
      !this.privateExecutionAvailable
    ) {
      if (Date.now() - this.lastTestnetExecutionLockLogAt >= 60_000) {
        this.lastTestnetExecutionLockLogAt = Date.now();
        await this.log('WARN', 'Delta Testnet entries blocked: private API is unavailable; scanner remains in SCAN-ONLY mode.', {
          symbol: signal.symbol, strategy, side: signal.side, executionLocked: true
        }).catch(() => {});
      }
      return false;
    }
    if (CONFIG.deltaExecutionMode === 'testnet' && ['MOMENTUM', 'SCALPING'].includes(strategy)) {
      const maxSameSide = envInteger('MAX_SAME_SIDE_POSITIONS', 3, 1, 20);
      const correlation = assessCorrelatedEntry({
        symbol: signal.symbol, side: signal.side, positions: openPositions,
        maxSameSide, aggressive: envBoolean('DELTA_AGGRESSIVE_CORRELATION_MODE', false)
      });
      if (correlation.blocked) {
        await this.log('WARN', '[Risk] Entry blocked by same-side/correlation exposure cap', {
          symbol: signal.symbol, side: signal.side, strategy,
          reason: correlation.reason, sameSideCount: correlation.sameSideCount,
          maxSameSidePositions: maxSameSide, correlationGroup: correlation.group,
          conflictingSymbol: correlation.conflictingSymbol || null, executionBlocked: true
        }).catch(() => {});
        return false;
      }
    }
    const gate = await this.riskGate(signal, strategy, account, settings, openPositions, trades);
    if (gate.reasons.length || !gate.size) return false;

    // Testnet is a separate, hardcoded Demo-only execution route. The existing
    // Tradetron branch below remains unchanged for DELTA_EXECUTION_MODE=disabled.
    if (CONFIG.deltaExecutionMode === 'testnet' && ['MOMENTUM', 'SCALPING'].includes(strategy)) {
      const signalCandle = Number(signal.signalCandleTs || signal.candleTs || 0);
      const normalizedCandleMs = signalCandle > 1e12 ? signalCandle
        : signalCandle > 1e9 ? signalCandle * 1000 : Date.now();
      const stableMinute = Math.floor(normalizedCandleMs / 60000).toString(36);
      const entryCid = (strategy === 'MOMENTUM' ? 'DDM-' : 'DDS-') +
        String(signal.symbol || '').toUpperCase().slice(0, 10) + '-' + stableMinute;
      const priorTestnetOrders = await db.select(
        'dd_orders',
        'client_order_id=eq.' + encodeURIComponent(entryCid) + '&select=state&limit=1'
      );
      if (Array.isArray(priorTestnetOrders) && priorTestnetOrders.length) return false;
      try {
        const order = await this.executeSignal(signal, strategy, gate.size.qty, entryCid);
        const orderId = String(order?.id ?? order?.order_id ?? entryCid);

        // Keep missing unfilled_size unknown (null), rather than falsely treating it as zero.
        const unfilledRaw = order?.unfilled_size;
        const unfilledText = unfilledRaw === undefined || unfilledRaw === null
          ? ''
          : String(unfilledRaw).trim();
        const unfilledSize = unfilledText === ''
          ? null
          : Number.isFinite(Number(unfilledText))
            ? Number(unfilledText)
            : null;
        const apiState = String(order?.state ?? 'UNKNOWN');
        const orderType = String(order?.order_type ?? 'market_order');

        try {
          await db.upsert('dd_orders', {
            id: entryCid,
            product_id: signal.productId,
            symbol: signal.symbol,
            side: signal.side === 'BUY' ? 'buy' : 'sell',
            order_type: 'delta_testnet_order',
            size: gate.size.qty,
            unfilled_size: unfilledSize,
            state: apiState,
            client_order_id: entryCid,
            role: 'ENTRY',
            strategy,
            execution_id: entryCid,
            raw: {
              source: 'delta_testnet',
              environment: 'testnet',
              requested_order_type: orderType,
              entry_price: signal.price,
              stop_price: signal.sl,
              tp_price: signal.tp,
              testnet_order_id: order?.id ?? null,
              exchange_state: order?.state ?? null,
              unfilled_size: unfilledSize,
              average_fill_price: order?.average_fill_price ?? null,
              accepted: true
            }
          }, 'client_order_id');
        } catch (persistError) {
          await this.log('ERROR', '[Executor] Delta Testnet API accepted the order but order-ledger persistence failed; no blind retry', {
            environment: 'testnet',
            endpoint: 'POST /v2/orders',
            symbol: signal.symbol,
            strategy,
            side: signal.side,
            qty: gate.size.qty,
            clientOrderId: entryCid,
            orderId,
            error: String(persistError?.message || persistError)
          });
        }

        await this.log('INFO', '[Executor] Delta Testnet API order acknowledged; exchange fill confirmation pending', {
          environment: 'testnet',
          endpoint: 'POST /v2/orders',
          symbol: signal.symbol,
          strategy,
          side: signal.side,
          qty: gate.size.qty,
          orderType,
          entry: signal.price,
          sl: signal.sl,
          tp: signal.tp,
          clientOrderId: entryCid,
          orderId,
          apiState,
          unfilledSize,
          unfilledSizeStatus: unfilledSize === null ? 'unknown' : unfilledSize,
          averageFillPrice: order?.average_fill_price ?? null,
          restAcknowledgementOnly: true,
          fillConfirmationSource: 'Delta private WebSocket / position reconciliation'
        });
        return true;
      } catch (error) {
        await this.log('ERROR', 'Delta Testnet entry rejected or failed closed', {
          symbol: signal.symbol, strategy, side: signal.side,
          reason: String(error?.message || error)
        });
        return false;
      }
    }

    // The only supported futures entry route is the direct Delta Testnet
    // branch above. No external bridge or production-wallet fallback exists.
    return false;
  }

  async manageOptionPositionRow(row, exchangePosition, setting, openOrders = []) {
    const qty = Math.abs(n(exchangePosition?.size));
    const mark = n(exchangePosition?.mark_price || row.current_price);
    if (qty <= 0) return;

    const product = this.optionTickerMap.get(row.symbol) || {};
    const tick = n(product.tick_size);
    const roundOption = v => tick > 0 ? roundTick(v, tick) : v;
    const entry = n(row.entry_price);
    const fee = n(product.taker_commission_rate);
    const stop = n(row.stop_price);
    const tp1 = n(row.tp1_price);
    const tp = n(row.tp_price);
    const base = Array.isArray(openOrders) ? openOrders.filter(o => n(o.product_id) === n(row.product_id)) : [];

    const stopCid = clientId('OSL', row.symbol);
    const tp1Cid = String('OTP1-' + String(row.execution_id).replace(/[^a-zA-Z0-9]/g, '')).slice(0, 32);
    const tpCid = clientId('OTP', row.symbol);

    const hasStop = base.some(o => String(o.client_order_id || '') === stopCid || (o.stop_order_type === 'stop_loss_order' && n(o.size) >= qty));
    if (!hasStop && stop > 0) {
      await this.adapter.placeOrder({
        product_id: row.product_id, size: qty, side: 'sell', order_type: 'market_order',
        stop_order_type: 'stop_loss_order', stop_price: cleanPrice(roundOption(stop)),
        stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: stopCid
      });
    }

    const tp1Exists = base.some(o => String(o.client_order_id || '') === tp1Cid || (o.stop_order_type === 'take_profit_order' && n(o.size) > 0 && n(o.size) < qty));
    if (!tp1Exists && tp1 > 0) {
      const tp1Qty = Math.max(1, Math.min(qty, roundDown(qty * n(setting.options_buy_tp1_pct || 30) / 100, 1)));
      await this.adapter.placeOrder({
        product_id: row.product_id, size: tp1Qty, side: 'sell', order_type: 'market_order',
        stop_order_type: 'take_profit_order', stop_price: cleanPrice(roundOption(tp1)),
        stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: tp1Cid
      });
    }

    const tpExists = base.some(o => String(o.client_order_id || '') === tpCid || (o.stop_order_type === 'take_profit_order' && n(o.size) >= qty));
    if (!tpExists && tp > 0) {
      await this.adapter.placeOrder({
        product_id: row.product_id, size: qty, side: 'sell', order_type: 'market_order',
        stop_order_type: 'take_profit_order', stop_price: cleanPrice(roundOption(tp)),
        stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: tpCid
      });
    }

    const tp1Done = qty < n(row.initial_qty) && !row.tp1_done;
    if (tp1Done) {
      const be = roundOption(fee > 0 ? entry * (1 + 2 * fee) : entry);
      const fresh = await this.adapter.openOrders();
      const stopOrder = (Array.isArray(fresh) ? fresh : []).find(o => String(o.client_order_id || '') === stopCid);
      if (stopOrder) {
        await this.adapter.cancelOrder({ id: Number(stopOrder.id), product_id: row.product_id }).catch(() => {});
      }
      const beCid = String('OSLBE-' + String(row.execution_id).replace(/[^a-zA-Z0-9]/g, '')).slice(0, 32);
      await this.adapter.placeOrder({
        product_id: row.product_id, size: qty, side: 'sell', order_type: 'market_order',
        stop_order_type: 'stop_loss_order', stop_price: String(be),
        stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: beCid
      });
      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
        qty, tp1_done: true, stop_price: be, current_price: mark, updated_at: iso()
      });
      await this.log('INFO', 'Options TP1 detected; stop moved to break-even', { symbol: row.symbol, qty, stop: be });
      return;
    }

    if (Date.now() - new Date(row.opened_at).getTime() > n(setting.max_hold_minutes || 240) * 60000) {
      await this.closePosition(row.symbol, row.product_id, qty, 'BUY', 'TIMEOUT');
    }

    await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
      qty, current_price: mark, updated_at: iso()
    });
  }

  async closePosition(symbol, productId, qty, side, reason) {
    const rows = await db.select('dd_positions', 'symbol=eq.' + encodeURIComponent(symbol) + '&qty=gt.0&limit=1');
    if (rows && rows[0]) await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(rows[0].execution_id), { requested_exit_reason: reason, updated_at: iso() });
    const cid = clientId('CLS', symbol);
    if (await this.findExistingClient(cid)) return;
    await this.adapter.placeOrder({
      product_id: productId,
      size: Math.max(1, Math.floor(qty)),
      side: sideExit(side),
      order_type: 'market_order',
      reduce_only: true,
      client_order_id: cid
    });
  }

  async ensurePositionProtection(row, exchangePosition, openOrders = []) {
    const qty = Math.abs(n(exchangePosition?.size));
    const productId = n(row.product_id || exchangePosition?.product_id);
    if (qty <= 0 || !productId) return false;

    const tick = n(this.productMap.get(row.symbol)?.tick_size) || n(row.tick_size) || 0;
    const stop = roundTick(n(row.stop_price), tick);
    const tp1 = roundTick(n(row.tp1_price), tick);
    const tp = roundTick(n(row.tp_price), tick);
    if (!(stop > 0 && tp1 > 0 && tp > 0)) {
      await this.log('ERROR', 'Recovered position has incomplete protection prices', {
        symbol: row.symbol, executionId: row.execution_id, stop, tp1, tp
      });
      return false;
    }

    const sameProduct = (Array.isArray(openOrders) ? openOrders : []).filter(o => n(o.product_id) === productId);
    let protectedOrders = sameProduct.filter(o =>
      o.stop_order_type ||
      o.bracket_order ||
      n(o.bracket_stop_loss_price) ||
      n(o.bracket_take_profit_price)
    );

    const hasBracket = protectedOrders.some(o =>
      n(o.bracket_stop_loss_price) > 0 && n(o.bracket_take_profit_price) > 0
    );

    let bracketExistsByApi = false;
    if (!hasBracket) {
      try {
        await this.adapter.placeBracket({
          product_id: productId,
          stop_loss_order: { order_type: 'market_order', stop_price: cleanPrice(stop) },
          take_profit_order: { order_type: 'market_order', stop_price: cleanPrice(tp) },
          bracket_stop_trigger_method: 'mark_price'
        });
      } catch (e) {
        const details = e?.details || null;
        if (e?.code === 'bracket_order_exists') {
          bracketExistsByApi = true;
          const freshOrders = await this.adapter.openOrders().catch(() => []);
          protectedOrders = (Array.isArray(freshOrders) ? freshOrders : []).filter(o =>
            n(o.product_id) === productId &&
            (o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price))
          );
        } else {
          // Some Delta products can reject a bracket payload even though
          // equivalent standalone reduce-only stop/TP orders are valid.
          // Fall back to exchange-side standalone protection rather than
          // leaving an already-open ENGINE position unprotected.
          await this.log('WARN', 'Bracket rejected; attempting standalone reduce-only protection', {
            symbol: row.symbol, executionId: row.execution_id, error: e.message,
            code: e.code || null, status: e.status || null, details
          });
          try {
            const suffix = String(row.execution_id).replace(/[^a-zA-Z0-9]/g, '').slice(-20);
            const stopCid = ('RSL-' + suffix).slice(0, 32);
            const tpCid = ('RTP-' + suffix).slice(0, 32);
            const freshOrders = await this.adapter.openOrders().catch(() => []);
            const same = (Array.isArray(freshOrders) ? freshOrders : []).filter(o => n(o.product_id) === productId);
            const nearPrice = (a, b) => {
              const x = n(a), y = n(b);
              return x > 0 && y > 0 && Math.abs(x - y) <= Math.max(Math.abs(y) * 0.0005, tick > 0 ? tick * 2 : 1e-9);
            };
            const stopExisting = same.find(o =>
              String(o.client_order_id || '') === stopCid ||
              (o.stop_order_type === 'stop_loss_order' && n(o.size) >= qty && nearPrice(o.stop_price, stop))
            );
            const tpExisting = same.find(o =>
              String(o.client_order_id || '') === tpCid ||
              (o.stop_order_type === 'take_profit_order' && n(o.size) >= qty && nearPrice(o.stop_price, tp))
            );
            if (!stopExisting) {
              await this.adapter.placeOrder({
                product_id: productId, size: qty, side: sideExit(row.side),
                order_type: 'market_order', stop_order_type: 'stop_loss_order',
                stop_price: cleanPrice(stop), stop_trigger_method: 'mark_price',
                reduce_only: true, client_order_id: stopCid
              });
            }
            if (!tpExisting) {
              await this.adapter.placeOrder({
                product_id: productId, size: qty, side: sideExit(row.side),
                order_type: 'market_order', stop_order_type: 'take_profit_order',
                stop_price: cleanPrice(tp), stop_trigger_method: 'mark_price',
                reduce_only: true, client_order_id: tpCid
              });
            }
            const verifiedOrders = await this.adapter.openOrders();
            protectedOrders = (Array.isArray(verifiedOrders) ? verifiedOrders : []).filter(o =>
              n(o.product_id) === productId &&
              (o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price))
            );
          } catch (fallbackError) {
            await this.log('ERROR', 'Standalone reduce-only protection failed', {
              symbol: row.symbol, executionId: row.execution_id,
              error: fallbackError.message, code: fallbackError.code || null,
              status: fallbackError.status || null, details: fallbackError.details || null
            });
            return false;
          }
        }
      }
      const freshOrders = protectedOrders.length
        ? protectedOrders
        : await this.adapter.openOrders().catch(() => []);
      protectedOrders = (Array.isArray(freshOrders) ? freshOrders : []).filter(o =>
        n(o.product_id) === productId &&
        (o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price))
      );
    }

    const near = (a, b) => {
      const x = n(a), y = n(b);
      if (!(x > 0 && y > 0)) return false;
      const tol = Math.max(Math.abs(y) * 0.0005, tick > 0 ? tick * 2 : 1e-9);
      return Math.abs(x - y) <= tol;
    };
    const hasCombinedBracket = protectedOrders.some(o =>
      n(o.bracket_stop_loss_price) > 0 && n(o.bracket_take_profit_price) > 0
    );
    const hasSeparateStop = protectedOrders.some(o =>
      o.stop_order_type === 'stop_loss_order' &&
      near(o.stop_price || o.bracket_stop_loss_price, stop)
    );
    const hasSeparateTakeProfit = protectedOrders.some(o =>
      o.stop_order_type === 'take_profit_order' &&
      near(o.stop_price || o.bracket_take_profit_price, tp)
    );
    const bracketVerified = bracketExistsByApi || hasCombinedBracket || (hasSeparateStop && hasSeparateTakeProfit);

    const tp1Cid = ('TP1-' + String(row.execution_id).replace(/[^a-zA-Z0-9]/g, '')).slice(0, 32);
    const tp1Existing = protectedOrders.find(o =>
      o.stop_order_type === 'take_profit_order' &&
      n(o.size) > 0 &&
      n(o.size) < qty &&
      (o.reduce_only === true || String(o.client_order_id || '') === tp1Cid)
    );

    let tp1OrderId = tp1Existing ? String(tp1Existing.id) : null;
    if (!tp1OrderId) {
      const tp1Qty = Math.max(1, Math.min(qty, roundDown(qty * n(this.currentSettings?.tp1_pct || 33) / 100, 1)));
      const prior = await this.findExistingClient(tp1Cid);
      if (prior) {
        tp1OrderId = String(prior.id);
      } else {
        try {
          const tp1Order = await this.adapter.placeOrder({
            product_id: productId,
            size: tp1Qty,
            side: sideExit(row.side),
            order_type: 'market_order',
            stop_order_type: 'take_profit_order',
            stop_price: String(tp1),
            stop_trigger_method: 'mark_price',
            reduce_only: true,
            client_order_id: tp1Cid
          });
          tp1OrderId = String(tp1Order.id);
          await db.upsert('dd_orders', {
            id: String(tp1Order.id), product_id: productId, symbol: row.symbol,
            side: sideExit(row.side), order_type: 'market_order', stop_order_type: 'take_profit_order',
            size: tp1Qty, unfilled_size: n(tp1Order.unfilled_size), state: tp1Order.state,
            client_order_id: tp1Cid, role: 'TP1', strategy: row.strategy, execution_id: row.execution_id, raw: tp1Order
          }, 'client_order_id');
        } catch (e) {
          await this.log('ERROR', 'Recovered position TP1 placement failed', {
            symbol: row.symbol, executionId: row.execution_id, error: e.message,
            code: e.code || null, status: e.status || null, details: e.details || null
          });
          return false;
        }
      }
    }

    const verified = bracketVerified && !!tp1OrderId;
    if (verified) {
      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
        protection_verified: true,
        tp1_order_id: tp1OrderId,
        updated_at: iso()
      });
      await this.log('INFO', 'Recovered TESTNET position protection verified', {
        symbol: row.symbol, executionId: row.execution_id, qty, stop, tp1, tp, tp1OrderId
      });
    }
    return verified;
  }

  async managePositionRow(row, exchangePosition, setting, openOrders = []) {
    const mark = n(exchangePosition.mark_price || this.tickerMap.get(row.symbol)?.mark_price || row.current_price);
    const qty = Math.abs(n(exchangePosition.size));
    const originalRisk = Math.abs(n(row.entry_price) - n(row.stop_price));
    const fee = n(this.productMap.get(row.symbol)?.taker_commission_rate);
    if (qty <= 0) return;
    if (!row.protection_verified) {
      const protectedNow = await this.ensurePositionProtection(row, exchangePosition, openOrders);
      if (!protectedNow) {
        await this.log('ERROR', 'Unprotected engine position remains blocked from management', {
          symbol: row.symbol, executionId: row.execution_id, qty
        });
        return;
      }
      row.protection_verified = true;
    }
    const changed = qty < n(row.initial_qty) && !row.tp1_done;
    if (changed) {
      const be = row.side === 'BUY' ? n(row.entry_price) * (1 + 2 * fee) : n(row.entry_price) * (1 - 2 * fee);
      const rounded = roundTick(be, n(this.productMap.get(row.symbol)?.tick_size));
      await this.adapter.editBracket({
        id: Number(row.entry_order_id), product_id: row.product_id,
        bracket_stop_loss_price: String(rounded),
        bracket_stop_trigger_method: 'mark_price'
      });
      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
        qty, tp1_done: true, stop_price: rounded, current_price: mark, updated_at: iso()
      });
      await this.log('INFO', 'TP1 detected; stop moved to break-even plus fees', { symbol: row.symbol, qty, stop: rounded });
      return;
    }
    let stop = n(row.stop_price);
    if (row.tp1_done && originalRisk > 0) {
      const candidate = row.side === 'BUY' ? mark - originalRisk : mark + originalRisk;
      const favorable = row.side === 'BUY' ? candidate > stop : candidate < stop;
      if (favorable) {
        const rounded = roundTick(candidate, n(this.productMap.get(row.symbol)?.tick_size));
        await this.adapter.editBracket({
          id: Number(row.entry_order_id), product_id: row.product_id,
          bracket_stop_loss_price: String(rounded),
          bracket_stop_trigger_method: 'mark_price'
        });
        stop = rounded;
      }
    }
    if (Date.now() - new Date(row.opened_at).getTime() > n(setting.max_hold_minutes || 240) * 60000) {
      await this.closePosition(row.symbol, row.product_id, qty, row.side, 'TIMEOUT');
    }
    await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), {
      qty, current_price: mark, stop_price: stop, updated_at: iso()
    });
  }

  async reconcile() {
    const [positions, orders, fills] = await Promise.all([
      this.adapter.marginedPositions(),
      this.adapter.openOrders(),
      this.adapter.fills()
    ]);
    const exchangePositions = Array.isArray(positions) ? positions.filter(p => Math.abs(n(p.size)) > 0) : [];
    const local = await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
    for (const row of local || []) {
      const ep = exchangePositions.find(p => String(p.product_symbol) === String(row.symbol));
      if (row.origin !== 'ENGINE') {
        if (!ep) await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(row.execution_id), { qty: 0, updated_at: iso() });
        continue;
      }
      if (ep) {
        if (row.strategy === 'OPTIONS_BUY') {
          await this.manageOptionPositionRow(row, ep, this.currentSettings || {}, Array.isArray(orders) ? orders : []);
        } else {
          await this.managePositionRow(row, ep, this.currentSettings || {}, Array.isArray(orders) ? orders : []);
        }
      } else {
        await this.finalizeClosedTrade(row, Array.isArray(fills) ? fills : [], Array.isArray(orders) ? orders : []);
      }
    }
    const recentHistory = await this.adapter.historyOrders().catch(() => []);
    const allOrders = [...(Array.isArray(orders) ? orders : []), ...(Array.isArray(recentHistory) ? recentHistory : [])];
    for (const ep of exchangePositions) {
      const symbol = String(ep.product_symbol || ep.symbol || '');
      const known = (local || []).some(p => String(p.symbol) === symbol);
      if (known) continue;
      const candidates = allOrders.filter(o => String(o.product_symbol || o.symbol) === symbol);
      const engineOrder = candidates.find(o => {
        const cid = String(o.client_order_id || '');
        return /^(DDM|DDS|DDO)-/.test(cid) && o.reduce_only !== true;
      });
      if (engineOrder) {
        const cid = String(engineOrder.client_order_id);
        const strategy = cid.startsWith('DDM-') ? 'MOMENTUM' : cid.startsWith('DDO-') ? 'OPTIONS_BUY' : 'SCALPING';
        const latest = (await db.select('dd_signals', 'symbol=eq.' + encodeURIComponent(symbol) + '&strategy=eq.' + strategy + '&order=captured_at.desc&limit=1'))?.[0] || {};
        const side = n(ep.size) > 0 ? 'BUY' : 'SELL';
        const protection = candidates.some(o => o.stop_order_type || o.bracket_order || n(o.bracket_stop_loss_price) || n(o.bracket_take_profit_price));
        await db.insert('dd_positions', {
          symbol, product_id: n(ep.product_id || engineOrder.product_id), side,
          qty: Math.abs(n(ep.size)), entry_price: n(ep.entry_price),
          current_price: n(ep.mark_price), stop_price: n(latest.stop_price || engineOrder.bracket_stop_loss_price),
          tp1_price: n(latest.tp1_price), tp_price: n(latest.tp_price || engineOrder.bracket_take_profit_price),
          initial_qty: Math.abs(n(ep.size)), protection_verified: protection,
          entry_order_id: String(engineOrder.id), client_order_id: cid,
          execution_id: cid, strategy, origin: 'ENGINE',
          opened_at: engineOrder.created_at || iso(), updated_at: iso()
        });
        await this.log('WARN', 'Recovered engine position after state gap', { symbol, strategy, clientOrderId: cid });
      } else {
        await db.insert('dd_positions', {
          symbol, product_id: n(ep.product_id), side: n(ep.size) > 0 ? 'BUY' : 'SELL',
          qty: Math.abs(n(ep.size)), entry_price: n(ep.entry_price), current_price: n(ep.mark_price),
          stop_price: 0, tp1_price: 0, tp_price: 0, initial_qty: Math.abs(n(ep.size)),
          strategy: 'EXTERNAL', origin: 'EXTERNAL', execution_id: 'EXTERNAL-' + symbol + '-' + Date.now().toString(36),
          opened_at: ep.created_at || iso(), updated_at: iso()
        });
        await this.log('WARN', 'External Delta position recorded; not auto-managed', { symbol, size: ep.size });
      }
    }
    this.lastReconcile = Date.now();
  }

  async finalizeClosedTrade(row, fills, orders) {
    const openedAt = new Date(row.opened_at || Date.now()).getTime();
    const product = this.productMap.get(row.symbol);
    const productValue = n(product?.contract_value) || 1;
    const relevant = fills.filter(f => String(f.product_symbol || '') === row.symbol && new Date(f.created_at || 0).getTime() >= openedAt - 60000);
    const entrySide = row.side === 'BUY' ? 'buy' : 'sell';
    const exitSide = sideExit(row.side);
    const entries = relevant.filter(f => String(f.side).toLowerCase() === entrySide);
    const exits = relevant.filter(f => String(f.side).toLowerCase() === exitSide);
    const entryQty = entries.reduce((s, f) => s + n(f.size), 0);
    const exitQty = exits.reduce((s, f) => s + n(f.size), 0);
    if (!exitQty) return;
    const entryNotional = entries.reduce((s, f) => s + Math.abs(n(f.notional)), 0);
    const exitNotional = exits.reduce((s, f) => s + Math.abs(n(f.notional)), 0);
    const entryPrice = entryQty ? entries.reduce((s, f) => s + n(f.price) * n(f.size), 0) / entryQty : n(row.entry_price);
    const exitPrice = exitQty ? exits.reduce((s, f) => s + n(f.price) * n(f.size), 0) / exitQty : n(row.current_price);
    const gross = row.side === 'BUY'
      ? (exitNotional - entryNotional)
      : (entryNotional - exitNotional);
    const fees = relevant.reduce((s, f) => s + Math.abs(n(f.commission)), 0);
    const net = gross - fees;
    const linkedOrders = orders.filter(o => relevant.some(f => String(f.order_id) === String(o.id)));
    const hasSl = linkedOrders.some(o => o.stop_order_type === 'stop_loss_order' || n(o.bracket_stop_loss_price));
    const hasTp = linkedOrders.some(o => o.stop_order_type === 'take_profit_order' || n(o.bracket_take_profit_price));
    const hasTp1 = relevant.some(f => String(f.order_id) === String(row.tp1_order_id));
    let reason = row.requested_exit_reason || 'MANUAL';
    if (hasTp1 && exitQty < n(row.initial_qty)) reason = 'TP1';
    else if (hasTp) reason = 'TP';
    else if (hasSl) reason = row.tp1_done ? (n(row.stop_price) !== 0 && ((row.side === 'BUY' && n(row.stop_price) > n(row.entry_price)) || (row.side === 'SELL' && n(row.stop_price) < n(row.entry_price))) ? 'TRAIL' : 'BREAKEVEN') : 'SL';
    if (row.requested_exit_reason) reason = row.requested_exit_reason;

    const executionId = row.execution_id;
    const exists = await db.select('dd_trades', 'execution_id=eq.' + encodeURIComponent(executionId) + '&select=execution_id');
    if (exists && exists.length) {
      await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(executionId), { qty: 0, updated_at: iso() });
      return;
    }
    const rValue = Math.abs(n(row.entry_price) - n(row.stop_price)) * productValue * Math.max(1, n(row.initial_qty));
    const rMultiple = rValue ? net / rValue : 0;
    const result = net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'FLAT';
    const trade = {
      execution_id: executionId, symbol: row.symbol, strategy: row.strategy, side: row.side,
      entry_price: entryPrice, exit_price: exitPrice, qty: Math.max(entryQty, exitQty, n(row.initial_qty)),
      entry_notional: entryNotional, exit_notional: exitNotional, fees, gross_pnl: gross, net_pnl: net,
      pnl_pct: entryNotional ? net / entryNotional * 100 : 0, r_multiple: rMultiple,
      exit_reason: reason, result, entry_fill_ids: entries.map(f => f.id), exit_fill_ids: exits.map(f => f.id),
      opened_at: row.opened_at, closed_at: iso()
    };
    await db.insert('dd_trades', trade);
    await db.update('dd_positions', 'execution_id=eq.' + encodeURIComponent(executionId), { qty: 0, updated_at: iso() });
    if (net > 0) {
      await db.insert('dd_rotation_ledger', {
        execution_id: executionId, profit: net, released: net * 0.90, retained: net * 0.10,
        rotation_id: 'ROT-' + Date.now().toString(36)
      });
    }
    const counters = (await db.select('dd_counters', 'id=eq.1&select=*'))?.[0] || {};
    await db.update('dd_counters', 'id=eq.1', {
      consecutive_losses: net < 0 ? n(counters.consecutive_losses) + 1 : 0,
      last_loss_at: net < 0 ? iso() : counters.last_loss_at,
      updated_at: iso()
    });
    const daily = (await db.select('dd_daily_pnl', 'trade_date=eq.' + encodeURIComponent(today())))?.[0];
    const dayPatch = {
      trade_date: today(),
      realized: n(daily?.realized) + net,
      fees: n(daily?.fees) + fees,
      wins: n(daily?.wins) + (net > 0 ? 1 : 0),
      losses: n(daily?.losses) + (net < 0 ? 1 : 0),
      trades: n(daily?.trades) + 1,
      updated_at: iso()
    };
    await db.upsert('dd_daily_pnl', dayPatch, 'trade_date');
    await this.log('INFO', 'Real closed trade recorded', { executionId, symbol: row.symbol, reason, gross, fees, net });
  }

  syncCandleWebSocketSubscription(socket = this.ws) {
    if (!socket || socket !== this.ws || socket.readyState !== WebSocket.OPEN || !this.running) return false;
    const priorSymbols = this.wsCandleSubscribedSymbols instanceof Set
      ? this.wsCandleSubscribedSymbols : new Set();
    const nextSymbols = new Set(this.candleCacheSymbols);
    const added = [...nextSymbols].filter(symbol => !priorSymbols.has(symbol));
    const removed = [...priorSymbols].filter(symbol => !nextSymbols.has(symbol));
    const resolutions = ['1m', '5m', '15m'];

    const sendSubscription = (type, symbols) => {
      if (!symbols.length) return;
      socket.send(JSON.stringify({
        type,
        payload: {
          channels: resolutions.map(resolution => ({
            name: 'candlestick_' + resolution,
            symbols
          }))
        }
      }));
    };

    try {
      sendSubscription('unsubscribe', removed);
      sendSubscription('subscribe', added);
      this.wsCandleSubscribedSymbols = nextSymbols;
      return true;
    } catch (error) {
      this.wsCandleSubscribedSymbols = new Set();
      void this.log('WARN', 'Bounded candle WebSocket subscription update failed', {
        error: String(error?.message || error).slice(0, 200),
        eligibleSymbols: nextSymbols.size
      }).catch(() => {});
      return false;
    }
  }

  scheduleWsReconnect(delayMs) {
    if (this.ws || this.wsReconnectTimer || !this.running) return;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      if (this.running) this.connectWs();
    }, Math.max(1_000, Number(delayMs) || 1_000));
    this.wsReconnectTimer.unref?.();
  }

  handleMarketWebSocketCallbackFailure(socket, error, source) {
    const message = String(error?.message || error);
    const details = {
      source,
      error: message.slice(0, 500),
      stack: String(error?.stack || '').slice(0, 5000),
      code: error?.code || null,
      pid: process.pid
    };
    const wasCurrent = this.ws === socket;
    if (wasCurrent) {
      this.ws = null;
      this.wsConnected = false;
      this.wsOpenedAt = 0;
      this.wsCandleSubscribedSymbols = new Set();
      const rateLimited = /429|rate.?limit|too many connections/i.test(message);
      const wait = websocketReconnectDelay(this.wsRetry, { baseMs: 1_000, rateLimited });
      this.wsRetry = Math.min(this.wsRetry + 1, 16);
      this.wsRateLimited = false;
      this.scheduleWsReconnect(wait);
      details.retryInMs = wait;
      details.rateLimited = rateLimited;
    }
    void this.log('ERROR', 'WebSocket callback failed safely; reconnect scheduled', details).catch(logError => {
      console.error('[DeltaScanner] Could not persist WebSocket callback error:', String(logError?.message || logError));
    });
    cleanupWebSocketListeners(socket);
    try { socket?.terminate?.(); } catch {}
    try { socket?.close(); } catch {}
  }

  connectWs() {
    if (this.ws || this.wsReconnectTimer || !this.running) return;
    try {
      const ws = new WebSocket(CONFIG.publicWs);
      this.ws = ws;
      this.wsCandleSubscribedSymbols = new Set();
      let openedAt = 0;
      ws.on('open', () => {
        openedAt = Date.now();
        this.wsOpenedAt = openedAt;
        this.wsConnected = true;
        void this.log('INFO', 'WebSocket connected; candle updates use canonical timeframe buckets', {}).catch(() => {});
        if (this.candleRestHealingNeeded) {
          this.candleRestHealingNeeded = false;
          void this.refreshCandleWarmup().catch(error =>
            this.log('WARN', 'Reconnect REST candle rewarm batch failed', {
              error: String(error?.message || error).slice(0, 200)
            })
          );
        }
        try {
          ws.send(JSON.stringify({
            type: 'subscribe',
            payload: {
              channels: [
                { name: 'ticker', symbols: ['perpetual_futures'] },
                { name: 'mark_price', symbols: ['perpetual_futures'] }
              ]
            }
          }));
          this.syncCandleWebSocketSubscription(ws);
          ws.send(JSON.stringify({ type: 'enable_heartbeat' }));
        } catch (error) {
          this.handleMarketWebSocketCallbackFailure(ws, error, 'open/subscription');
        }
      });
      ws.on('message', raw => {
        this.lastTickAt = Date.now();
        try {
          const msg = JSON.parse(raw.toString());
          const items = Array.isArray(msg.d) ? msg.d : (msg.d && typeof msg.d === 'object' ? [msg.d] : [msg]);
          for (const x of items) {
            const symbol = String(x.sy || x.symbol || '').replace(/^MARK:/, '');
            if (!symbol) continue;
            if (msg.type === 'mark_price' || String(msg.type).includes('mark_price')) {
              const t = this.tickerMap.get(symbol);
              if (t) this.tickerMap.set(symbol, { ...t, mark_price: n(x.p || x.mark_price || x.c || t.mark_price) });
            } else if (String(msg.type || '').startsWith('candlestick_')) {
              // The exchange can stream candle events for every listed perpetual.
              // Do not build/retain history for symbols outside the bounded cache.
              if (!this.candleCacheSymbols.has(String(symbol).toUpperCase())) continue;
              const match = String(msg.type || '').match(/^candlestick_(.+)$/);
              const resolution = match?.[1] || String(x.res || '');
              if (!resolution || !['1m','5m','15m'].includes(resolution)) continue;
              const key = resolution + ':' + symbol;
              const current = Array.isArray(this.candles.get(key)) ? this.candles.get(key) : [];
              // cst is the stable candle-start timestamp (microseconds). ts is
              // the changing server publish timestamp, also in microseconds.
              const rawCandle = {
                time: x.cst ?? x.candle_start_time ?? x.ts ?? x.timestamp ?? x.t,
                open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v, res: resolution
              };
              const merged = mergeCandleUpdate(current, rawCandle, resolution, {
                maxAgeIntervals: candleMaxAgeIntervals(resolution, CONFIG.deltaExecutionMode === 'testnet')
              });
              if (!merged.ok) {
                // WebSocket feeds can replay duplicates/out-of-order buckets.
                // Log a representative failure per cooldown, not every tick.
                if (this.shouldLogCandleFailure(key)) {
                  void this.log('WARN', 'WebSocket candle update rejected; cached series preserved', {
                    symbol, resolution, reason: merged.reason,
                    incomingTimestamp: rawCandle.time ?? null,
                    latestTimestamp: current.at(-1)?.time ?? null,
                    count: current.length,
                    retryAfterMs: CONFIG.deltaExecutionMode === 'testnet'
                      ? CANDLE_TESTNET_WARMUP_RETRY_MS : CANDLE_WARMUP_RETRY_MS
                  }).catch(() => {});
                }
                if (['invalid_existing_series','stale_candle','future_timestamp'].includes(merged.reason)) {
                  this.scheduleCandleHealing(symbol, resolution, merged.reason);
                }
                continue;
              }
              const series = merged.candles.slice(-120);
              if (this.rejectAtrSpike(symbol, resolution, current, series, 'WebSocket')) continue;
              this.candles.set(key, series);
              if (merged.action === 'appended') {
                const count = (this.candleUpdateCounts.get(key) || 0) + 1;
                this.candleUpdateCounts.set(key, count);
                if (count % 100 === 0) {
                  void this.log('INFO', 'Candle stream diagnostic (100 new buckets)', {
                    symbol, resolution, bucketCount: count, candleCount: series.length,
                    firstTimestamp: series[0]?.time ?? null,
                    lastTimestamp: series.at(-1)?.time ?? null,
                    atr14: Number(calculateAtr(series).toFixed(8))
                  }).catch(() => {});
                }
              }
            } else if (msg.type === 'ticker' || msg.type === 'v2/ticker') {
              const t = this.tickerMap.get(symbol) || { symbol };
              this.tickerMap.set(symbol, {
                ...t,
                ...x,
                symbol,
                mark_price: n(x.mark_price || x.mp || t.mark_price),
                close: n(x.close || x.c || t.close),
                ltp_change_24h: n(x.ltp_change_24h || x.ch || t.ltp_change_24h),
                turnover_usd: n(x.turnover_usd || x.v || t.turnover_usd),
                open_interest: n(x.open_interest || x.oi || t.open_interest)
              });
            }
          }
        } catch {}
      });
      ws.on('close', (code, reasonBuffer) => {
        const wasCurrent = this.ws === ws;
        const wasConnected = wasCurrent && this.wsConnected;
        if (wasCurrent) {
          this.wsConnected = false;
          this.ws = null;
          this.wsCandleSubscribedSymbols = new Set();
        }
        if (this.wsOpenedAt === openedAt) this.wsOpenedAt = 0;
        const reason = reasonBuffer ? reasonBuffer.toString().slice(0, 160) : '';
        if (wasConnected) this.preserveCandleCacheForHealing('websocket_disconnect');

        const uptimeMs = openedAt > 0 ? Date.now() - openedAt : 0;
        if (uptimeMs >= 60_000) this.wsRetry = 0;
        const rateLimited = this.wsRateLimited || Number(code) === 429 ||
          /429|rate.?limit|too many connections/i.test(reason);
        const wait = websocketReconnectDelay(this.wsRetry, { baseMs: 1_000, rateLimited });
        this.wsRetry = Math.min(this.wsRetry + 1, 16);
        this.wsRateLimited = false;
        if (wasCurrent && this.shouldLogWebSocketWarning()) {
          void this.log('WARN', 'WebSocket disconnected; reconnect scheduled', {
            code, reason, wasConnected, retryInMs: wait, retryAttempt: this.wsRetry,
            rateLimited
          }).catch(() => {});
        }
        if (wasCurrent) this.scheduleWsReconnect(wait);
        cleanupWebSocketListeners(ws);
      });
      ws.on('error', error => {
        const message = String(error?.message || error);
        const wasCurrent = this.ws === ws;
        const wasConnected = wasCurrent && this.wsConnected;
        const rateLimited = /429|rate.?limit|too many connections|unexpected server response: 429/i.test(message);
        if (wasCurrent) {
          this.ws = null;
          this.wsConnected = false;
          this.wsCandleSubscribedSymbols = new Set();
          this.wsRateLimited = rateLimited;
          if (this.wsOpenedAt === openedAt) this.wsOpenedAt = 0;
        }
        if (wasConnected) this.preserveCandleCacheForHealing('websocket_error');
        // Schedule the retry before tearing down this socket so a missing close
        // event cannot strand the scanner without a market-data connection.
        const wait = websocketReconnectDelay(this.wsRetry, { baseMs: 1_000, rateLimited });
        this.wsRetry = Math.min(this.wsRetry + 1, 16);
        if (wasCurrent && this.shouldLogWebSocketWarning()) {
          void this.log('WARN', 'WebSocket error; reconnect scheduled and candle cache preserved', {
            error: message.slice(0, 200),
            retryInMs: wait,
            rateLimited
          }).catch(() => {});
        }
        if (wasCurrent) this.scheduleWsReconnect(wait);
        cleanupWebSocketListeners(ws);
        try { ws.terminate?.(); } catch {}
        try { ws.close(); } catch {}
      });
    } catch (error) {
      this.ws = null;
      const message = String(error?.message || error);
      const rateLimited = /429|rate.?limit|too many connections/i.test(message);
      const wait = websocketReconnectDelay(this.wsRetry, { baseMs: 1_000, rateLimited });
      this.wsRetry = Math.min(this.wsRetry + 1, 16);
      this.wsRateLimited = false;
      if (this.shouldLogWebSocketWarning()) {
        void this.log('WARN', 'WebSocket construction failed; reconnect scheduled', {
          error: message.slice(0, 200), retryInMs: wait, rateLimited
        }).catch(() => {});
      }
      this.scheduleWsReconnect(wait);
    }
  }

  getTradetronBridgeForSymbol(symbol) {
    const selected = String(symbol || '').toUpperCase();
    const configuredRoutes = Array.isArray(CONFIG.tradetronBridgeRoutes) ? CONFIG.tradetronBridgeRoutes : [];
    if (configuredRoutes.length) {
      const route = configuredRoutes.find(item => item.symbols.includes(selected));
      return route ? this.tradetronRouteBridges.get(route.id) || null : null;
    }
    return this.tradetron.supportsFuturesSymbol(selected) ? this.tradetron : null;
  }

  async expireStaleSignalReservations() {
    if (!CONFIG.signalOnly || !CONFIG.tradetronBridgeEnabled) return;
    const nowMs = Date.now();
    if (nowMs - this.lastSignalReservationExpiryAt < 60000) return;
    this.lastSignalReservationExpiryAt = nowMs;
    const cutoff = new Date(nowMs - SIGNAL_RESERVATION_TTL_MS).toISOString();
    try {
      const expired = await db.updateReturning(
        'dd_orders',
        'order_type=eq.tradetron_signal&state=in.(PENDING,SIGNAL_SENT)' +
          '&updated_at=lt.' + encodeURIComponent(cutoff) +
          '&select=id,symbol,state,failure_reason',
        { state: 'EXPIRED', updated_at: new Date(nowMs).toISOString() }
      );
      const rows = Array.isArray(expired) ? expired : [];
      if (rows.length) {
        await Promise.all(rows.filter(row => !String(row?.failure_reason || '').trim()).map(row =>
          db.update('dd_orders',
            'id=eq.' + encodeURIComponent(String(row.id || '')) + '&failure_reason=is.null',
            {
              failure_reason: 'signal_expired',
              failure_detail: 'Signal reservation expired before authenticated confirmation'
            }
          ).catch(() => {})
        ));
        await this.log('INFO', 'Stale Tradetron signal reservations expired', {
          count: rows.length,
          ttlMs: SIGNAL_RESERVATION_TTL_MS,
          symbols: [...new Set(rows.map(row => String(row.symbol || '').toUpperCase()).filter(Boolean))],
          note: 'No authenticated activity confirmation arrived before TTL; expiry is not a fill/close event'
        });
      }
    } catch (error) {
      // The in-memory age filter below still prevents old records from reserving
      // symbols if this best-effort persistence update temporarily fails.
      await this.log('WARN', 'Stale Tradetron reservation cleanup failed; age filter remains active', {
        ttlMs: SIGNAL_RESERVATION_TTL_MS,
        error: error.message
      });
    }
  }

  async getTradetronSnapshotRiskState() {
    if (!CONFIG.tradetronDeveloperApiKey || !this.tradetronDeveloperApi.isConfigured()) {
      return {
        configured: false, trusted: null, reason: 'DEVELOPER_API_NOT_CONFIGURED',
        openPositions: [], positionCount: null, lastSuccessAt: null, ageMs: null
      };
    }
    const now = Date.now();
    if (this.lastTradetronSnapshotRiskState &&
        now - this.lastTradetronSnapshotRiskStateAt < 10000) {
      return this.lastTradetronSnapshotRiskState;
    }
    if (this.tradetronSnapshotRiskStateInFlight) return this.tradetronSnapshotRiskStateInFlight;

    this.tradetronSnapshotRiskStateInFlight = (async () => {
      let result;
      try {
        const [syncRows, snapshotRows] = await Promise.all([
          db.select('dd_tradetron_developer_sync_state', 'id=eq.1&select=id,status,last_success_at,details'),
          db.select('dd_tradetron_developer_snapshots', 'order=deployment_id.asc')
        ]);
        const syncState = Array.isArray(syncRows) ? syncRows[0] || null : null;
        const ids = Array.isArray(syncState?.details?.deploymentIds)
          ? syncState.details.deploymentIds.map(value => String(value))
          : [];
        const snapshots = (Array.isArray(snapshotRows) ? snapshotRows : []).filter(row =>
          ids.includes(String(row?.deployment_id ?? ''))
        );
        result = buildTradetronSnapshotRiskState({
          syncState,
          deployments: snapshots,
          now,
          maxAgeMs: TRADETRON_SNAPSHOT_MAX_AGE_MS
        });
      } catch (error) {
        result = {
          configured: true, trusted: false, reason: 'SNAPSHOT_LOOKUP_FAILED',
          openPositions: [], positionCount: null, lastSuccessAt: null, ageMs: null,
          detail: String(error?.message || error).slice(0, 240)
        };
      }
      this.lastTradetronSnapshotRiskState = result;
      this.lastTradetronSnapshotRiskStateAt = Date.now();
      return result;
    })();
    try {
      return await this.tradetronSnapshotRiskStateInFlight;
    } finally {
      this.tradetronSnapshotRiskStateInFlight = null;
    }
  }

  async getSignalOnlyPositions(openRows) {
    let positions = Array.isArray(openRows) ? [...openRows] : [];
    if (!CONFIG.signalOnly || !CONFIG.tradetronBridgeEnabled) return positions;

    const snapshotSafety = await this.getTradetronSnapshotRiskState();
    this.lastTradetronEntrySafety = snapshotSafety;
    if (snapshotSafety.trusted !== true) {
      if (Date.now() - this.lastTradetronEntrySafetyLogAt >= 60000) {
        this.lastTradetronEntrySafetyLogAt = Date.now();
        await this.log('WARN', 'New Tradetron entries blocked: Developer API position snapshot is not trusted', {
          reason: snapshotSafety.reason,
          lastSuccessAt: snapshotSafety.lastSuccessAt,
          ageMs: snapshotSafety.ageMs,
          detail: snapshotSafety.detail || null,
          note: 'Read-only position snapshots are used only for duplicate-entry safety, never as fills or exit confirmations'
        });
      }
      return null;
    }

    if (snapshotSafety.configured && snapshotSafety.trusted) {
      const occupiedSymbols = new Set(positions
        .filter(row => Math.abs(Number(row?.qty) || 0) > 0)
        .map(row => String(row?.symbol || '').toUpperCase()));
      const snapshotOnly = snapshotSafety.openPositions.filter(position =>
        !occupiedSymbols.has(String(position.symbol || '').toUpperCase())
      );
      positions = positions.concat(snapshotOnly);
    }

    try {
      const cutoff = new Date(Date.now() - SIGNAL_RESERVATION_TTL_MS).toISOString();
      const pendingSignals = await db.select(
        'dd_orders',
        'order_type=eq.tradetron_signal&state=in.(PENDING,SIGNAL_SENT)' +
          '&updated_at=gte.' + encodeURIComponent(cutoff) +
          '&select=symbol,side,strategy,size,execution_id,client_order_id,created_at,updated_at,state' +
          '&order=updated_at.desc&limit=500'
      );
      return withSignalReservations(positions, pendingSignals || []);
    } catch (error) {
      await this.log('ERROR', 'Tradetron slot reservation lookup failed; new entries blocked', {
        error: error.message
      });
      return null;
    }
  }

  async recordGlobalPositionCapBlock(candidate, decision) {
    const symbol = String(candidate?.signal?.symbol || candidate?.item?.ticker?.symbol || '').toUpperCase();
    const strategy = String(candidate?.strategy || '').toUpperCase();
    const reason = decision?.reason || 'global_position_count_untrusted';
    const message = reason === 'global_position_cap_reached'
      ? 'Signal ' + symbol + ' blocked by global cap: openCount=' +
        decision.openCount + '/' + decision.maxOpenPositions
      : 'Signal ' + symbol + ' blocked because global position count is not trusted';

    if (candidate?.signal && typeof candidate.signal === 'object') {
      const priorReasons = Array.isArray(candidate.signal.blocked) ? candidate.signal.blocked : [];
      candidate.signal.blocked = [...new Set([...priorReasons, reason])];
      candidate.signal.ready = false;
    }

    // Persist the gate reason to the live signal cache so the UI explains the
    // block. This write is diagnostic only; the gate remains fail-closed if it fails.
    try {
      const cacheKey = symbol + ':' + strategy;
      const blockedReasons = Array.isArray(candidate?.signal?.blocked)
        ? candidate.signal.blocked : [reason];
      await db.update(
        'dd_signal_cache',
        'cache_key=eq.' + encodeURIComponent(cacheKey),
        { ready: false, blocked_reasons: [...new Set([...blockedReasons, reason])], cached_at: iso() }
      );
    } catch (error) {
      await this.log('ERROR', 'Global position cap block could not be persisted to signal cache', {
        symbol, strategy, reason, error: String(error?.message || error).slice(0, 240)
      });
    }

    const logKey = [symbol, strategy, reason, decision?.openCount ?? 'UNKNOWN', decision?.maxOpenPositions ?? 20].join(':');
    if (!this.globalPositionCapLogged.has(logKey)) {
      this.globalPositionCapLogged.add(logKey);
      await this.log('WARN', message, {
        symbol,
        strategy,
        reason,
        openCount: decision?.openCount ?? null,
        maxOpenPositions: decision?.maxOpenPositions ?? 20,
        snapshotReason: decision?.snapshotReason || null,
        lastSuccessAt: decision?.lastSuccessAt || null,
        source: 'trusted Tradetron Developer API snapshot',
        failClosed: true
      });
    }
  }

  async manageTradetronPositions(rows, settings = {}) {
    if (!CONFIG.signalOnly || !CONFIG.tradetronBridgeEnabled) return;
    const marketAge = Date.now() - Math.max(this.lastTickerFetch || 0, this.lastTickAt || 0);
    if (marketAge > 90000) {
      await this.log('WARN', 'Tradetron exit monitor skipped because market data is stale', { marketAgeMs: marketAge });
      return;
    }

    const now = Date.now();
    const timeoutMs = Math.max(1, n(settings.max_hold_minutes || 240)) * 60000;
    for (const row of Array.isArray(rows) ? rows : []) {
      const symbol = String(row.symbol || '').toUpperCase();
      const strategy = String(row.strategy || '').toUpperCase();
      const qty = Math.abs(n(row.qty));
      const sideValue = String(row.side || '').toUpperCase();
      const side = ['BUY', 'LONG'].includes(sideValue) ? 'BUY'
        : ['SELL', 'SHORT'].includes(sideValue) ? 'SELL' : '';
      // This manager intentionally handles only the existing fixed futures
      // Signal Bridge. Options have separate instrument/hedge semantics.
      if (row.origin !== 'TRADETRON' || qty <= 0 ||
          !/^[A-Z0-9]+USD$/.test(symbol) || symbol === 'USD' ||
          !['MOMENTUM', 'SCALPING'].includes(strategy) || !side) continue;

      const existingReason = String(row.requested_exit_reason || '').toUpperCase();
      const updatedAt = Date.parse(row.updated_at || 0) || 0;
      if (existingReason.startsWith('BRIDGE_EXIT:')) continue;
      if (existingReason && !existingReason.startsWith('BRIDGE_EXIT_PENDING:')) continue;
      if (existingReason.startsWith('BRIDGE_EXIT_PENDING:') && now - updatedAt < 120000) continue;

      const ticker = this.tickerMap.get(symbol);
      const mark = n(ticker?.mark_price || ticker?.close || ticker?.price);
      if (!(mark > 0)) continue;
      const stop = n(row.stop_price);
      const target = n(row.tp_price);
      let reason = '';

      if (side === 'BUY') {
        if (stop > 0 && mark <= stop) reason = 'STOP_LOSS';
        else if (target > 0 && mark >= target) reason = 'TAKE_PROFIT';
      } else {
        if (stop > 0 && mark >= stop) reason = 'STOP_LOSS';
        else if (target > 0 && mark <= target) reason = 'TAKE_PROFIT';
      }

      const openedAt = Date.parse(row.opened_at || 0) || 0;
      if (!reason && openedAt > 0 && now - openedAt >= timeoutMs) reason = 'TIMEOUT';
      if (!reason) continue;

      const bridge = this.getTradetronBridgeForSymbol(symbol);
      if (!bridge || !bridge.isConfigured()) continue;
      const executionId = String(row.execution_id || row.client_order_id || '');
      try {
        await db.update('dd_positions',
          'execution_id=eq.' + encodeURIComponent(executionId),
          { requested_exit_reason: 'BRIDGE_EXIT_PENDING:' + reason, current_price: mark, updated_at: iso() }
        );
        const result = await bridge.emitExit({ symbol, side, reason, executionId });
        if (!result.ok) {
          // A confirmed non-success can be retried on the next loop.
          await db.update('dd_positions',
            'execution_id=eq.' + encodeURIComponent(executionId),
            { requested_exit_reason: null, updated_at: iso() }
          ).catch(() => {});
          await this.log('ERROR', 'Tradetron exit signal was not accepted', {
            symbol, side, qty, reason, executionId, response: result.response || null
          });
          continue;
        }
        await db.update('dd_positions',
          'execution_id=eq.' + encodeURIComponent(executionId),
          { requested_exit_reason: 'BRIDGE_EXIT:' + reason, current_price: mark, updated_at: iso() }
        );
        await this.log('INFO', 'Tradetron exit trigger sent from scanner risk monitor', {
          symbol, side, qty, mark, stop, target, reason, executionId,
          triggerKey: result.triggerKey || null
        });
      } catch (error) {
        // Leave the pending marker for two minutes: the request may have
        // reached Tradetron even if the network response was lost.
        await this.log('ERROR', 'Tradetron exit monitor failed closed', {
          symbol, side, qty, reason, executionId, error: error.message
        });
      }
    }
  }

  async runOptionsRestartSupervisor() {
    // The supervisor is read/reconcile-only. It must run under the same worker
    // lease as the scanner and only against the hardcoded India Testnet client.
    // Missing dedicated Options credentials means no private API call is made.
    const mode = String(process.env.DELTA_EXECUTION_MODE || '').trim().toLowerCase();
    const hasDedicatedOptionsCredentials = Boolean(
      String(process.env.DELTA_TESTNET_OPTIONS_API_KEY || '').trim() &&
      String(process.env.DELTA_TESTNET_OPTIONS_API_SECRET || '').trim()
    );
    if (mode !== 'testnet' || !hasDedicatedOptionsCredentials) return null;
    if (!this.leaseManager?.isHeld) return null;

    const now = Date.now();
    if (now - this.lastOptionsSupervisorRunAt < 60_000) return null;
    this.lastOptionsSupervisorRunAt = now;

    const result = await this.optionsSupervisor.reconcileOnce();
    const status = String(result?.status || 'SUPERVISOR_UNAVAILABLE').toUpperCase();
    const previousStatus = this.lastOptionsSupervisorStatus;
    this.lastOptionsSupervisorStatus = status;
    if (status !== 'RECONCILED' && status !== 'NO_ACTIVE_GROUP' &&
        (status !== previousStatus || now - this.lastOptionsSupervisorLogAt >= 300_000)) {
      this.lastOptionsSupervisorLogAt = now;
      await this.log(
        status === 'SUPERVISOR_UNAVAILABLE' ? 'ERROR' : 'WARN',
        'Delta Testnet Options restart supervisor is blocking execution',
        {
          status,
          reason: result?.reason || null,
          groupId: result?.groupId || result?.group?.group_id || null,
          positionCount: result?.positionCount ?? null,
          openOrderCount: result?.openOrderCount ?? null,
          openQty: result?.openQty ?? null,
          expiryExitDue: result?.expiryExitDue === true,
          executionEnabled: false
        }
      );
    }
    return result;
  }

  async scanOnce() {
    if (!this.leaseManager.isHeld) {
      throw new Error('Trading lease is not confirmed; scan and entry processing fail closed');
    }
    try {
      await this.runOptionsRestartSupervisor();
    } catch (error) {
      // Options reconciliation is isolated from the Futures scan loop. The
      // Options source-code lock remains false if this monitor is unavailable.
      const now = Date.now();
      if (now - this.lastOptionsSupervisorLogAt >= 300_000) {
        this.lastOptionsSupervisorLogAt = now;
        await this.log('ERROR', 'Delta Testnet Options restart supervisor failed closed', {
          error: String(error?.message || error).slice(0, 240),
          executionEnabled: false
        });
      }
    }
    await this.expireStaleSignalReservations();
    const settings = { ...{
      enabled: true, auto_trade: true, emergency_stop: false, continuous_mode: true,
      max_open_positions: 20, risk_pct: 0.3, max_leverage: 3, score_min: 65,
      options_underlyings: 'BTC,ETH,XAUT',
      momentum_sl_min_pct: 0.95, scalping_sl_min_pct: 0.75, momentum_rr: 2.5,
      scalping_rr: 2.5, tp1_pct: 33, max_hold_minutes: 240
    }, ...(await this.loadSettings()) };
    this.currentSettings = settings;
    // Optional read-only account sync runs off the scanner's critical path. The
    // single leased worker coordinates it to at most one run per minute.
    if (Date.now() - this.lastUniverseRefresh > 15 * 60 * 1000 || !this.products.length) await this.refreshProducts();
    if (Date.now() - this.lastTickerFetch > 30000 || !this.tickerMap.size) {
      await this.refreshTickers();
      await this.cacheMarketState();
    } else {
      await this.cacheMarketState();
    }
    await this.refreshCandleWarmup();
    if (settings.options_enabled !== false &&
        (!this.lastOptionTickerFetch || Date.now() - this.lastOptionTickerFetch >= 60000)) {
      await this.refreshOptionTickers(settings);
    } else if (settings.options_enabled === false) {
      this.optionTickerMap.clear();
    }

    const account = await this.accountSnapshot(settings);
    try {
      await this.manageGridStrategy(settings, account);
    } catch (error) {
      await this.log('ERROR', 'Grid strategy cycle failed without affecting the main scanner', {
        error: error.message, symbol: settings.grid_symbol || 'ETHUSD'
      });
    }
    // In production SIGNAL_ONLY mode, dd_positions are legacy scanner-owned
    // execution records and must never be treated as live positions. Tradetron
    // owns execution; actual Offline positions arrive through the Tradetron
    // activity webhook and are exposed separately by the API.
    let openRows = CONFIG.signalOnly ? await db.select('dd_positions', 'origin=eq.TRADETRON&qty=gt.0&order=updated_at.desc') : await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
    if (
      !CONFIG.signalOnly &&
      this.privateExecutionAvailable &&
      Date.now() - this.lastReconcile > 60000 &&
      (!CONFIG.tradetronBridgeEnabled || (openRows || []).length)
    ) {
      try {
        await this.reconcile();
        this.lastReconcile = Date.now();
      } catch (e) {
        await this.log('WARN', 'Legacy Delta position reconciliation unavailable; direct engine remains fail-closed', {
          error: e.message, bridge: CONFIG.tradetronBridgeEnabled
        });
      }
      openRows = await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
    }
    // Tradetron exit/risk sync remains the fallback when direct Testnet is disabled.
    if (CONFIG.signalOnly && CONFIG.deltaExecutionMode !== 'testnet') {
      await this.manageTradetronPositions(openRows || [], settings);
    }
    let riskPositions = openRows || [];
    let reservationLookupFailed = false;
    if (CONFIG.signalOnly && CONFIG.deltaExecutionMode !== 'testnet') {
      const merged = await this.getSignalOnlyPositions(openRows || []);
      if (Array.isArray(merged)) riskPositions = merged;
      else reservationLookupFailed = true;
    } else if (CONFIG.deltaExecutionMode === 'testnet') {
      riskPositions = (account.positions || []).map(position => ({
        ...position,
        qty: Math.abs(n(position.qty ?? position.size)),
        side: position.side || (n(position.size) < 0 ? 'SELL' : 'BUY')
      }));
    }
    const trades = await this.recentTrades();
    if (Date.now() - this.lastAnalysis > 55000 || !this.lastSignals.length) {
      await this.analyseUniverse(account, settings, riskPositions, trades || []);
      this.lastAnalysis = Date.now();
    }
    const positions = riskPositions;
    if (settings.enabled && settings.auto_trade && !settings.emergency_stop) {
      const candidates = [];
      const gridStateForRouting = settings.grid_state && typeof settings.grid_state === 'object'
        ? settings.grid_state : {};
      const gridSymbolForRouting = String(settings.grid_symbol || 'ETHUSD').toUpperCase();
      const gridPositionOpen = CONFIG.signalOnly && CONFIG.deltaExecutionMode !== 'testnet' &&
        (Array.isArray(gridStateForRouting.positions) ? gridStateForRouting.positions : [])
          .some(position => !!position?.bridgeExecutionId);
      for (const item of this.lastSignals) {
        // Momentum/Scalping may use the same Tradetron template, but must not
        // race a Grid position on the same netted futures symbol.
        if (CONFIG.signalOnly && CONFIG.deltaExecutionMode !== 'testnet' &&
            String(item.symbol || '').toUpperCase() === gridSymbolForRouting &&
            (gridPositionOpen || settings.grid_bridge_action_this_cycle === true)) continue;
        const futuresChoices = [
          { strategy: 'MOMENTUM', signal: item.mom },
          { strategy: 'SCALPING', signal: item.scalp }
        ].filter(x => x.signal?.stage === 'CONFIRMED' && x.signal?.ready);
        for (const choice of futuresChoices) candidates.push({ item, ...choice });

        const optionBuy = item.options?.buy;
        if (optionBuy?.stage === 'CONFIRMED' && optionBuy?.ready) {
          candidates.push({ item, strategy: 'OPTIONS_BUY', signal: optionBuy });
        }
        const optionSell = item.options?.sell;
        if (optionSell?.stage === 'CONFIRMED' && optionSell?.ready) {
          candidates.push({ item, strategy: 'OPTIONS_SELL', signal: optionSell });
        }
      }

      candidates.sort((a, b) => {
        const scoreDelta = n(b.signal.score) - n(a.signal.score);
        if (scoreDelta) return scoreDelta;
        const rank = { MOMENTUM: 4, SCALPING: 3, OPTIONS_BUY: 2, OPTIONS_SELL: 2 };
        return (rank[b.strategy] || 0) - (rank[a.strategy] || 0);
      });

      // The global cap is a final pre-route gate, separate from riskGate/openTrade
      // and the existing duplicate-symbol blocker. It uses the same trusted
      // Tradetron snapshot source as the dashboard and fails closed on unknown counts.
      let baselineTrustedOpenCount = null;
      let routedThisCycle = 0;
      const testnetSymbolsRoutedThisCycle = new Set();
      for (const c of candidates) {
        const candidateSymbol = String(c.signal?.symbol || c.item?.symbol || '').toUpperCase();
        if (CONFIG.deltaExecutionMode === 'testnet' && testnetSymbolsRoutedThisCycle.has(candidateSymbol)) continue;
        if (CONFIG.signalOnly && reservationLookupFailed) break;
        let capDecision = { blocked: false, reason: null };
        if (CONFIG.signalOnly && CONFIG.tradetronBridgeEnabled && CONFIG.deltaExecutionMode !== 'testnet') {
          const snapshotSafety = await this.getTradetronSnapshotRiskState();
          this.lastTradetronEntrySafety = snapshotSafety;
          if (snapshotSafety?.trusted === true &&
              Number.isSafeInteger(snapshotSafety.positionCount) &&
              snapshotSafety.positionCount >= 0 &&
              baselineTrustedOpenCount === null) {
            baselineTrustedOpenCount = snapshotSafety.positionCount;
          }

          capDecision = evaluateGlobalPositionCap({
            snapshotSafety,
            settings,
            envOverride: process.env.MAX_OPEN_POSITIONS_CAP,
            baselineOpenCount: baselineTrustedOpenCount,
            routedThisCycle
          });
          if (capDecision.blocked) {
            await this.recordGlobalPositionCapBlock(c, capDecision);
            continue;
          }
          this.globalPositionCapLogged.clear();
        }
        const freshAccount = await this.accountSnapshot(settings);
        const storedPositions = CONFIG.deltaExecutionMode === 'testnet'
          ? []
          : CONFIG.signalOnly
            ? await db.select('dd_positions', 'origin=eq.TRADETRON&qty=gt.0&order=updated_at.desc')
            : await db.select('dd_positions', 'qty=gt.0&order=updated_at.desc');
        const freshPositions = CONFIG.deltaExecutionMode === 'testnet'
          ? (freshAccount.positions || []).map(position => ({
              ...position,
              qty: Math.abs(n(position.qty ?? position.size)),
              side: position.side || (n(position.size) < 0 ? 'SELL' : 'BUY')
            }))
          : CONFIG.signalOnly
            ? await this.getSignalOnlyPositions(storedPositions || [])
            : (storedPositions || []);
        if (!Array.isArray(freshPositions)) {
          reservationLookupFailed = true;
          break;
        }
        const routeAttempt = await routeUnlessGlobalPositionCapBlocked(
          capDecision,
          () => this.openTrade(c.item, c.strategy, c.signal, freshAccount, settings, freshPositions, trades)
        );
        if (routeAttempt.blocked) {
          await this.recordGlobalPositionCapBlock(c, { ...capDecision, blocked: true, reason: routeAttempt.reason });
          continue;
        }
        const opened = routeAttempt.result;
        if (opened) {
          if (CONFIG.deltaExecutionMode === 'testnet') testnetSymbolsRoutedThisCycle.add(candidateSymbol);
          if (CONFIG.signalOnly && CONFIG.tradetronBridgeEnabled && CONFIG.deltaExecutionMode !== 'testnet') routedThisCycle++;
          await sleep(1000);
        }
      }
    }

    const heartbeatMemory = summarizeMemoryUsage(process.memoryUsage());
    let heartbeatCandleCount = 0;
    for (const series of this.candles.values()) {
      if (Array.isArray(series)) heartbeatCandleCount += series.length;
    }
    const heartbeatMessage = 'Worker heartbeat scan ' + formatMemoryLog(heartbeatMemory);
    console.log(heartbeatMessage);
    const unrealized = account.positions.reduce((s, p) => s + n(p.unrealized_pnl), 0);
    const closed = trades || [];
    const realized = closed.reduce((s, t) => s + n(t.net_pnl), 0);
    const feesToday = closed.filter(t => indiaDateKey(t.closed_at) === today()).reduce((s, t) => s + n(t.fees), 0);
    const idle = candidatesText(this.lastSignals);
    await this.updateEngineState({
      equity: account.equity, available_balance: account.available, realized_pnl: realized,
      unrealized_pnl: unrealized, fees_today: feesToday,
      last_tick_at: new Date(this.lastTickAt || Date.now()).toISOString(),
      worker_started_at: new Date(this.startedAt).toISOString(), idle_reason: idle
    });
    await this.log('INFO', heartbeatMessage, {
      // Keep the generic mode alias for dashboard/API consumers; deltaExecutionMode
      // remains the canonical worker configuration key.
      executionMode: CONFIG.deltaExecutionMode,
      deltaExecutionMode: CONFIG.deltaExecutionMode,
      deltaEnvironment: CONFIG.environment,
      ...heartbeatMemory,
      candleCacheLimit: this.candleCacheLimit,
      candleCacheSymbols: this.candleCacheSymbols.size,
      candleCacheSeries: this.candles.size,
      cachedCandles: heartbeatCandleCount,
      tickerSymbols: this.tickerMap.size,
      optionTickerSymbols: this.optionTickerMap.size,
      lastTickAt: this.lastTickAt,
      signals: this.lastSignals.length,
      positions: (positions || []).filter(position =>
        Math.abs(n(position?.qty ?? position?.size)) > 0
      ).length,
      gridEntrySafety: this.lastGridEntrySafety || null
    });
  }
  async recordMemoryUsage(reason = 'periodic') {
    const memory = summarizeMemoryUsage(process.memoryUsage());
    let cachedCandleCount = 0;
    for (const series of this.candles.values()) {
      if (Array.isArray(series)) cachedCandleCount += series.length;
    }
    const data = {
      reason,
      ...memory,
      candleCacheLimit: this.candleCacheLimit,
      candleCacheSymbols: this.candleCacheSymbols.size,
      candleCacheSeries: this.candles.size,
      cachedCandles: cachedCandleCount,
      tickerSymbols: this.tickerMap.size,
      optionTickerSymbols: this.optionTickerMap.size
    };
    const message = formatMemoryLog(memory);
    console.log(message + ' | reason=' + reason +
      ' | candles=' + cachedCandleCount +
      ' | candleSeries=' + this.candles.size +
      ' | cacheSymbols=' + this.candleCacheSymbols.size +
      ' | optionTickers=' + this.optionTickerMap.size);
    try {
      await this.log('INFO', message, data);
    } catch (error) {
      console.warn('[Memory] Could not persist memory metrics:', safeMaintenanceError(error));
    }
    return data;
  }

  startMemoryMonitor() {
    if (this.memoryMonitorInterval) return;
    void this.recordMemoryUsage('startup').catch(error => {
      console.warn('[Memory] Startup memory sample failed:', safeMaintenanceError(error));
    });
    this.memoryMonitorInterval = setInterval(() => {
      void this.recordMemoryUsage('periodic').catch(error => {
        console.warn('[Memory] Periodic memory sample failed:', safeMaintenanceError(error));
      });
    }, MEMORY_LOG_INTERVAL_MS);
    this.memoryMonitorInterval.unref?.();
  }

  async run() {
    if (!CONFIG.signalOnly || CONFIG.directDeltaExecutionEnabled) {
      throw new Error('Production direct execution disabled; scanner must be SIGNAL_ONLY');
    }
    if (this.running) return;
    this.running = true;
    this.leaseEnforced = true;
    try {
      // The lease is acquired once per worker process and renewed by the
      // manager timer; scanOnce must never acquire or release it.
      await this.acquireLease();
      if (!this.running) return;
      this.startMemoryMonitor();
      this.startMaintenanceTasks();
      this.connectWs();
      await this.log('INFO', 'Delta production SIGNAL_ONLY worker started', {
        workerId: CONFIG.workerId,
        leaseTtlSeconds: this.leaseManager.ttlSeconds,
        leaseRenewalIntervalMs: this.leaseManager.renewEveryMs
      });
      await this.hydrateSignalDedupCache();
      // Verify database headroom before the first scan can append a history batch.
      if (hasMaintenanceDatabaseUrl()) await this.checkDiskHealth();

      while (this.running) {
        let cycle = null;
        try {
          cycle = this.scanOnce();
          this.activeScanPromise = cycle;
          await cycle;
          this.consecutiveLeaseFailures = 0;
        } catch (error) {
          const message = String(error?.message || error);
          if (message.includes('Trading lease is held by another worker')) {
            this.consecutiveLeaseFailures += 1;
            if (this.consecutiveLeaseFailures >= 3 && Date.now() - this.lastDuplicateWorkerLogAt >= 60_000) {
              this.lastDuplicateWorkerLogAt = Date.now();
              await this.log('ERROR', 'DUPLICATE WORKER DETECTED', {
                workerId: CONFIG.workerId,
                consecutiveLeaseFailures: this.consecutiveLeaseFailures,
                leaseTtlSeconds: this.leaseManager.ttlSeconds,
                reason: 'Another worker owns the trading lease; this worker made no scan or entry attempt'
              }).catch(logError => {
                console.warn('[DeltaScanner] Could not persist duplicate-worker diagnostic; cycle remains safely skipped:', String(logError?.message || logError));
              });
            }
            if (Date.now() - this.lastLeaseContentionLogAt >= 60_000) {
              this.lastLeaseContentionLogAt = Date.now();
              await this.log('WARN', 'Worker cycle skipped safely: trading lease is held by another worker', {
                workerId: CONFIG.workerId,
                consecutiveLeaseFailures: this.consecutiveLeaseFailures,
                reason: 'Lease contention; no scan or entry attempted'
              }).catch(logError => {
                console.warn('[DeltaScanner] Could not persist lease-skip diagnostic; cycle remains safely skipped:', String(logError?.message || logError));
              });
            }
            this.running = false;
          } else {
            this.consecutiveLeaseFailures = 0;
            await this.log('ERROR', 'Engine failed closed for cycle', {
              error: message, code: error?.code || null, status: error?.status || null, details: error?.details || null
            });
            if (!this.leaseManager.isHeld) this.running = false;
          }
        } finally {
          if (this.activeScanPromise === cycle) this.activeScanPromise = null;
        }
        if (this.running) await sleep(15000);
      }
    } finally {
      this.running = false;
      // Graceful shutdown waits for the current scan to finish before releasing
      // the process-wide lease, preventing a second worker from overlapping it.
      const activeScan = this.activeScanPromise;
      if (activeScan) {
        try { await activeScan; } catch {}
        if (this.activeScanPromise === activeScan) this.activeScanPromise = null;
      }
      await this.releaseLease();
    }
  }

  async stop() {
    this.running = false;
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    this.wsReconnectTimer = null;
    if (this.memoryMonitorInterval) clearInterval(this.memoryMonitorInterval);
    this.memoryMonitorInterval = null;
    const socket = this.ws;
    this.ws = null;
    this.wsConnected = false;
    this.wsOpenedAt = 0;
    this.wsCandleSubscribedSymbols = new Set();
    if (socket) {
      cleanupWebSocketListeners(socket);
      try { socket.close(); } catch {}
      try { socket.terminate?.(); } catch {}
    }
    // Do not close scan dependencies or relinquish the lease while scanOnce
    // is still routing work.
    const activeScan = this.activeScanPromise;
    if (activeScan) {
      try { await activeScan; } catch {}
      if (this.activeScanPromise === activeScan) this.activeScanPromise = null;
    }
    await this.stopMaintenanceTasks();
    await this.releaseLease();
  }
}

function candidatesText(signals) {
  const stage = {};
  const blocked = {};
  for (const item of signals || []) {
    for (const s of [item.mom, item.scalp]) {
      stage[s.stage] = (stage[s.stage] || 0) + 1;
      for (const reason of (s.blocked || []).slice(0, 3)) blocked[reason] = (blocked[reason] || 0) + 1;
    }
  }
  const top = Object.entries(blocked).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0] + ' (' + x[1] + ')').join(', ');
  return 'WATCH ' + (stage.WATCH || 0) + ' · SETUP ' + (stage.SETUP || 0) + ' · CONFIRMED ' + (stage.CONFIRMED || 0) + ' · Top blocks: ' + (top || 'none');
}
