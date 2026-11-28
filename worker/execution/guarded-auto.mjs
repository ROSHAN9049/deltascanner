const DELTA_TESTNET_REST_BASE = 'https://cdn-ind.testnet.deltaex.org';

export const GUARDED_AUTO_SYMBOLS = Object.freeze(['XAUTUSD', 'PAXGUSD']);
export const GUARDED_AUTO_STRATEGIES = Object.freeze(['MOMENTUM', 'SCALPING']);
export const GUARDED_AUTO_ORDER_TYPES = Object.freeze({
  MOMENTUM: 'IOC_LIMIT_WITH_ATTACHED_BRACKET',
  SCALPING: 'IOC_LIMIT_WITH_ATTACHED_BRACKET'
});

export function resolveExchangeMinimumOrderSize(product) {
  const raw = product?.minimum_order_size ?? product?.min_order_size ?? product?.product_specs?.minimum_order_size;
  const minimum = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new Error('GUARDED_EXCHANGE_MINIMUM_SIZE_UNKNOWN');
  }
  return minimum;
}

export function assertExactMinimumQuantity(quantity, minimum) {
  const qty = Number(quantity), min = Number(minimum);
  if (!Number.isSafeInteger(min) || min < 1 || !Number.isSafeInteger(qty) || qty !== min) {
    throw new Error('GUARDED_QUANTITY_MUST_EQUAL_EXCHANGE_MINIMUM');
  }
  return qty;
}

export function assertKnownMargin({ available, observedAt, now = Date.now(), maxAgeMs = 30_000 } = {}) {
  const value = Number(available);
  const age = now - Number(observedAt);
  if (!(Number.isFinite(value) && value > 0) ||
      !Number.isFinite(age) || age < -5_000 || age > maxAgeMs) {
    throw new Error('GUARDED_MARGIN_UNKNOWN_OR_STALE');
  }
  return value;
}

export function assertAttachedBracket(order, stopLossPrice, takeProfitPrice) {
  const sl = Number(order?.bracket_stop_loss_price);
  const tp = Number(order?.bracket_take_profit_price);
  // Delta's CreateOrder response may return bracket_order=false even when
  // bracket trigger prices are attached to the entry order. Verify both
  // exchange-returned trigger prices, not that auxiliary boolean flag.
  if (!Number.isFinite(sl) || !Number.isFinite(tp) ||
      Math.abs(sl - Number(stopLossPrice)) > 1e-8 ||
      Math.abs(tp - Number(takeProfitPrice)) > 1e-8) {
    throw new Error('GUARDED_ATTACHED_SL_TP_NOT_VERIFIED');
  }
  return true;
}

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();

export function createGuardedAuto({
  database,
  executor,
  env = process.env,
  now = () => Date.now(),
  log = async (level, message, details) => database.log?.(level, message, details)
} = {}) {
  if (!database || !executor) throw new Error('Guarded Auto requires database and Delta executor dependencies');

  async function settings() {
    const rows = await database.select(
      'dd_settings',
      'id=eq.1&select=id,enabled,auto_trade,emergency_stop,last_tick_at,guarded_auto_enabled,momentum_enabled,scalping_enabled,guarded_estop_active'
    );
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Guarded Auto settings unavailable');
    return rows[0];
  }

  async function isEnabled() {
    const row = await settings();
    return row.guarded_auto_enabled === true;
  }

  async function assertEntryAllowed({ strategy, symbol, stage, restBase } = {}) {
    const normalizedStrategy = upper(strategy);
    const normalizedSymbol = upper(symbol);
    if (!GUARDED_AUTO_STRATEGIES.includes(normalizedStrategy)) throw new Error('GUARDED_STRATEGY_NOT_ALLOWED');
    if (!GUARDED_AUTO_SYMBOLS.includes(normalizedSymbol)) throw new Error('GUARDED_SYMBOL_NOT_ALLOWED');
    if (upper(stage) !== 'CONFIRMED') throw new Error('GUARDED_REQUIRES_CONFIRMED_SIGNAL');
    if (upper(env.DELTA_ENVIRONMENT) !== 'TESTNET' ||
        text(env.DELTA_EXECUTION_MODE).toLowerCase() !== 'testnet' ||
        text(restBase || env.DELTA_TESTNET_REST_BASE || DELTA_TESTNET_REST_BASE).replace(/\/+$/, '') !== DELTA_TESTNET_REST_BASE) {
      await forceAutoTradeOff('LIVE_OR_WRONG_ROUTE_DETECTED');
      throw new Error('GUARDED_TESTNET_ROUTE_REQUIRED');
    }
    const row = await settings();
    if (row.enabled !== true || row.auto_trade !== true ||
        row.emergency_stop !== false || row.guarded_auto_enabled !== true ||
        row.guarded_estop_active !== false) throw new Error('GUARDED_AUTO_DISABLED_OR_ESTOP_ACTIVE');
    if (normalizedStrategy === 'MOMENTUM' && row.momentum_enabled !== true) throw new Error('MOMENTUM_DISABLED');
    if (normalizedStrategy === 'SCALPING' && row.scalping_enabled !== true) throw new Error('SCALPING_DISABLED');
    const tick = Date.parse(String(row.last_tick_at || ''));
    if (!Number.isFinite(tick) || now() - tick < -30000 || now() - tick > 180000) {
      throw new Error('GUARDED_MARKET_TICK_STALE_OR_UNKNOWN');
    }
    return { strategy: normalizedStrategy, symbol: normalizedSymbol, settings: row };
  }

  async function reserve(input) {
    const allowed = await assertEntryAllowed(input);
    const clientOrderId = text(input.clientOrderId);
    if (!clientOrderId) throw new Error('GUARDED_CLIENT_ORDER_ID_REQUIRED');
    const result = await database.reserveGuardedAutoEntry({
      strategy: allowed.strategy,
      symbol: allowed.symbol,
      clientOrderId,
      metadata: { stage: 'CONFIRMED', reservedAt: new Date(now()).toISOString() }
    });
    if (result !== true) throw new Error('GUARDED_GLOBAL_POSITION_SLOT_UNAVAILABLE');
    await log('INFO', '[GuardedAuto] Global entry reservation acquired', {
      strategy: allowed.strategy, symbol: allowed.symbol, clientOrderId,
      globalPositionCap: 1, stage: 'CONFIRMED'
    });
    return { strategy: allowed.strategy, symbol: allowed.symbol, clientOrderId };
  }

  async function release({ clientOrderId, state = 'RELEASED', exchangeOrderId = null, metadata = {} } = {}) {
    if (!text(clientOrderId)) return false;
    return database.releaseGuardedAutoEntry({ clientOrderId, state, exchangeOrderId, metadata });
  }

  async function forceAutoTradeOff(reason) {
    await database.update('dd_settings', 'id=eq.1', {
      auto_trade: false,
      guarded_auto_enabled: false,
      updated_at: new Date(now()).toISOString()
    });
    await log('ERROR', '[GuardedAuto] Entries hard-disabled', {
      reason, environment: upper(env.DELTA_ENVIRONMENT),
      executionMode: text(env.DELTA_EXECUTION_MODE).toLowerCase()
    });
  }

  async function emergencyStop({ reason = 'OPERATOR_ESTOP' } = {}) {
    const activatedAt = new Date(now()).toISOString();
    // First close the entry gate in the database. Exit operations remain permitted.
    await database.update('dd_settings', 'id=eq.1', {
      enabled: false,
      auto_trade: false,
      emergency_stop: true,
      guarded_auto_enabled: false,
      momentum_enabled: false,
      scalping_enabled: false,
      guarded_estop_active: true,
      guarded_estop_activated_at: activatedAt,
      updated_at: activatedAt
    });
    const results = { cancelledOrderIds: [], closeOrderIds: [], errors: [] };
    const orders = await executor.getOpenOrders();
    for (const order of orders) {
      const id = Number(order?.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        results.errors.push({ phase: 'cancel', reason: 'OPEN_ORDER_ID_UNKNOWN' });
        continue;
      }
      try {
        await executor.cancelOrderById(id);
        results.cancelledOrderIds.push(id);
      } catch (error) {
        results.errors.push({ phase: 'cancel', orderId: id, reason: text(error?.message || error) });
      }
    }

    const positions = await executor.getOpenPositions();
    for (const position of positions) {
      try {
        const result = await executor.closePosition(position.symbol, position.qty, {
          positionId: text(position.order_id) || 'GUARDED-ESTOP-' + position.symbol + '-' + position.product_id,
          closeReason: 'TIMEOUT',
          expectedSide: position.side,
          expectedProductId: position.product_id,
          strategy: upper(position.strategy) === 'SCALPING' ? 'SCALPING' : 'MOMENTUM'
        });
        if (result?.id) results.closeOrderIds.push(String(result.id));
      } catch (error) {
        results.errors.push({ phase: 'close', symbol: position.symbol, reason: text(error?.message || error) });
      }
    }

    // Re-read exchange state after all mutations; never infer flatness from acknowledgements.
    const [remainingPositions, remainingOrders] = await Promise.all([
      executor.getOpenPositions(),
      executor.getOpenOrders()
    ]);
    const reconciledFlat = remainingPositions.length === 0;
    const reconciledOrdersClear = remainingOrders.length === 0;
    const finalState = {
      reason, activatedAt, cancelledOrderIds: results.cancelledOrderIds,
      closeOrderIds: results.closeOrderIds, errors: results.errors,
      remainingPositions: remainingPositions.map(p => ({ symbol: p.symbol, qty: p.qty, side: p.side })),
      remainingOrders: remainingOrders.map(o => ({ id: o.id ?? null, symbol: o.product_symbol || o.symbol || null, state: o.state || null })),
      reconciledFlat, reconciledOrdersClear,
      complete: reconciledFlat && reconciledOrdersClear && results.errors.length === 0
    };
    await log(finalState.complete ? 'ERROR' : 'FATAL', '[GuardedAuto] E-STOP exchange reconciliation complete', finalState);
    if (!finalState.complete) {
      const error = new Error('GUARDED_ESTOP_RECONCILIATION_INCOMPLETE');
      error.details = finalState;
      throw error;
    }
    return finalState;
  }

  return Object.freeze({ isEnabled, assertEntryAllowed, reserve, release, forceAutoTradeOff, emergencyStop });
}
