const stringValue = value => String(value ?? '').trim();

const numberOrNull = value => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function normalizeDeltaExitReason(event = {}) {
  const tokens = [
    event.exit_reason, event.exitReason,
    event.reason, event.event_reason,
    event.fill_type, event.fillType,
    event.order_type, event.orderType,
    event.stop_order_type, event.stopOrderType
  ].map(stringValue).filter(Boolean).map(value =>
    value.toLowerCase().replace(/[\s-]+/g, '_')
  );

  if (tokens.some(value => value.includes('liquidation'))) return 'liquidation';
  if (tokens.some(value => value === 'adl' || value.includes('auto_deleveraging'))) return 'adl';
  if (tokens.some(value => value.includes('settlement'))) return 'settlement';
  if (tokens.some(value => value.includes('stop_loss'))) return 'stop_loss_order';
  if (tokens.some(value => value.includes('take_profit'))) return 'take_profit_order';

  const clientOrderId = stringValue(event.client_order_id ?? event.clientOrderId);
  if (/^DDX-X(?:-|$)/i.test(clientOrderId)) return 'bot-exit';

  if (clientOrderId) {
    if (/^DD[MSG]-/i.test(clientOrderId) || /^DDX(?:-|$)/i.test(clientOrderId)) {
      return 'unknown';
    }
    return 'manual-or-external';
  }

  if (event.close_order_history_found === true ||
      event.closeOrderHistoryFound === true ||
      event.reduce_only === true || event.reduceOnly === true) {
    return 'manual-or-external';
  }

  return 'unknown';
}

function firstNumber(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = numberOrNull(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

export function deltaCloseFields(event = {}, details = null) {
  const source = event?.raw && typeof event.raw === 'object'
    ? event.raw
    : event;
  const detail = details && typeof details === 'object' ? details : {};
  const sources = [detail, source];

  const reasonEvent = {
    ...source,
    ...detail,
    close_order_history_found: detail.close_order_history_found ??
      detail.closeOrderHistoryFound ?? source.close_order_history_found,
    stop_order_type: detail.stop_order_type ?? source.stop_order_type,
    fill_type: detail.fill_type ?? source.fill_type,
    client_order_id: detail.client_order_id ?? source.client_order_id,
    reduce_only: detail.reduce_only ?? source.reduce_only
  };

  const closeOrderId = detail.close_order_id ??
    detail.order_id ??
    source.close_order_id ??
    source.closing_order_id ??
    source.order_id ??
    null;

  return {
    exit_price: firstNumber(sources, [
      'exit_price', 'average_exit_price', 'average_fill_price', 'close_price'
    ]),
    fees: firstNumber(sources, [
      'fees', 'exit_fees', 'closing_fees', 'fee'
    ]),
    fee_currency: stringValue(detail.fee_currency ?? source.fee_currency) || null,
    realized_pnl: firstNumber(sources, ['realized_pnl', 'realizedPnl']),
    exit_reason: normalizeDeltaExitReason(reasonEvent),
    close_order_id: closeOrderId === null ? null : String(closeOrderId)
  };
}
