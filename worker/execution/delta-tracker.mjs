import WebSocket from 'ws';
import * as defaultDb from '../../server/db.js';
import {
  assertDeltaTestnetConfiguration,
  deltaExecutor,
  DELTA_ENTRY_ORDER_LOOKUP_MAX_AGE_MS,
  DELTA_TESTNET_PRIVATE_WS_URL,
  deltaHmacSha256
} from './delta-executor.mjs';
import { shouldEmitThrottledLog, websocketReconnectDelay, WS_ERROR_LOG_COOLDOWN_MS } from '../ws-resilience.mjs';
import { cleanupWebSocketListeners } from '../websocket-lifecycle.mjs';
import { deltaCloseFields } from './delta-exit-events.mjs';

const stringValue = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const nowIso = () => new Date().toISOString();

export function strategyFromClientOrderId(clientOrderId, fallback = 'MOMENTUM') {
  const prefix = stringValue(clientOrderId).toUpperCase().split('-')[0];
  if (prefix === 'DDM') return 'MOMENTUM';
  if (prefix === 'DDS') return 'SCALPING';
  if (prefix === 'DDG') return 'GRID';
  return ['MOMENTUM', 'SCALPING', 'GRID'].includes(String(fallback).toUpperCase())
    ? String(fallback).toUpperCase() : 'MOMENTUM';
}

export function normalizeDeltaWsPosition(row) {
  const signedSize = numberOrNull(row?.size ?? row?.signed_size ?? row?.qty ?? row?.quantity);
  const symbol = stringValue(row?.product_symbol || row?.symbol).toUpperCase();
  if (!symbol || signedSize === null) return null;
  return {
    symbol,
    signedSize,
    qty: Math.abs(signedSize),
    side: signedSize < 0 ? 'SELL' : 'BUY',
    entry_price: numberOrNull(row?.entry_price ?? row?.entryPrice),
    current_price: numberOrNull(row?.mark_price ?? row?.current_price ?? row?.last_traded_price),
    unrealized_pnl: numberOrNull(row?.unrealized_pnl ?? row?.unrealizedPnl),
    realized_pnl: numberOrNull(row?.realized_pnl ?? row?.realizedPnl),
    product_id: numberOrNull(row?.product_id ?? row?.productId),
    order_id: row?.order_id ?? null,
    client_order_id: row?.client_order_id ?? null,
    sl_price: numberOrNull(row?.bracket_stop_loss_price ?? row?.sl_price),
    tp_price: numberOrNull(row?.bracket_take_profit_price ?? row?.tp_price),
    opened_at: row?.created_at || row?.opened_at || null,
    raw: row
  };
}

function fillTimestamp(value) {
  if (value === null || value === undefined || value === '') return { createdAt: null, timestampUs: null };
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const original = value.trim();
    const milliseconds = Date.parse(original);
    if (!Number.isFinite(milliseconds)) return { createdAt: null, timestampUs: null };
    // Date.parse preserves only milliseconds. Retain the original ISO timestamp
    // for PostgreSQL's microsecond-capable timestamptz column, and recover the
    // remaining microsecond digits for stable event ordering.
    const fraction = original.match(/\.(\d+)(?=Z|[+-]\d{2}(?::?\d{2})?$)/i)?.[1] || '';
    const microsecondRemainder = fraction.length > 3
      ? Number(fraction.slice(3, 6).padEnd(3, '0'))
      : 0;
    return {
      createdAt: original,
      timestampUs: Math.round(milliseconds * 1000) + microsecondRemainder
    };
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return { createdAt: null, timestampUs: null };
  const timestampUs = numeric > 1e14 ? Math.round(numeric)
    : numeric > 1e11 ? Math.round(numeric * 1000)
      : Math.round(numeric * 1_000_000);
  const milliseconds = timestampUs / 1000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 8.64e15) {
    return { createdAt: null, timestampUs: null };
  }
  return { createdAt: new Date(milliseconds).toISOString(), timestampUs };
}

/** Normalize both authenticated user_trades events and REST /v2/fills records. */
export function normalizeDeltaFill(fill, source = 'websocket') {
  if (!fill || typeof fill !== 'object' || Array.isArray(fill)) return null;
  const id = stringValue(fill.fill_id ?? fill.id);
  const symbol = stringValue(fill.product_symbol || fill.product?.symbol || fill.symbol).toUpperCase();
  const rawSide = stringValue(fill.side).toUpperCase();
  const side = rawSide === 'BUY' ? 'BUY' : rawSide === 'SELL' ? 'SELL' : '';
  const size = numberOrNull(fill.size ?? fill.qty);
  const price = numberOrNull(fill.price);
  const time = fillTimestamp(fill.created_at ?? fill.timestamp ?? fill.timestamp_us);
  if (!id || !symbol || !side || !(size > 0) || !(price > 0)) return null;
  return {
    id,
    order_id: fill.order_id === null || fill.order_id === undefined ? null : String(fill.order_id),
    product_id: numberOrNull(fill.product_id ?? fill.product?.id),
    symbol,
    side,
    size,
    price,
    notional: numberOrNull(fill.notional),
    commission: numberOrNull(fill.commission ?? fill.fee),
    commission_currency: stringValue(fill.settling_asset_symbol ?? fill.commission_currency ?? fill.fee_currency).toUpperCase() || null,
    role: stringValue(fill.role).toLowerCase() || null,
    fill_type: stringValue(fill.fill_type ?? fill.type).toLowerCase() || 'normal',
    client_order_id: stringValue(fill.client_order_id) || null,
    reason: stringValue(fill.reason) || null,
    timestamp_us: time.timestampUs,
    sequence_no: numberOrNull(fill.seq_no ?? fill.sequence_id ?? fill.seq_id),
    source: source === 'rest' ? 'rest' : 'websocket',
    created_at: time.createdAt,
    raw: fill
  };
}

/** Normalize authenticated Delta wallet movements for exchange-authoritative fees and funding. */
export function normalizeDeltaWalletTransaction(raw, source = 'rest') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = stringValue(raw.id);
  const transactionType = stringValue(raw.transaction_type).toLowerCase();
  const amount = numberOrNull(raw.amount);
  const time = fillTimestamp(raw.created_at ?? raw.timestamp ?? raw.timestamp_us);
  if (!id || !transactionType || amount === null || !time.createdAt) return null;
  const metadata = raw.meta_data && typeof raw.meta_data === 'object' && !Array.isArray(raw.meta_data)
    ? raw.meta_data : {};
  return {
    id,
    transaction_type: transactionType,
    amount,
    balance: numberOrNull(raw.balance),
    product_id: numberOrNull(raw.product_id),
    asset_id: numberOrNull(raw.asset_id),
    asset_symbol: stringValue(raw.asset_symbol).toUpperCase() || null,
    created_at: time.createdAt,
    timestamp_us: time.timestampUs,
    meta_data: metadata,
    source: source === 'rest' ? 'rest' : 'unknown',
    raw
  };
}

function weightedFillAverage(rows) {
  const valid = (Array.isArray(rows) ? rows : []).filter(row =>
    numberOrNull(row?.size) > 0 && numberOrNull(row?.price) > 0
  );
  const size = valid.reduce((sum, row) => sum + numberOrNull(row.size), 0);
  if (!(size > 0)) return null;
  return {
    size,
    price: valid.reduce((sum, row) => sum + numberOrNull(row.size) * numberOrNull(row.price), 0) / size,
    ids: valid.map(row => String(row.id)),
    commissionsComplete: valid.every(row => numberOrNull(row.commission) !== null),
    commissions: valid.every(row => numberOrNull(row.commission) !== null)
      ? valid.reduce((sum, row) => sum + numberOrNull(row.commission), 0)
      : null
  };
}

function rowsFromMessage(message) {
  const candidate = message?.result ?? message?.data?.result ?? message?.data ?? message?.payload ?? message;
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === 'object') {
    if (Array.isArray(candidate.positions)) return candidate.positions;
    if (candidate.position && typeof candidate.position === 'object') return [candidate.position];
    if (candidate.order && typeof candidate.order === 'object') return [candidate.order];
    return [candidate];
  }
  return [];
}

export class DeltaTestnetTracker {
  constructor({
    env = process.env,
    database = defaultDb,
    executor = deltaExecutor,
    WebSocketImpl = WebSocket,
    reconnectMs = 5000,
  } = {}) {
    this.env = env;
    this.database = database;
    this.executor = executor;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectMs = reconnectMs;
    this.socket = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.authenticated = false;
    this.retryCount = 0;
    this.symbolTimers = new Map();
    // Coalesce repeated position events into one bounded bracket metadata lookup per symbol.
    this.bracketMetadataSyncs = new Map();
    this.authTimeoutTimer = null;
    this.lastSocketWarningAt = 0;
    this.fillSyncInterval = null;
    this.fillSyncInFlight = null;
    this.fillTradeMaterializerInFlight = null;
    this.fillSyncLastWarningAt = 0;
    this.walletSyncInterval = null;
    this.walletSyncInFlight = null;
    this.walletSyncLastWarningAt = 0;
    this.historicalEntryFillLookupLogged = new Set();
  }

  async start() {
    assertDeltaTestnetConfiguration(this.env);
    if (!this.stopped) return;
    this.stopped = false;
    // Global REST reconciliation is owned by DeltaPositionReconciler.
    // This tracker only processes WebSocket events and event-triggered symbol refreshes.
    this.connect();
    if (typeof this.executor.getFillsPage === 'function') {
      void this.syncRecentFills().catch(error =>
        this.logSocketWarning('Delta Testnet fill backfill failed; checkpoint retained', {
          error: String(error?.message || error).slice(0, 200)
        }, 'WARN')
      );
      this.fillSyncInterval = setInterval(() => {
        void this.syncRecentFills().catch(error =>
          this.logSocketWarning('Delta Testnet fill backfill failed; checkpoint retained', {
            error: String(error?.message || error).slice(0, 200)
          }, 'WARN')
        );
      }, 60_000);
      this.fillSyncInterval.unref?.();
    }

    if (typeof this.executor.getWalletTransactionsPage === 'function') {
      void this.syncRecentWalletTransactions().catch(error =>
        this.logSocketWarning('Delta Testnet wallet transaction backfill failed; checkpoint retained', {
          error: String(error?.message || error).slice(0, 200)
        }, 'WARN')
      );
      this.walletSyncInterval = setInterval(() => {
        void this.syncRecentWalletTransactions().catch(error =>
          this.logSocketWarning('Delta Testnet wallet transaction backfill failed; checkpoint retained', {
            error: String(error?.message || error).slice(0, 200)
          }, 'WARN')
        );
      }, 60_000);
      this.walletSyncInterval.unref?.();
    }
  }

  async logSocketWarning(message, data = {}, level = 'WARN') {
    const now = Date.now();
    if (!shouldEmitThrottledLog(this.lastSocketWarningAt, now, WS_ERROR_LOG_COOLDOWN_MS)) return;
    this.lastSocketWarningAt = now;
    await this.database.log(level, message, data).catch(() => {});
  }

  async logHistoricalEntryFillUnresolvedOnce({
    positionId,
    symbol,
    clientOrderId,
    openedMs,
    orderNotFound = false
  } = {}) {
    const identity = stringValue(positionId) || stringValue(clientOrderId) ||
      (Number.isFinite(openedMs) ? String(openedMs) : 'unknown');
    const key = stringValue(symbol).toUpperCase() + ':' + identity;
    if (this.historicalEntryFillLookupLogged.has(key)) return;

    // A bounded process-local cache prevents a repeated INFO record on every
    // closed-trade materialization cycle without persisting reconciliation state.
    if (this.historicalEntryFillLookupLogged.size >= 1024) {
      const oldestKey = this.historicalEntryFillLookupLogged.values().next().value;
      if (oldestKey !== undefined) this.historicalEntryFillLookupLogged.delete(oldestKey);
    }
    this.historicalEntryFillLookupLogged.add(key);

    if (typeof this.database.log !== 'function') return;
    await this.database.log(
      orderNotFound ? 'INFO' : 'DEBUG',
      orderNotFound
        ? '[Tracker] Historical entry order not found; fill identity remains UNRESOLVED'
        : '[Tracker] Historical entry fill identity remains UNRESOLVED; client-order lookup skipped after 3 days',
      {
        symbol: stringValue(symbol).toUpperCase(),
        positionId: positionId ?? null,
        hasClientOrderId: Boolean(stringValue(clientOrderId)),
        fillResolution: 'UNRESOLVED',
        clientOrderLookupSkipped: !orderNotFound,
        reason: orderNotFound ? 'order_not_found' : 'older_than_3_days',
        ...(Number.isFinite(openedMs)
          ? { lookupAgeMs: Math.max(0, Date.now() - openedMs) }
          : {})
      }
    ).catch(() => {});
  }

  clearAuthTimeout() {
    if (this.authTimeoutTimer) clearTimeout(this.authTimeoutTimer);
    this.authTimeoutTimer = null;
  }

  connect() {
    if (this.stopped || this.socket || this.reconnectTimer) return;
    const configuredUrl = stringValue(this.env.DELTA_TESTNET_WS_URL || DELTA_TESTNET_PRIVATE_WS_URL);
    if (configuredUrl !== DELTA_TESTNET_PRIVATE_WS_URL) {
      void this.database.log('ERROR', 'Delta Testnet private tracker refused an unapproved WebSocket URL', {});
      return;
    }
    let socket;
    try {
      socket = new this.WebSocketImpl(DELTA_TESTNET_PRIVATE_WS_URL);
    } catch (error) {
      void this.logSocketWarning('Delta Testnet WebSocket construction failed; reconnect scheduled', {
        error: String(error?.message || error).slice(0, 200)
      }, 'DEBUG');
      this.scheduleReconnect({ rateLimited: /429|rate.?limit|too many/i.test(String(error?.message || error)) });
      return;
    }
    this.socket = socket;
    this.authenticated = false;
    let openedAt = 0;

    socket.on('open', () => {
      openedAt = Date.now();
      try {
        const credentials = assertDeltaTestnetConfiguration(this.env);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = deltaHmacSha256(credentials.apiSecret, 'GET' + timestamp + '/live');
        socket.send(JSON.stringify({
          type: 'key-auth',
          payload: {
            'api-key': credentials.apiKey,
            signature,
            timestamp: Number(timestamp)
          }
        }));
        this.clearAuthTimeout();
        this.authTimeoutTimer = setTimeout(() => {
          if (this.stopped || this.socket !== socket || this.authenticated) return;
          void this.logSocketWarning('Delta Testnet WebSocket auth timed out; reconnect scheduled', {
            timeoutMs: 10_000,
            endpoint: 'Delta India Testnet private WebSocket'
          }, 'DEBUG');
          this.socket = null;
          this.authenticated = false;
          this.scheduleReconnect();
          cleanupWebSocketListeners(socket);
          try { socket.terminate?.(); } catch {}
          try { socket.close(); } catch {}
        }, 10_000);
        this.authTimeoutTimer.unref?.();
      } catch (error) {
        void this.logSocketWarning('Delta Testnet WebSocket authentication setup failed', {
          error: String(error?.message || error).slice(0, 200)
        });
        if (this.socket === socket) this.socket = null;
        this.authenticated = false;
        this.clearAuthTimeout();
        this.scheduleReconnect();
        cleanupWebSocketListeners(socket);
        try { socket.terminate?.(); } catch {}
        try { socket.close(); } catch {}
      }
    });

    socket.on('message', raw => {
      void this.handleMessage(raw).catch(error =>
        this.database.log('ERROR', 'Delta Testnet private event processing failed', {
          error: String(error?.message || error)
        }).catch(() => {})
      );
    });

    socket.on('error', error => {
      const message = String(error?.message || error);
      const wasCurrent = this.socket === socket;
      const rateLimited = /429|rate.?limit|too many connections|unexpected server response: 429/i.test(message);
      void this.logSocketWarning('Delta Testnet WebSocket error; reconnect scheduled', {
        error: message.slice(0, 200),
        rateLimited,
        retryPolicy: rateLimited ? 'cooldown' : 'exponential'
      }, rateLimited ? 'WARN' : 'DEBUG');
      if (wasCurrent) {
        this.socket = null;
        this.authenticated = false;
        this.clearAuthTimeout();
        this.scheduleReconnect({ rateLimited });
      }
      cleanupWebSocketListeners(socket);
      try { socket.terminate?.(); } catch {}
      try { socket.close(); } catch {}
    });

    socket.on('close', (code, reasonBuffer) => {
      const wasCurrent = this.socket === socket;
      if (wasCurrent) {
        this.socket = null;
        this.authenticated = false;
        this.clearAuthTimeout();
      }
      const uptimeMs = openedAt > 0 ? Date.now() - openedAt : 0;
      if (wasCurrent && uptimeMs >= 60_000) this.retryCount = 0;
      const reason = reasonBuffer ? reasonBuffer.toString().slice(0, 120) : '';
      if (wasCurrent && !this.stopped) {
        const rateLimited = Number(code) === 429 || /429|rate.?limit|too many/i.test(reason);
        void this.logSocketWarning('Delta Testnet private WebSocket disconnected; reconnect scheduled', {
          code: Number(code) || null,
          reason,
          uptimeMs,
          rateLimited,
          retryPolicy: rateLimited ? 'cooldown' : 'exponential'
        }, 'DEBUG');
        this.scheduleReconnect({ rateLimited });
      }
      cleanupWebSocketListeners(socket);
    });
  }

  scheduleReconnect({ rateLimited = false } = {}) {
    if (this.stopped || this.socket || this.reconnectTimer) return;
    const delay = websocketReconnectDelay(this.retryCount, {
      baseMs: this.reconnectMs,
      rateLimited
    });
    this.retryCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async handleMessage(raw) {
    let message;
    try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
    catch { return; }
    if (message?.type === 'key-auth') {
      if (message.success !== true) {
        await this.logSocketWarning('Delta Testnet private WebSocket authentication was rejected', {
          status: message.status || null,
          statusCode: message.status_code || null,
          message: String(message.message || '').slice(0, 160)
        });
        this.clearAuthTimeout();
        const socket = this.socket;
        this.socket = null;
        this.authenticated = false;
        this.scheduleReconnect({
          rateLimited: Number(message.status_code) === 429 || /429|rate.?limit/i.test(String(message.status || ''))
        });
        cleanupWebSocketListeners(socket);
        try { socket?.terminate?.(); } catch {}
        try { socket?.close(); } catch {}
        return;
      }
      this.clearAuthTimeout();
      const socket = this.socket;
      if (!socket) return;
      try {
        socket.send(JSON.stringify({ type: 'enable_heartbeat' }));
        socket.send(JSON.stringify({
          type: 'subscribe',
          payload: { channels: [{ name: 'orders', symbols: ['all'] }] }
        }));
        socket.send(JSON.stringify({
          type: 'subscribe',
          payload: { channels: [{ name: 'positions', symbols: ['all'] }] }
        }));
        // user_trades includes fill IDs, order IDs, timestamps and commission.
        // The REST fills backfill below is the recovery path for socket gaps.
        socket.send(JSON.stringify({
          type: 'subscribe',
          payload: { channels: [{ name: 'user_trades', symbols: ['all'] }] }
        }));
        this.authenticated = true;
        await this.database.log('INFO', 'Delta Testnet private WebSocket authenticated; orders, positions and user_trades subscribed', {});
      } catch (error) {
        const messageText = String(error?.message || error);
        await this.logSocketWarning('Delta Testnet private WebSocket subscription failed; reconnect scheduled', {
          error: messageText.slice(0, 240),
          stack: String(error?.stack || '').slice(0, 3000)
        }, 'WARN');
        if (this.socket === socket) this.socket = null;
        this.authenticated = false;
        this.clearAuthTimeout();
        this.scheduleReconnect({ rateLimited: /429|rate.?limit|too many/i.test(messageText) });
        cleanupWebSocketListeners(socket);
        try { socket.terminate?.(); } catch {}
        try { socket.close(); } catch {}
      }
      return;
    }
    const channel = stringValue(message?.type || message?.channel).toLowerCase();
    if (channel === 'positions') {
      for (const row of rowsFromMessage(message)) await this.processPosition(row, message);
      return;
    }
    if (channel === 'orders') {
      for (const row of rowsFromMessage(message)) await this.processOrder(row);
      return;
    }
    if (channel === 'user_trades') {
      for (const row of rowsFromMessage(message)) await this.processFill(row, 'websocket');
    }
  }


  async processFill(rawFill, source = 'websocket') {
    const row = normalizeDeltaFill(rawFill, source);
    if (!row) {
      await this.logSocketWarning('Delta Testnet fill event was malformed and skipped', {
        source, hasFillId: Boolean(rawFill?.fill_id ?? rawFill?.id),
        hasSymbol: Boolean(rawFill?.product_symbol || rawFill?.product?.symbol || rawFill?.symbol)
      }, 'WARN');
      return false;
    }
    if (typeof this.database.upsert === 'function') {
      await this.database.upsert('dd_fills', row, 'id');
    } else if (typeof this.database.upsertMany === 'function') {
      await this.database.upsertMany('dd_fills', [row], 'id');
    } else {
      throw new Error('Database fill upsert is unavailable; fill was not acknowledged');
    }
    return true;
  }

  async saveFillSyncState(patch) {
    const next = { id: 1, ...patch, updated_at: nowIso() };
    if (typeof this.database.upsert !== 'function') {
      throw new Error('Database fill-sync checkpoint upsert is unavailable');
    }
    await this.database.upsert('dd_delta_fill_sync_state', next, 'id');
    return next;
  }

  async syncRecentFills() {
    if (this.stopped || typeof this.executor.getFillsPage !== 'function') return null;
    if (this.fillSyncInFlight) return this.fillSyncInFlight;
    const operation = (async () => {
      const stateRows = await this.database.select('dd_delta_fill_sync_state', 'id=eq.1&limit=1');
      const state = Array.isArray(stateRows) ? stateRows[0] || {} : {};
      const nowUs = Math.floor(Date.now() * 1000);
      let windowStartUs = numberOrNull(state.window_start_us);
      let windowEndUs = numberOrNull(state.window_end_us);
      let after = stringValue(state.after_cursor) || null;
      if (!(windowStartUs > 0 && windowEndUs > windowStartUs)) {
        const lastSyncedUs = numberOrNull(state.last_synced_through_us);
        const overlapUs = 5 * 60 * 1_000_000;
        windowStartUs = lastSyncedUs > 0
          ? Math.max(1, lastSyncedUs - overlapUs)
          : nowUs - 7 * 24 * 60 * 60 * 1_000_000;
        windowEndUs = nowUs;
        after = null;
        await this.saveFillSyncState({
          last_synced_through_us: lastSyncedUs || null,
          window_start_us: windowStartUs,
          window_end_us: windowEndUs,
          after_cursor: null,
          last_success_at: state.last_success_at || null,
          last_error: null,
          rows_ingested: numberOrNull(state.rows_ingested) ?? 0
        });
      }

      let pageCount = 0;
      let ingestedCount = 0;
      let completed = false;
      const pageSize = 50;
      const maxPagesPerCycle = 5;
      let savedState = state;
      while (!this.stopped && pageCount < maxPagesPerCycle) {
        const requestedCursor = after;
        const page = await this.executor.getFillsPage({
          startTime: windowStartUs,
          endTime: windowEndUs,
          after: requestedCursor,
          pageSize
        });
        if (!page || !Array.isArray(page.rows)) {
          throw new Error('Delta Testnet fill page was not an array');
        }
        const normalized = page.rows
          .map(fill => normalizeDeltaFill(fill, 'rest'))
          .filter(Boolean);
        if (normalized.length) {
          if (typeof this.database.upsertMany === 'function') {
            await this.database.upsertMany('dd_fills', normalized, 'id');
          } else {
            for (const fill of normalized) await this.processFill(fill, 'rest');
          }
        }
        ingestedCount += normalized.length;
        pageCount += 1;
        const nextCursor = stringValue(page.after) || null;
        if (nextCursor && nextCursor === requestedCursor) {
          throw new Error('Delta Testnet fill pagination cursor repeated; checkpoint was not advanced');
        }
        if (nextCursor) {
          after = nextCursor;
          savedState = await this.saveFillSyncState({
            last_synced_through_us: numberOrNull(state.last_synced_through_us) || null,
            window_start_us: windowStartUs,
            window_end_us: windowEndUs,
            after_cursor: after,
            last_success_at: nowIso(),
            last_error: null,
            rows_ingested: (numberOrNull(state.rows_ingested) ?? 0) + ingestedCount
          });
          continue;
        }
        completed = true;
        savedState = await this.saveFillSyncState({
          last_synced_through_us: windowEndUs,
          window_start_us: null,
          window_end_us: null,
          after_cursor: null,
          last_success_at: nowIso(),
          last_error: null,
          rows_ingested: (numberOrNull(state.rows_ingested) ?? 0) + ingestedCount
        });
        break;
      }

      if (completed) {
        await this.materializeVerifiedClosedTrades();
      }
      if (pageCount && (ingestedCount || completed)) {
        await this.database.log('INFO', 'Delta Testnet fill history sync completed a page batch', {
          pages: pageCount,
          fillsUpserted: ingestedCount,
          completedWindow: completed,
          rowsIngestedTotal: numberOrNull(savedState.rows_ingested) ?? ingestedCount,
          source: 'authenticated REST /v2/fills'
        }).catch(() => {});
      }
      return {
        pages: pageCount,
        fillsUpserted: ingestedCount,
        completedWindow: completed,
        lastSyncedThroughUs: numberOrNull(savedState.last_synced_through_us) ?? null
      };
    })();

    this.fillSyncInFlight = operation;
    try {
      return await operation;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      const previous = await this.database.select('dd_delta_fill_sync_state', 'id=eq.1&limit=1').catch(() => []);
      const state = Array.isArray(previous) ? previous[0] || {} : {};
      await this.saveFillSyncState({
        last_synced_through_us: numberOrNull(state.last_synced_through_us) || null,
        window_start_us: numberOrNull(state.window_start_us) || null,
        window_end_us: numberOrNull(state.window_end_us) || null,
        after_cursor: stringValue(state.after_cursor) || null,
        last_success_at: state.last_success_at || null,
        last_error: message,
        rows_ingested: numberOrNull(state.rows_ingested) ?? 0
      }).catch(() => {});
      if (!shouldEmitThrottledLog(this.fillSyncLastWarningAt, Date.now(), 60_000)) throw error;
      this.fillSyncLastWarningAt = Date.now();
      throw error;
    } finally {
      if (this.fillSyncInFlight === operation) this.fillSyncInFlight = null;
    }
  }

  async saveWalletSyncState(patch) {
    const next = { id: 1, ...patch, updated_at: nowIso() };
    if (typeof this.database.upsert !== 'function') {
      throw new Error('Database wallet transaction checkpoint upsert is unavailable');
    }
    await this.database.upsert('dd_wallet_transaction_sync_state', next, 'id');
    return next;
  }

  async syncRecentWalletTransactions() {
    if (this.stopped || typeof this.executor.getWalletTransactionsPage !== 'function') return null;
    if (this.walletSyncInFlight) return this.walletSyncInFlight;
    const operation = (async () => {
      const stateRows = await this.database.select('dd_wallet_transaction_sync_state', 'id=eq.1&limit=1');
      const state = Array.isArray(stateRows) ? stateRows[0] || {} : {};
      const nowUs = Math.floor(Date.now() * 1000);
      let windowStartUs = numberOrNull(state.window_start_us);
      let windowEndUs = numberOrNull(state.window_end_us);
      let historyStartUs = numberOrNull(state.history_start_us);
      let after = stringValue(state.after_cursor) || null;
      if (!(windowStartUs > 0 && windowEndUs > windowStartUs)) {
        const lastSyncedUs = numberOrNull(state.last_synced_through_us);
        const overlapUs = 5 * 60 * 1_000_000;
        windowStartUs = lastSyncedUs > 0
          ? Math.max(1, lastSyncedUs - overlapUs)
          : nowUs - 90 * 24 * 60 * 60 * 1_000_000;
        windowEndUs = nowUs;
        historyStartUs = historyStartUs === null
          ? windowStartUs : Math.min(historyStartUs, windowStartUs);
        after = null;
        await this.saveWalletSyncState({
          last_synced_through_us: lastSyncedUs || null,
          history_start_us: historyStartUs,
          window_start_us: windowStartUs,
          window_end_us: windowEndUs,
          after_cursor: null,
          last_success_at: state.last_success_at || null,
          last_error: null,
          rows_ingested: numberOrNull(state.rows_ingested) ?? 0
        });
      } else if (historyStartUs === null) {
        // Resume an in-progress legacy checkpoint conservatively from the
        // beginning of its currently stored window.
        historyStartUs = windowStartUs;
      }

      let pageCount = 0;
      let ingestedCount = 0;
      let completed = false;
      const pageSize = 200;
      const maxPagesPerCycle = 5;
      let savedState = state;
      while (!this.stopped && pageCount < maxPagesPerCycle) {
        const requestedCursor = after;
        const page = await this.executor.getWalletTransactionsPage({
          startTime: windowStartUs,
          endTime: windowEndUs,
          after: requestedCursor,
          pageSize
        });
        if (!page || !Array.isArray(page.rows)) {
          throw new Error('Delta Testnet wallet transaction page was not an array');
        }
        const normalized = page.rows
          .map(row => normalizeDeltaWalletTransaction(row, 'rest'))
          .filter(Boolean);
        if (normalized.length) {
          if (typeof this.database.upsertMany === 'function') {
            await this.database.upsertMany('dd_wallet_transactions', normalized, 'id');
          } else if (typeof this.database.upsert === 'function') {
            for (const row of normalized) await this.database.upsert('dd_wallet_transactions', row, 'id');
          } else {
            throw new Error('Database wallet transaction upsert is unavailable');
          }
        }
        ingestedCount += normalized.length;
        pageCount += 1;
        const nextCursor = stringValue(page.after) || null;
        if (nextCursor && nextCursor === requestedCursor) {
          throw new Error('Delta Testnet wallet transaction pagination cursor repeated; checkpoint was not advanced');
        }
        if (nextCursor) {
          after = nextCursor;
          savedState = await this.saveWalletSyncState({
            last_synced_through_us: numberOrNull(state.last_synced_through_us) || null,
            history_start_us: historyStartUs,
            window_start_us: windowStartUs,
            window_end_us: windowEndUs,
            after_cursor: after,
            last_success_at: nowIso(),
            last_error: null,
            rows_ingested: (numberOrNull(state.rows_ingested) ?? 0) + ingestedCount
          });
          continue;
        }
        completed = true;
        savedState = await this.saveWalletSyncState({
          last_synced_through_us: windowEndUs,
          history_start_us: historyStartUs,
          window_start_us: null,
          window_end_us: null,
          after_cursor: null,
          last_success_at: nowIso(),
          last_error: null,
          rows_ingested: (numberOrNull(state.rows_ingested) ?? 0) + ingestedCount
        });
        break;
      }

      if (completed) await this.materializeVerifiedClosedTrades();
      if (pageCount && (ingestedCount || completed)) {
        await this.database.log('INFO', 'Delta Testnet wallet transaction history sync completed a page batch', {
          pages: pageCount,
          transactionsUpserted: ingestedCount,
          completedWindow: completed,
          rowsIngestedTotal: numberOrNull(savedState.rows_ingested) ?? ingestedCount,
          source: 'authenticated REST /v2/wallet/transactions'
        }).catch(() => {});
      }
      return {
        pages: pageCount,
        transactionsUpserted: ingestedCount,
        completedWindow: completed,
        lastSyncedThroughUs: numberOrNull(savedState.last_synced_through_us) ?? null
      };
    })();

    this.walletSyncInFlight = operation;
    try {
      return await operation;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      const previous = await this.database.select('dd_wallet_transaction_sync_state', 'id=eq.1&limit=1').catch(() => []);
      const state = Array.isArray(previous) ? previous[0] || {} : {};
      await this.saveWalletSyncState({
        last_synced_through_us: numberOrNull(state.last_synced_through_us) || null,
        window_start_us: numberOrNull(state.window_start_us) || null,
        window_end_us: numberOrNull(state.window_end_us) || null,
        after_cursor: stringValue(state.after_cursor) || null,
        last_success_at: state.last_success_at || null,
        last_error: message,
        rows_ingested: numberOrNull(state.rows_ingested) ?? 0
      }).catch(() => {});
      if (!shouldEmitThrottledLog(this.walletSyncLastWarningAt, Date.now(), 60_000)) throw error;
      this.walletSyncLastWarningAt = Date.now();
      throw error;
    } finally {
      if (this.walletSyncInFlight === operation) this.walletSyncInFlight = null;
    }
  }

  async materializeVerifiedClosedTrades() {
    if (this.stopped || this.fillTradeMaterializerInFlight ||
        typeof this.database.select !== 'function' || typeof this.database.upsertMany !== 'function') {
      return null;
    }
    const operation = (async () => {
      const closedRows = await this.database.select(
        'dd_delta_positions',
        'status=in.(CLOSED,CLOSED_EXTERNALLY)&closed_at=not.is.null&order=closed_at.desc&limit=1000'
      );
      if (!Array.isArray(closedRows) || !closedRows.length) return { materialized: 0 };
      const walletSyncRows = await this.database.select(
        'dd_wallet_transaction_sync_state',
        'id=eq.1&limit=1'
      ).catch(() => []);
      const walletSyncState = Array.isArray(walletSyncRows) ? walletSyncRows[0] || {} : {};
      const walletSyncComplete = !walletSyncState.window_start_us &&
        !walletSyncState.window_end_us && !walletSyncState.after_cursor &&
        numberOrNull(walletSyncState.last_synced_through_us) !== null &&
        numberOrNull(walletSyncState.history_start_us) !== null;
      const trades = [];
      for (const position of closedRows) {
        const symbol = stringValue(position?.symbol).toUpperCase();
        const side = stringValue(position?.side).toUpperCase();
        const strategy = stringValue(position?.strategy).toUpperCase();
        const explicitEntryOrderId = stringValue(position?.entry_order_id);
        const orderId = explicitEntryOrderId || stringValue(position?.order_id);
        const entryClientOrderId = stringValue(position?.client_order_id);
        const qty = numberOrNull(position?.qty);
        let realizedPnl = numberOrNull(position?.realized_pnl);
        let realizedPnlVerified = position?.realized_pnl_verified === true && realizedPnl !== null;
        let exitReason = deltaCloseFields({}, {
          exit_reason: position?.exit_reason,
          requested_exit_reason: position?.requested_exit_reason,
          close_order_id: position?.close_order_id
        }).exit_reason;
        const openedMs = Date.parse(position?.opened_at || '');
        const closedMs = Date.parse(position?.closed_at || '');
        if (!position?.id || !symbol || !['BUY', 'SELL'].includes(side) ||
            !['MOMENTUM', 'SCALPING'].includes(strategy) || !(orderId || entryClientOrderId) ||
            !(qty > 0) ||
            !Number.isFinite(openedMs) || !Number.isFinite(closedMs) || closedMs < openedMs) {
          continue;
        }
        const from = new Date(Math.max(0, openedMs - 5_000)).toISOString();
        const to = new Date(closedMs + 5_000).toISOString();
        const fills = await this.database.select(
          'dd_fills',
          'symbol=eq.' + encodeURIComponent(symbol) +
          '&and=' + encodeURIComponent('(created_at.gte.' + from + ',created_at.lte.' + to + ')') +
          '&order=created_at.asc&limit=1000'
        );
        if (!Array.isArray(fills) || !fills.length) continue;
        const validEntryFill = fill =>
          String(fill?.side || '').toUpperCase() === side &&
          Date.parse(fill?.created_at || '') >= openedMs - 5_000 &&
          Date.parse(fill?.created_at || '') <= closedMs + 5_000;
        const entryFillsByExplicitOrderId = explicitEntryOrderId
          ? fills.filter(fill => String(fill?.order_id ?? '') === explicitEntryOrderId && validEntryFill(fill))
          : [];
        const entryFillsByClientOrderId = entryClientOrderId
          ? fills.filter(fill => String(fill?.client_order_id ?? '') === entryClientOrderId && validEntryFill(fill))
          : [];
        let resolvedEntryOrderId = '';
        let entryFillsByClientOrderLookup = [];

        // REST fill rows can omit client_order_id even though the position
        // retains it. Resolve the exchange order through Delta's client-ID
        // endpoint, then match the local fill ledger by the returned order ID.
        const entryLookupAgeMs = Date.now() - openedMs;
        const historicalEntryLookupSkipped =
          entryLookupAgeMs > DELTA_ENTRY_ORDER_LOOKUP_MAX_AGE_MS;
        if (!explicitEntryOrderId && !entryFillsByClientOrderId.length &&
            entryClientOrderId && typeof this.executor.getOrderByClientOrderId === 'function') {
          if (historicalEntryLookupSkipped) {
            await this.logHistoricalEntryFillUnresolvedOnce({
              positionId: position.id,
              symbol,
              clientOrderId: entryClientOrderId,
              openedMs
            });
          } else {
            try {
              const entryOrder = await this.executor.getOrderByClientOrderId(entryClientOrderId);
              const lookupProductId = numberOrNull(entryOrder?.product_id);
              const lookupSymbol = stringValue(entryOrder?.product_symbol || entryOrder?.symbol).toUpperCase();
              const lookupSide = stringValue(entryOrder?.side).toUpperCase();
              const lookupClientOrderId = stringValue(entryOrder?.client_order_id);
              const localProductId = numberOrNull(
                fills.find(fill => numberOrNull(fill?.product_id) !== null)?.product_id
              );
              const lookupContextMatches =
                (lookupProductId === null || localProductId === null || lookupProductId === localProductId) &&
                (!lookupSymbol || lookupSymbol === symbol) &&
                (!lookupSide || lookupSide === side) &&
                (!lookupClientOrderId || lookupClientOrderId === entryClientOrderId);

              if (lookupContextMatches && entryOrder?.id !== null && entryOrder?.id !== undefined) {
                resolvedEntryOrderId = String(entryOrder.id);
                entryFillsByClientOrderLookup = fills.filter(fill =>
                  String(fill?.order_id ?? '') === resolvedEntryOrderId && validEntryFill(fill)
                );
                if (entryFillsByClientOrderLookup.length) {
                  if (typeof this.database.update === 'function') {
                    await this.database.update(
                      'dd_delta_positions',
                      'id=eq.' + encodeURIComponent(String(position.id)) + '&entry_order_id=is.null',
                      { entry_order_id: resolvedEntryOrderId, updated_at: nowIso() }
                    );
                  }
                  position.entry_order_id = resolvedEntryOrderId;
                  if (typeof this.database.log === 'function') {
                    await this.database.log('INFO', '[Tracker] Recovered missing entry order ID from client order ID', {
                      symbol,
                      positionId: position.id,
                      entryOrderId: resolvedEntryOrderId,
                      matchedFillCount: entryFillsByClientOrderLookup.length
                    }).catch(() => {});
                  }
                }
              }
            } catch (error) {
              const errorMessage = String(error?.message || error);
              const errorCode = stringValue(error?.code).toLowerCase();
              const isOrderNotFound =
                errorCode === 'order_not_found' || /\border_not_found\b/i.test(errorMessage);
              const historicalOrderNotFound =
                isOrderNotFound && Date.now() - openedMs > DELTA_ENTRY_ORDER_LOOKUP_MAX_AGE_MS;
              if (historicalOrderNotFound) {
                await this.logHistoricalEntryFillUnresolvedOnce({
                  positionId: position.id,
                  symbol,
                  clientOrderId: entryClientOrderId,
                  openedMs,
                  orderNotFound: true
                });
              } else {
                await this.logSocketWarning('Delta entry fill backfill lookup by client order ID failed; P&L remains unverified', {
                  symbol,
                  positionId: position.id,
                  hasClientOrderId: true,
                  error: errorMessage.slice(0, 200)
                }, 'WARN');
              }
            }
          }
        }

        const entryFillsByLegacyOrderId = orderId
          ? fills.filter(fill => String(fill?.order_id ?? '') === orderId && validEntryFill(fill))
          : [];
        // The generic order_id field can be replaced by bracket metadata.
        // Prefer dedicated entry ID, exact client ID, resolved client-ID lookup,
        // and only then use the legacy generic order_id.
        const entryFills = entryFillsByExplicitOrderId.length
          ? entryFillsByExplicitOrderId
          : entryFillsByClientOrderId.length
            ? entryFillsByClientOrderId
            : entryFillsByClientOrderLookup.length
              ? entryFillsByClientOrderLookup
              : entryFillsByLegacyOrderId;
        const entry = weightedFillAverage(entryFills);
        if (!entry || !(entry.size > 0)) continue;
        const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
        const entryLastMs = Math.max(...entryFills.map(fill => Date.parse(fill.created_at || '')));
        const matchedEntryOrderIds = new Set(entryFills
          .map(fill => stringValue(fill?.order_id))
          .filter(Boolean));
        const exitFills = fills.filter(fill => {
          const fillMs = Date.parse(fill?.created_at || '');
          const fillOrderId = stringValue(fill?.order_id);
          return String(fill?.side || '').toUpperCase() === exitSide &&
            (!fillOrderId || !matchedEntryOrderIds.has(fillOrderId)) &&
            Number.isFinite(fillMs) && fillMs >= entryLastMs && fillMs <= closedMs + 5_000 &&
            numberOrNull(fill?.size) > 0 && numberOrNull(fill?.price) > 0;
        });
        const exit = weightedFillAverage(exitFills);
        if (!exit || Math.abs(exit.size - entry.size) > Math.max(1e-8, entry.size * 1e-8)) continue;

        // Backfill realized P&L from Delta's persisted raw flat-position fill.
        const flatCloseFills = exitFills.filter(fill => {
          const raw = fill?.raw && typeof fill.raw === 'object' ? fill.raw : {};
          const next = raw?.meta_data?.new_position ?? raw?.metadata?.new_position;
          return numberOrNull(next?.size) === 0;
        }).sort((a, b) => Date.parse(a?.created_at || '') - Date.parse(b?.created_at || ''));
        const flatCloseFill = flatCloseFills[flatCloseFills.length - 1] || null;
        const rawClose = flatCloseFill?.raw && typeof flatCloseFill.raw === 'object' ? flatCloseFill.raw : {};
        const nextPosition = rawClose?.meta_data?.new_position ?? rawClose?.metadata?.new_position ?? {};
        const fillRealizedPnl = numberOrNull(nextPosition.realized_pnl ?? rawClose.realized_pnl);
        if (fillRealizedPnl !== null && !realizedPnlVerified && typeof this.database.update === 'function') {
          const fillReason = deltaCloseFields({}, {
            ...rawClose,
            requested_exit_reason: position?.requested_exit_reason,
            close_order_id: flatCloseFill?.order_id ?? null
          }).exit_reason;
          const patch = {
            realized_pnl: fillRealizedPnl,
            realized_pnl_verified: true,
            close_source: position.close_source || 'rest_fill_ledger',
            updated_at: nowIso()
          };
          if (flatCloseFill?.order_id != null) patch.close_order_id = String(flatCloseFill.order_id);
          if (fillReason !== 'UNKNOWN') patch.exit_reason = fillReason;
          await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(String(position.id)), patch);
          Object.assign(position, patch);
          realizedPnl = fillRealizedPnl;
          realizedPnlVerified = true;
          if (fillReason !== 'UNKNOWN') exitReason = fillReason;
        }
        if ((!realizedPnlVerified || exitReason === 'UNKNOWN') &&
            typeof this.executor.getRecentCloseDetails === 'function' &&
            typeof this.database.update === 'function') {
          try {
            const details = await this.executor.getRecentCloseDetails(symbol, position.opened_at, position);
            if (details?.close_fill_history_complete === true) {
              const close = deltaCloseFields({}, details);
              const patch = { updated_at: nowIso() };
              if (close.exit_price !== null) patch.exit_price = close.exit_price;
              if (close.fees !== null) patch.fees = close.fees;
              if (close.fee_currency) patch.fee_currency = close.fee_currency;
              if (close.close_order_id) patch.close_order_id = close.close_order_id;
              if (close.exit_reason !== 'UNKNOWN') patch.exit_reason = close.exit_reason;
              if (close.realized_pnl !== null) {
                patch.realized_pnl = close.realized_pnl;
                patch.realized_pnl_verified = true;
                patch.close_source = position.close_source || 'rest_fill_backfill';
              }
              if (Object.keys(patch).length > 1) {
                await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(String(position.id)), patch);
                Object.assign(position, patch);
                if (close.realized_pnl !== null) { realizedPnl = close.realized_pnl; realizedPnlVerified = true; }
                if (close.exit_reason !== 'UNKNOWN') exitReason = close.exit_reason;
              }
            }
          } catch (error) {
            await this.logSocketWarning('Historical Delta close-fill backfill failed; P&L remains unverified', {
              symbol, positionId: position.id, error: String(error?.message || error).slice(0, 200)
            }, 'WARN');
          }
        }

        // One completed Delta net-position lifecycle is one trade. Partial fill
        // rows are components of this position and must never create separate trades.
        const tradeQty = entry.size;
        const allMatchedFills = [...entryFills, ...exitFills];
        const commissionCurrencies = [...new Set(allMatchedFills
          .map(fill => stringValue(fill?.commission_currency ?? fill?.raw?.settling_asset_symbol).toUpperCase())
          .filter(Boolean))];
        const commissionsComplete = allMatchedFills.every(fill =>
          numberOrNull(fill?.commission) !== null &&
          stringValue(fill?.commission_currency ?? fill?.raw?.settling_asset_symbol) !== ''
        ) && commissionCurrencies.length === 1;
        const fillCommissionTotal = commissionsComplete
          ? allMatchedFills.reduce((sum, fill) => sum + numberOrNull(fill.commission), 0)
          : null;

        const productRows = await this.database.select(
          'dd_market_cache',
          'symbol=eq.' + encodeURIComponent(symbol) + '&select=symbol,product_id,contract_value,notional_type&limit=1'
        ).catch(() => []);
        const product = Array.isArray(productRows) ? productRows[0] || null : null;
        const productId = numberOrNull(position.product_id ?? product?.product_id ??
          allMatchedFills.find(fill => numberOrNull(fill?.product_id) !== null)?.product_id);
        const contractValue = numberOrNull(product?.contract_value);
        const vanilla = String(product?.notional_type || '').toLowerCase() === 'vanilla';
        const entryNotional = vanilla && contractValue > 0 ? entry.price * tradeQty * contractValue : null;
        const exitNotional = vanilla && contractValue > 0 ? exit.price * tradeQty * contractValue : null;

        const walletFrom = new Date(openedMs).toISOString();
        const walletTo = new Date(closedMs).toISOString();
        let walletTransactions = [];
        let walletTransactionsLoaded = false;
        if (productId !== null && typeof this.database.select === 'function') {
          try {
            const selected = await this.database.select(
              'dd_wallet_transactions',
              'created_at=gte.' + encodeURIComponent(walletFrom) +
              '&created_at=lte.' + encodeURIComponent(walletTo) +
              '&order=created_at.asc&limit=2000'
            );
            if (Array.isArray(selected)) {
              walletTransactions = selected;
              walletTransactionsLoaded = true;
            }
          } catch (error) {
            await this.logSocketWarning('Delta wallet transaction lookup failed; close costs remain unverified', {
              symbol,
              positionId: position.id,
              error: String(error?.message || error).slice(0, 180)
            }, 'WARN');
          }
        }
        const walletTransactionProductId = row => numberOrNull(
          row?.product_id ?? row?.meta_data?.product_id ?? row?.raw?.product_id
        );
        const walletTransactionSymbol = row => stringValue(
          row?.meta_data?.product_symbol ?? row?.meta_data?.symbol ??
          row?.raw?.product_symbol ?? row?.raw?.symbol
        ).toUpperCase();
        const allPnlWalletRows = walletTransactions.filter(row =>
          ['commission', 'commission_rebate', 'liquidation_fee', 'funding',
            'trading_credits_paid', 'trading_fee_credits_paid_liquidation_fee',
            'trading_credits_reverted'].includes(
            stringValue(row?.transaction_type).toLowerCase()
          )
        );
        const positionWalletRows = walletTransactions.filter(row =>
          walletTransactionProductId(row) === productId ||
          (walletTransactionProductId(row) === null && walletTransactionSymbol(row) === symbol)
        );
        const pnlWalletRows = positionWalletRows.filter(row =>
          ['commission', 'commission_rebate', 'liquidation_fee', 'funding',
            'trading_credits_paid', 'trading_fee_credits_paid_liquidation_fee',
            'trading_credits_reverted'].includes(
            stringValue(row?.transaction_type).toLowerCase()
          )
        );
        const unattributedPnlWalletRows = allPnlWalletRows.filter(row =>
          walletTransactionProductId(row) === null && !walletTransactionSymbol(row)
        );
        const walletRowsAreCovered = productId !== null &&
          walletTransactionsLoaded &&
          walletSyncComplete &&
          numberOrNull(walletSyncState.history_start_us) <= openedMs * 1000 &&
          numberOrNull(walletSyncState.last_synced_through_us) >= closedMs * 1000;
        const unattributedFundingRows = unattributedPnlWalletRows.filter(row =>
          stringValue(row?.transaction_type).toLowerCase() === 'funding'
        );
        const unattributedFeeRows = unattributedPnlWalletRows.filter(row =>
          ['commission', 'commission_rebate', 'liquidation_fee',
            'trading_credits_paid', 'trading_fee_credits_paid_liquidation_fee',
            'trading_credits_reverted'].includes(stringValue(row?.transaction_type).toLowerCase())
        );
        const feeRows = pnlWalletRows.filter(row =>
          ['commission', 'commission_rebate', 'liquidation_fee'].includes(
            stringValue(row?.transaction_type).toLowerCase()
          )
        );
        const fundingRows = pnlWalletRows.filter(row =>
          stringValue(row?.transaction_type).toLowerCase() === 'funding'
        );
        const unsupportedFeeRows = pnlWalletRows.filter(row =>
          ['trading_credits_paid', 'trading_fee_credits_paid_liquidation_fee',
            'trading_credits_reverted'].includes(stringValue(row?.transaction_type).toLowerCase())
        );
        const pnlRowsHaveCurrency = pnlWalletRows.every(row => stringValue(row?.asset_symbol) !== '');
        const walletCurrencies = [...new Set(pnlWalletRows
          .map(row => stringValue(row?.asset_symbol).toUpperCase()).filter(Boolean))];
        const walletCurrencyCompatible = walletCurrencies.length <= 1 && pnlRowsHaveCurrency;
        // Wallet transaction amounts are signed: commission/liquidation fees
        // debit the wallet; rebates and funding credits remain negative/positive
        // as recorded by the exchange rather than being guessed from trade side.
        const walletFeeMovement = feeRows.reduce((sum, row) => sum + (numberOrNull(row?.amount) ?? 0), 0);
        const walletFunding = fundingRows.reduce((sum, row) => sum + (numberOrNull(row?.amount) ?? 0), 0);
        const walletCommissionRebates = feeRows
          .filter(row => stringValue(row?.transaction_type).toLowerCase() === 'commission_rebate')
          .reduce((sum, row) => sum + (numberOrNull(row?.amount) ?? 0), 0);
        const walletLiquidationFee = -feeRows
          .filter(row => stringValue(row?.transaction_type).toLowerCase() === 'liquidation_fee')
          .reduce((sum, row) => sum + (numberOrNull(row?.amount) ?? 0), 0);

        const rawCloseCommission = numberOrNull(
          nextPosition.total_commission_paid ?? rawClose?.meta_data?.total_commission_paid
        );
        const rawCloseFunding = numberOrNull(
          nextPosition.realized_funding ?? rawClose?.meta_data?.realized_funding
        );
        const feeCurrency = walletCurrencies[0] ||
          commissionCurrencies[0] ||
          stringValue(flatCloseFill?.raw?.settling_asset_symbol).toUpperCase() || null;
        const pnlCurrency = feeCurrency;
        let fees = null;
        let feesVerified = false;
        if (fillCommissionTotal !== null) {
          // Fill commissions are the primary per-fill source. Wallet rebates
          // and liquidation fees are separate signed credits/debits and must
          // be applied once, only when the full trade window is covered.
          const walletFeeAdjustmentsComplete = walletRowsAreCovered &&
            walletCurrencyCompatible && unattributedFeeRows.length === 0 &&
            unsupportedFeeRows.length === 0;
          fees = walletFeeAdjustmentsComplete
            ? fillCommissionTotal - walletCommissionRebates + walletLiquidationFee
            : fillCommissionTotal;
          feesVerified = walletFeeAdjustmentsComplete;
        } else if (walletRowsAreCovered && walletCurrencyCompatible &&
          unattributedFeeRows.length === 0 && unsupportedFeeRows.length === 0) {
          // Delta wallet amounts are signed (+ credit, - debit); the fee cost
          // is the negative of the net wallet movement for fee transaction types.
          fees = -walletFeeMovement;
          feesVerified = true;
        } else if (rawCloseCommission !== null) {
          fees = rawCloseCommission;
          feesVerified = walletRowsAreCovered && walletCurrencyCompatible &&
            unsupportedFeeRows.length === 0 && unattributedFeeRows.length === 0;
        }

        let realizedFunding = null;
        let fundingVerified = false;
        if (walletRowsAreCovered && walletCurrencyCompatible && unattributedFundingRows.length === 0) {
          realizedFunding = walletFunding;
          fundingVerified = true;
        } else if (rawCloseFunding !== null) {
          realizedFunding = rawCloseFunding;
          fundingVerified = true;
        }

        // Delta P&L Analytics' realized result is the exchange's position/fill
        // realized_pnl. Generic wallet cashflow is not a trade P&L source and
        // must never overwrite this per-position amount.
        const exchangeRealizedPnl = realizedPnlVerified ? realizedPnl : null;
        // Realized P&L, funding and fees are independent exchange ledger
        // components. Never infer realized P&L from local price arithmetic.
        const pnlComponentsCurrencyCompatible = walletCurrencyCompatible &&
          (!commissionCurrencies.length || !pnlCurrency || commissionCurrencies.every(value => value === pnlCurrency));
        const netPnl = exchangeRealizedPnl !== null && feesVerified && fundingVerified &&
          pnlComponentsCurrencyCompatible
          ? exchangeRealizedPnl + realizedFunding - fees
          : null;
        const pnlPct = netPnl !== null && entryNotional > 0 ? netPnl / entryNotional * 100 : null;
        const result = netPnl !== null
          ? netPnl > 0 ? 'WIN' : netPnl < 0 ? 'LOSS' : 'FLAT'
          : exchangeRealizedPnl !== null
            ? 'EXCHANGE P&L · COSTS UNVERIFIED'
            : 'EXCHANGE P&L UNVERIFIED';

        const accountingPatch = {
          updated_at: nowIso(),
          realized_pnl: exchangeRealizedPnl,
          realized_pnl_verified: exchangeRealizedPnl !== null,
          fees,
          fee_currency: feeCurrency,
          fees_verified: feesVerified,
          realized_funding: realizedFunding,
          funding_verified: fundingVerified,
          pnl_currency: pnlCurrency
        };
        if (typeof this.database.update === 'function') {
          await this.database.update(
            'dd_delta_positions',
            'id=eq.' + encodeURIComponent(String(position.id)),
            accountingPatch
          );
        }
        Object.assign(position, accountingPatch);

        trades.push({
          execution_id: 'delta-testnet-position:' + String(position.id),
          symbol,
          strategy,
          side,
          entry_price: entry.price,
          exit_price: exit.price,
          qty: tradeQty,
          entry_notional: entryNotional,
          exit_notional: exitNotional,
          exchange_realized_pnl: exchangeRealizedPnl,
          realized_funding: realizedFunding,
          funding_verified: fundingVerified,
          fee_currency: feeCurrency,
          pnl_currency: pnlCurrency,
          fees,
          fees_verified: feesVerified,
          gross_pnl: exchangeRealizedPnl,
          gross_pnl_verified: exchangeRealizedPnl !== null,
          net_pnl: netPnl,
          net_pnl_verified: netPnl !== null,
          pnl_pct: pnlPct,
          r_multiple: null,
          exit_reason: exitReason,
          result,
          entry_fill_ids: entry.ids,
          exit_fill_ids: exit.ids,
          opened_at: position.opened_at,
          closed_at: position.closed_at
        });
      }
      if (trades.length) {
        await this.database.upsertMany('dd_trades', trades, 'execution_id');

        // The old engine ledger keyed trades by the entry client_order_id. Once
        // the canonical Delta position lifecycle row exists, hide that legacy
        // duplicate and discard its duplicate Profit Rotation accounting event.
        for (const trade of trades) {
          const positionId = String(trade.execution_id || '').replace(/^delta-testnet-position:/, '');
          const sourcePosition = closedRows.find(row => String(row.id) === positionId);
          const legacyClientOrderId = stringValue(sourcePosition?.client_order_id);
          if (legacyClientOrderId && legacyClientOrderId !== trade.execution_id) {
            if (typeof this.database.update === 'function') {
              await this.database.update(
                'dd_trades',
                'execution_id=eq.' + encodeURIComponent(legacyClientOrderId),
                { result: 'SUPERSEDED', net_pnl: null, net_pnl_verified: false }
              ).catch(() => {});
            }
            if (typeof this.database.remove === 'function') {
              await this.database.remove(
                'dd_rotation_ledger',
                'execution_id=eq.' + encodeURIComponent(legacyClientOrderId)
              ).catch(() => {});
            }
          }
        }

        // Profit Rotation is an accounting ledger only; it never moves funds.
        // Create events only from a fill-matched trade with verified positive
        // exchange-reported net P&L. NULL/negative net results never become 0 or
        // a rotation event. execution_id is the idempotent conflict key.
        const rotationRows = trades
          .filter(trade => numberOrNull(trade?.net_pnl) > 0 && trade?.result === 'WIN')
          .map(trade => {
            const profit = Number(Number(trade.net_pnl).toFixed(10));
            const released = Number((profit * 0.9).toFixed(10));
            const retained = Number((profit - released).toFixed(10));
            const positionId = String(trade.execution_id || '').replace(/^delta-testnet-position:/, '');
            return {
              execution_id: trade.execution_id,
              trade_id: null,
              profit,
              released,
              retained,
              rotation_id: 'delta-testnet-rotation:' + positionId,
              created_at: trade.closed_at
            };
          });
        if (rotationRows.length) {
          await this.database.upsertMany('dd_rotation_ledger', rotationRows, 'execution_id');
          await this.database.log('INFO', 'Profit Rotation accounting events materialized from verified profitable closes', {
            rowsMaterialized: rotationRows.length,
            source: 'exchange realized P&L + verified funding and wallet fee ledger',
            fundsMoved: false
          }).catch(() => {});
        }
        if (typeof this.database.remove === 'function') {
          const profitableIds = new Set(rotationRows.map(row => row.execution_id));
          for (const trade of trades) {
            if (!profitableIds.has(trade.execution_id)) {
              await this.database.remove(
                'dd_rotation_ledger',
                'execution_id=eq.' + encodeURIComponent(trade.execution_id)
              ).catch(() => {});
            }
          }
        }

        await this.database.log('INFO', 'Fill-matched Delta Testnet closed trades materialized', {
          rowsMaterialized: trades.length,
          source: 'closed position snapshot + matched REST/WebSocket fill IDs',
          grossPnlDerivedOnlyWithKnownMultiplier: true,
          netPnlRequiresVerifiedPrivateClose: true,
          rMultipleEstimated: false
        }).catch(() => {});
      }
      return { materialized: trades.length };
    })();
    this.fillTradeMaterializerInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.fillTradeMaterializerInFlight === operation) this.fillTradeMaterializerInFlight = null;
    }
  }

  async findOpenRow(symbol) {
    const rows = await this.database.select(
      'dd_delta_positions',
      'symbol=eq.' + encodeURIComponent(symbol) + '&status=eq.OPEN&order=updated_at.desc&limit=1'
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async syncBracketMetadata(symbol) {
    const key = stringValue(symbol).toUpperCase();
    if (!key || this.stopped) return false;
    const existing = this.bracketMetadataSyncs.get(key);
    if (existing) return existing;

    const operation = this.syncBracketMetadataOnce(key);
    this.bracketMetadataSyncs.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.bracketMetadataSyncs.get(key) === operation) {
        this.bracketMetadataSyncs.delete(key);
      }
    }
  }

async syncBracketMetadataOnce(key) {
    const deadline = Date.now() + 30_000;
    let lastError = null;
    while (Date.now() <= deadline && !this.stopped) {
      try {
        const active = await this.findOpenRow(key);
        if (!active) return false;
        const parentOrderId = active.entry_order_id || active.order_id;
        if (parentOrderId && typeof this.executor.getOrderById === 'function') {
          try {
            const parentOrder = await this.executor.getOrderById(parentOrderId);
            const parentSl = numberOrNull(parentOrder?.bracket_stop_loss_price);
            const parentTp = numberOrNull(parentOrder?.bracket_take_profit_price);
            if (parentSl !== null && parentSl > 0 && parentTp !== null && parentTp > 0) {
              await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(active.id), {
                updated_at: nowIso(), sl_price: parentSl, tp_price: parentTp
              });
              await this.database.log('INFO', '[Tracker] Exchange bracket metadata verified from filled parent order', {
                symbol: key, orderId: String(parentOrderId), slPrice: parentSl, tpPrice: parentTp
              }).catch(() => {});
              return true;
            }
          } catch (error) {
            lastError = String(error?.message || error).slice(0, 200);
          }
        }
        const orders = await this.executor.getOpenOrders();
        const matching = (Array.isArray(orders) ? orders : []).filter(order =>
          stringValue(order?.product_symbol || order?.symbol).toUpperCase() === key
        );
        const orderWithBracket = matching.find(order =>
          numberOrNull(order?.bracket_stop_loss_price ?? order?.stop_loss_price ?? order?.stop_price) > 0 ||
          numberOrNull(order?.bracket_take_profit_price ?? order?.take_profit_price ?? order?.target_price) > 0
        );
        const sl = numberOrNull(orderWithBracket?.bracket_stop_loss_price ?? orderWithBracket?.stop_loss_price ?? orderWithBracket?.stop_price);
        const tp = numberOrNull(orderWithBracket?.bracket_take_profit_price ?? orderWithBracket?.take_profit_price ?? orderWithBracket?.target_price);
        if (sl !== null && tp !== null) {
          const patch = { updated_at: nowIso(), sl_price: sl, tp_price: tp };
          const orderId = orderWithBracket?.id ?? orderWithBracket?.order_id;
          if (orderId !== null && orderId !== undefined) patch.order_id = String(orderId);
          await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(active.id), patch);
          await this.database.log('INFO', '[Tracker] Exchange bracket metadata synced to dd_delta_positions', {
            symbol: key, slPrice: sl, tpPrice: tp, orderId: orderId ?? null
          }).catch(() => {});
          return true;
        }
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 200);
      }
      if (Date.now() + 1000 > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await this.database.log('WARN', '[Tracker] Exchange bracket metadata not visible within 30 seconds; position retained', {
      symbol: key, timeoutMs: 30_000, error: lastError
    }).catch(() => {});
    return false;
  }

  async processPosition(rawRow, envelope = {}) {
    const row = normalizeDeltaWsPosition(rawRow);
    if (!row) return;
    const symbol = row.symbol;
    const active = await this.findOpenRow(symbol);
    if (row.qty <= 0 || stringValue(envelope?.action || rawRow?.action).toLowerCase() === 'delete') {
      if (!active) return;
      let details = null;
      if (typeof this.executor.getRecentCloseDetails === 'function') {
        try {
          details = await this.executor.getRecentCloseDetails(symbol, active.opened_at, active);
        } catch (error) {
          await this.database.log(
            'WARN',
            '[Tracker] Close-fill lookup failed; exit details remain unverified',
            { symbol, error: String(error?.message || error).slice(0, 200) }
          ).catch(() => {});
        }
      }
      const close = deltaCloseFields({
        ...rawRow,
        action: envelope?.action ?? rawRow?.action,
        reason: envelope?.reason ?? rawRow?.reason,
        requested_exit_reason: active.requested_exit_reason
      }, details);
      const botManagedExit = ['BOT', 'SL', 'TP', 'TIMEOUT'].includes(close.exit_reason);
      const closeSource = stringValue(envelope?.source).toLowerCase() || 'private_websocket';
      const closeDetailsVerified = details?.close_fill_history_complete === true && close.realized_pnl !== null;
      const realizedPnlVerified = close.realized_pnl !== null &&
        (closeSource === 'private_websocket' || closeDetailsVerified);
      const closedAt = nowIso();
      await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(active.id), {
        status: botManagedExit ? 'CLOSED' : 'CLOSED_EXTERNALLY',
        closed_at: closedAt,
        updated_at: closedAt,
        unrealized_pnl: 0,
        ...close,
        close_source: closeSource,
        realized_pnl_verified: realizedPnlVerified
      });
      void this.materializeVerifiedClosedTrades().catch(error =>
        this.logSocketWarning('Verified Delta Testnet trade projection deferred', {
          error: String(error?.message || error).slice(0, 200)
        }, 'WARN')
      );
      return;
    }
    const fallbackStrategy = active?.strategy || 'MOMENTUM';
    const strategy = strategyFromClientOrderId(row.client_order_id, fallbackStrategy);
    const patch = {
      symbol,
      side: row.side,
      qty: row.qty,
      status: 'OPEN',
      strategy,
      opened_at: active?.opened_at || row.opened_at || nowIso(),
      closed_at: null,
      // Never preserve an old mark or UPL when the latest
      // WebSocket position payload does not contain that field.
      current_price: row.current_price ?? null,
      unrealized_pnl: row.unrealized_pnl ?? null,
      updated_at: nowIso()
    };
    if (row.order_id !== null) patch.order_id = String(row.order_id);
    const entryClientOrderId = stringValue(row.client_order_id || active?.client_order_id);
    if (row.order_id !== null && !active?.entry_order_id && /^DD[MS]-/i.test(entryClientOrderId)) {
      patch.entry_order_id = String(row.order_id);
    }
    if (row.product_id !== null) patch.product_id = row.product_id;
    if (row.client_order_id !== null) patch.client_order_id = String(row.client_order_id);
    if (row.entry_price !== null) patch.entry_price = row.entry_price;
    if (row.realized_pnl !== null) patch.realized_pnl = row.realized_pnl;
    if (row.sl_price !== null) patch.sl_price = row.sl_price;
    if (row.tp_price !== null) patch.tp_price = row.tp_price;

    if (active) {
      await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(active.id), patch);
    } else {
      try {
        await this.database.insert('dd_delta_positions', patch);
      } catch (error) {
        const concurrent = await this.findOpenRow(symbol).catch(() => null);
        if (!concurrent) throw error;
        await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(concurrent.id), patch);
      }
    }
    // Bracket data is often absent from the positions feed. Query the exchange
    // orders endpoint asynchronously for up to 30 seconds after each position sync.
    if (row.sl_price === null || row.tp_price === null || row.order_id === null) {
      void this.syncBracketMetadata(symbol).catch(error =>
        this.database.log('WARN', '[Tracker] Bracket metadata sync failed; position retained', {
          symbol, error: String(error?.message || error).slice(0, 200)
        }).catch(() => {})
      );
    }
  }

  async processOrder(order) {
    const symbol = stringValue(order?.product_symbol || order?.symbol).toUpperCase();
    const clientOrderId = stringValue(order?.client_order_id);
    const state = stringValue(order?.state || order?.order_state || order?.status).toLowerCase();
    const orderId = order?.id ?? order?.order_id;
    const eventReason = stringValue(order?.reason || order?.event_reason).toLowerCase();
    const unfilledSize = numberOrNull(order?.unfilled_size);
    const size = numberOrNull(order?.size);
    const averageFillPrice = numberOrNull(order?.average_fill_price ?? order?.avg_fill_price);
    const botEntry = /^DD[MSG]-/.test(clientOrderId.toUpperCase());
    const wsFillConfirmed = botEntry &&
      ['filled', 'closed'].includes(state) &&
      (eventReason === 'fill' || (unfilledSize === 0 && ((size !== null && size > 0) || (averageFillPrice !== null && averageFillPrice > 0))));

    if (clientOrderId && state) {
      const query = 'client_order_id=eq.' + encodeURIComponent(clientOrderId);
      const update = { state, updated_at: nowIso() };
      if (wsFillConfirmed) {
        const existing = await this.database.select(
          'dd_orders',
          query + '&select=raw&limit=1'
        ).catch(() => []);
        let existingRaw = existing?.[0]?.raw;
        if (typeof existingRaw === 'string') {
          try { existingRaw = JSON.parse(existingRaw); } catch { existingRaw = {}; }
        }
        update.raw = {
          ...(existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw) ? existingRaw : {}),
          fill_confirmed_by_private_websocket: true,
          fill_confirmed_by_private_websocket_at: nowIso(),
          private_websocket_fill_reason: eventReason || null,
          private_websocket_average_fill_price: averageFillPrice
        };
      }
      await this.database.update('dd_orders', query, update).catch(() => {});
    }

    if (!symbol) return;
    if (clientOrderId && botEntry) {
      const active = await this.findOpenRow(symbol).catch(() => null);
      if (active) {
        const patch = { updated_at: nowIso() };
        if (orderId !== null && orderId !== undefined) {
          patch.order_id = String(orderId);
          // Keep entry-fill identity separate: the generic order_id may later
          // be replaced by exchange bracket/stop/target metadata.
          patch.entry_order_id = String(orderId);
        }
        patch.strategy = strategyFromClientOrderId(clientOrderId, active.strategy);
        if (numberOrNull(order?.bracket_stop_loss_price) !== null) patch.sl_price = numberOrNull(order.bracket_stop_loss_price);
        if (numberOrNull(order?.bracket_take_profit_price) !== null) patch.tp_price = numberOrNull(order.bracket_take_profit_price);
        await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(active.id), patch);
      }
    }
    if (wsFillConfirmed) {
      await this.database.log('INFO', '[Tracker] Delta Testnet private WebSocket confirmed order fill', {
        symbol, orderId: orderId ?? null, clientOrderId,
        state, reason: eventReason || null, size, unfilledSize, averageFillPrice
      }).catch(() => {});
    }
    if (['filled', 'closed', 'cancelled', 'canceled', 'rejected'].includes(state)) this.scheduleSymbolReconcile(symbol);
  }

  scheduleSymbolReconcile(symbol) {
    const key = stringValue(symbol).toUpperCase();
    if (!key || this.symbolTimers.has(key)) return;
    const timer = setTimeout(async () => {
      this.symbolTimers.delete(key);
      if (this.stopped) return;
      try {
        const positions = await this.executor.getOpenPositions();
        const position = positions.find(row => row.symbol === key);
        if (position) await this.processPosition(position.raw || position);
        else {
          const active = await this.findOpenRow(key);
          if (active) await this.processPosition(
            { symbol: key, size: 0, realized_pnl: active.realized_pnl },
            { action: 'delete', source: 'rest_reconcile' }
          );
        }
      } catch (error) {
        await this.database.log('WARN', 'Delta Testnet symbol REST refresh failed', {
          symbol: key, error: String(error?.message || error)
        });
      }
    }, 350);
    timer.unref?.();
    this.symbolTimers.set(key, timer);
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.fillSyncInterval) clearInterval(this.fillSyncInterval);
    this.fillSyncInterval = null;
    if (this.walletSyncInterval) clearInterval(this.walletSyncInterval);
    this.walletSyncInterval = null;
    this.clearAuthTimeout();
    this.reconnectTimer = null;
    for (const timer of this.symbolTimers.values()) clearTimeout(timer);
    this.symbolTimers.clear();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      cleanupWebSocketListeners(socket);
      try { socket.close(); } catch {}
      try { socket.terminate?.(); } catch {}
    }
    this.authenticated = false;
  }
}
