import WebSocket from 'ws';
import * as defaultDb from '../../server/db.js';
import {
  assertDeltaTestnetConfiguration,
  deltaExecutor,
  DELTA_TESTNET_PRIVATE_WS_URL,
  deltaHmacSha256
} from './delta-executor.mjs';
import { shouldEmitThrottledLog, websocketReconnectDelay, WS_ERROR_LOG_COOLDOWN_MS } from '../ws-resilience.mjs';

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
    reconcileMs = 30000
  } = {}) {
    this.env = env;
    this.database = database;
    this.executor = executor;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectMs = reconnectMs;
    this.reconcileMs = reconcileMs;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconcileTimer = null;
    this.stopped = true;
    this.authenticated = false;
    this.retryCount = 0;
    this.symbolTimers = new Map();
    this.reconcileInFlight = false;
    this.authTimeoutTimer = null;
    this.lastSocketWarningAt = 0;
  }

  async start() {
    assertDeltaTestnetConfiguration(this.env);
    if (!this.stopped) return;
    this.stopped = false;
    try { await this.reconcilePositions(); }
    catch (error) {
      await this.database.log('ERROR', 'Delta Testnet initial position reconciliation failed; executor remains fail-closed', {
        error: String(error?.message || error)
      });
    }
    this.reconcileTimer = setInterval(() => {
      void this.reconcilePositions().catch(error =>
        this.database.log('ERROR', 'Delta Testnet REST position reconciliation failed', {
          error: String(error?.message || error)
        })
      );
    }, this.reconcileMs);
    this.reconcileTimer.unref?.();
    this.connect();
  }

  async logSocketWarning(message, data = {}, level = 'WARN') {
    const now = Date.now();
    if (!shouldEmitThrottledLog(this.lastSocketWarningAt, now, WS_ERROR_LOG_COOLDOWN_MS)) return;
    this.lastSocketWarningAt = now;
    await this.database.log(level, message, data).catch(() => {});
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
          try { socket.terminate?.(); } catch {}
          try { socket.close(); } catch {}
        }, 10_000);
        this.authTimeoutTimer.unref?.();
      } catch (error) {
        void this.logSocketWarning('Delta Testnet WebSocket authentication setup failed', {
          error: String(error?.message || error).slice(0, 200)
        });
        this.scheduleReconnect();
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
      const rateLimited = /429|rate.?limit|too many connections|unexpected server response: 429/i.test(message);
      void this.logSocketWarning('Delta Testnet WebSocket error; reconnect scheduled', {
        error: message.slice(0, 200),
        rateLimited,
        retryPolicy: rateLimited ? 'cooldown' : 'exponential'
      }, rateLimited ? 'WARN' : 'DEBUG');
      if (this.socket === socket) this.socket = null;
      this.authenticated = false;
      this.clearAuthTimeout();
      this.scheduleReconnect({ rateLimited });
      try { socket.terminate?.(); } catch {}
      try { socket.close(); } catch {}
    });

    socket.on('close', (code, reasonBuffer) => {
      if (this.socket === socket) this.socket = null;
      this.authenticated = false;
      this.clearAuthTimeout();
      const uptimeMs = openedAt > 0 ? Date.now() - openedAt : 0;
      if (uptimeMs >= 60_000) this.retryCount = 0;
      const reason = reasonBuffer ? reasonBuffer.toString().slice(0, 120) : '';
      if (!this.stopped) {
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
    });
  }

  scheduleReconnect({ rateLimited = false } = {}) {
    if (this.stopped || this.reconnectTimer) return;
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
        try { socket?.terminate?.(); } catch {}
        try { socket?.close(); } catch {}
        this.scheduleReconnect({
          rateLimited: Number(message.status_code) === 429 || /429|rate.?limit/i.test(String(message.status || ''))
        });
        return;
      }
      this.clearAuthTimeout();
      this.authenticated = true;
      this.socket?.send(JSON.stringify({ type: 'enable_heartbeat' }));
      this.socket?.send(JSON.stringify({
        type: 'subscribe',
        payload: { channels: [{ name: 'orders', symbols: ['all'] }] }
      }));
      this.socket?.send(JSON.stringify({
        type: 'subscribe',
        payload: { channels: [{ name: 'positions', symbols: ['all'] }] }
      }));
      await this.database.log('INFO', 'Delta Testnet private WebSocket authenticated; orders and positions subscribed', {});
      return;
    }
    const channel = stringValue(message?.type || message?.channel).toLowerCase();
    if (channel === 'positions') {
      for (const row of rowsFromMessage(message)) await this.processPosition(row, message);
      return;
    }
    if (channel === 'orders') {
      for (const row of rowsFromMessage(message)) await this.processOrder(row);
    }
  }

  async findOpenRow(symbol) {
    const rows = await this.database.select(
      'dd_delta_positions',
      'symbol=eq.' + encodeURIComponent(symbol) + '&status=eq.OPEN&order=updated_at.desc&limit=1'
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async processPosition(rawRow, envelope = {}) {
    const row = normalizeDeltaWsPosition(rawRow);
    if (!row) return;
    const symbol = row.symbol;
    const active = await this.findOpenRow(symbol);
    if (row.qty <= 0 || stringValue(envelope?.action || rawRow?.action).toLowerCase() === 'delete') {
      if (!active) return;
      const patch = { status: 'CLOSED', closed_at: nowIso(), updated_at: nowIso(), unrealized_pnl: 0 };
      if (row.realized_pnl !== null) patch.realized_pnl = row.realized_pnl;
      await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(active.id), patch);
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
      updated_at: nowIso()
    };
    if (row.order_id !== null) patch.order_id = String(row.order_id);
    if (row.product_id !== null) patch.product_id = row.product_id;
    if (row.client_order_id !== null) patch.client_order_id = String(row.client_order_id);
    if (row.entry_price !== null) patch.entry_price = row.entry_price;
    if (row.current_price !== null) patch.current_price = row.current_price;
    if (row.unrealized_pnl !== null) patch.unrealized_pnl = row.unrealized_pnl;
    if (row.realized_pnl !== null) patch.realized_pnl = row.realized_pnl;
    if (row.sl_price !== null) patch.sl_price = row.sl_price;
    if (row.tp_price !== null) patch.tp_price = row.tp_price;

    if (active) {
      await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(active.id), patch);
      return;
    }
    try {
      await this.database.insert('dd_delta_positions', patch);
    } catch (error) {
      const concurrent = await this.findOpenRow(symbol).catch(() => null);
      if (!concurrent) throw error;
      await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(concurrent.id), patch);
    }
  }

  async processOrder(order) {
    const symbol = stringValue(order?.product_symbol || order?.symbol).toUpperCase();
    const clientOrderId = stringValue(order?.client_order_id);
    const state = stringValue(order?.state || order?.order_state || order?.status).toLowerCase();
    const orderId = order?.id ?? order?.order_id;
    if (clientOrderId && state) {
      await this.database.update(
        'dd_orders',
        'client_order_id=eq.' + encodeURIComponent(clientOrderId),
        { state, updated_at: nowIso() }
      ).catch(() => {});
    }
    if (!symbol) return;
    if (clientOrderId && /^DD[MSG]-/.test(clientOrderId.toUpperCase())) {
      const active = await this.findOpenRow(symbol).catch(() => null);
      if (active) {
        const patch = { updated_at: nowIso() };
        if (orderId !== null && orderId !== undefined) patch.order_id = String(orderId);
        patch.strategy = strategyFromClientOrderId(clientOrderId, active.strategy);
        if (numberOrNull(order?.bracket_stop_loss_price) !== null) patch.sl_price = numberOrNull(order.bracket_stop_loss_price);
        if (numberOrNull(order?.bracket_take_profit_price) !== null) patch.tp_price = numberOrNull(order.bracket_take_profit_price);
        await this.database.update('dd_delta_positions', 'id=eq.' + encodeURIComponent(active.id), patch);
      }
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
          if (active) await this.processPosition({ symbol: key, size: 0, realized_pnl: active.realized_pnl }, { action: 'delete' });
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

  async reconcilePositions() {
    if (this.reconcileInFlight || this.stopped) return;
    this.reconcileInFlight = true;
    try {
      const positions = await this.executor.getOpenPositions();
      const openRows = await this.database.select(
        'dd_delta_positions',
        'status=eq.OPEN&select=id,symbol,realized_pnl&limit=1000'
      );
      const currentSymbols = new Set();
      for (const position of positions) {
        currentSymbols.add(position.symbol);
        await this.processPosition(position.raw || position);
      }
      for (const row of Array.isArray(openRows) ? openRows : []) {
        const symbol = stringValue(row?.symbol).toUpperCase();
        if (symbol && !currentSymbols.has(symbol)) {
          await this.processPosition({ symbol, size: 0, realized_pnl: row.realized_pnl }, { action: 'delete' });
        }
      }
    } finally {
      this.reconcileInFlight = false;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.clearAuthTimeout();
    this.reconnectTimer = null;
    this.reconcileTimer = null;
    for (const timer of this.symbolTimers.values()) clearTimeout(timer);
    this.symbolTimers.clear();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try { socket.close(); } catch {}
    }
    this.authenticated = false;
  }
}
