const text = value => String(value ?? '').trim();
const number = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function matchesPrice(actual, expected, tickSize) {
  const a = number(actual);
  const e = number(expected);
  if (!(a > 0 && e > 0)) return false;
  const tick = Math.max(0, number(tickSize) || 0);
  // Do not use a percentage tolerance: even a small percentage can match a
  // different nearby trigger price. Only allow exchange tick rounding.
  const tolerance = tick > 0 ? tick * 2 : 1e-9;
  return Math.abs(a - e) <= tolerance;
}

/**
 * Resolve distinct exchange child-order IDs from a fresh open-orders snapshot.
 * Never substitute the parent entry order ID for either protective child.
 */
export function resolveBracketChildOrderIds(orders, {
  productId,
  qty,
  stopPrice,
  takeProfitPrice,
  tickSize = 0
} = {}) {
  const expectedProductId = number(productId);
  const expectedQty = number(qty);
  if (!(expectedProductId > 0 && expectedQty > 0)) {
    return { stopLossOrderId: null, takeProfitOrderId: null };
  }
  const rows = Array.isArray(orders) ? orders : [];
  const eligible = rows.filter(order =>
    number(order?.product_id) === expectedProductId &&
    number(order?.size) >= expectedQty &&
    (order?.reduce_only === true || order?.reduce_only === 'true' ||
      order?.stop_order_type === 'stop_loss_order' || order?.stop_order_type === 'take_profit_order')
  );
  const idOf = order => {
    const value = order?.id ?? order?.order_id;
    return value === null || value === undefined || text(value) === '' ? null : String(value);
  };
  const stop = eligible.find(order =>
    order?.stop_order_type === 'stop_loss_order' &&
    matchesPrice(order.stop_price ?? order.bracket_stop_loss_price, stopPrice, tickSize)
  );
  const target = eligible.find(order =>
    order?.stop_order_type === 'take_profit_order' &&
    matchesPrice(order.stop_price ?? order.bracket_take_profit_price, takeProfitPrice, tickSize)
  );
  const stopLossOrderId = stop ? idOf(stop) : null;
  const takeProfitOrderId = target ? idOf(target) : null;
  return {
    stopLossOrderId,
    takeProfitOrderId: takeProfitOrderId === stopLossOrderId ? null : takeProfitOrderId
  };
}
