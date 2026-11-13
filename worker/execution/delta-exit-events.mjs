const stringValue = value => String(value ?? '').trim();

const numberOrNull = value => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function normalizeDeltaExitReason(event = {}) {
  const metadata = event.meta_data && typeof event.meta_data === 'object' ? event.meta_data
    : event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const tokens = [
    event.exit_reason, event.exitReason,
    event.close_reason, event.closeReason,
    event.reason, event.event_reason,
    event.fill_type, event.fillType, metadata.fill_type,
    event.order_type, event.orderType, metadata.order_type,
    event.stop_order_type, event.stopOrderType, metadata.stop_order_type,
    metadata.close_reason
  ].map(stringValue).filter(Boolean).map(value =>
    value.toLowerCase().replace(/[\s-]+/g, '_')
  );

  // Exchange-confirmed evidence takes precedence over local intent.
  if (tokens.some(value => value.includes('liquidation'))) return 'LIQUIDATION';
  if (tokens.some(value => value === 'adl' || value.includes('auto_deleveraging'))) return 'ADL';
  if (tokens.some(value => value.includes('settlement'))) return 'SETTLEMENT';
  if (tokens.some(value => value === 'sl' || value.includes('stop_loss'))) return 'SL';
  if (tokens.some(value => value === 'tp' || value.includes('take_profit'))) return 'TP';
  if (tokens.some(value => value === 'timeout' || value.includes('time_out'))) return 'TIMEOUT';
  if (tokens.some(value => value === 'manual' || value.includes('manual_or_external'))) return 'MANUAL';
  if (tokens.some(value => value === 'bot' || value.includes('bot_exit'))) return 'BOT';

  // Our close manager persists this before sending a reduce-only order. Use it
  // only when the exchange payload does not identify the actual close reason.
  const requested = stringValue(event.requested_exit_reason ?? event.requestedExitReason)
    .toUpperCase().replace(/[\s-]+/g, '_');
  if (requested === 'TIMEOUT') return 'TIMEOUT';
  if (requested === 'STOP_LOSS' || requested === 'SL') return 'SL';
  if (requested === 'TAKE_PROFIT' || requested === 'TP') return 'TP';
  if (requested === 'MANUAL' || requested === 'BOT') return requested;

  const clientOrderId = stringValue(event.client_order_id ?? event.clientOrderId);
  if (/^DDX-X(?:-|$)/i.test(clientOrderId)) return 'BOT';
  // Engine-created protective children have stable, typed client IDs.
  if (/^OSL(?:BE)?-/i.test(clientOrderId)) return 'SL';
  if (/^OTP(?:1)?-/i.test(clientOrderId)) return 'TP';

  if (clientOrderId) {
    if (/^DD[MSG]-/i.test(clientOrderId) || /^DDX(?:-|$)/i.test(clientOrderId)) {
      return 'UNKNOWN';
    }
    return 'MANUAL';
  }

  if (event.close_order_history_found === true ||
      event.closeOrderHistoryFound === true ||
      event.reduce_only === true || event.reduceOnly === true) {
    return 'MANUAL';
  }

  return 'UNKNOWN';
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
    meta_data: detail.meta_data ?? event?.meta_data ?? source.meta_data,
    metadata: detail.metadata ?? event?.metadata ?? source.metadata,
    close_order_history_found: detail.close_order_history_found ??
      detail.closeOrderHistoryFound ?? event?.close_order_history_found ?? source.close_order_history_found,
    requested_exit_reason: detail.requested_exit_reason ??
      event?.requested_exit_reason ?? source.requested_exit_reason,
    close_reason: detail.close_reason ?? detail.closeReason ??
      event?.close_reason ?? event?.closeReason ?? source.close_reason ?? source.closeReason,
    stop_order_type: detail.stop_order_type ?? detail.stopOrderType ??
      event?.stop_order_type ?? source.stop_order_type ?? source.meta_data?.stop_order_type ?? source.metadata?.stop_order_type,
    fill_type: detail.fill_type ?? detail.fillType ??
      event?.fill_type ?? source.fill_type ?? source.meta_data?.fill_type ?? source.metadata?.fill_type,
    order_type: detail.order_type ?? detail.orderType ??
      event?.order_type ?? source.order_type ?? source.meta_data?.order_type ?? source.metadata?.order_type,
    client_order_id: detail.client_order_id ?? detail.clientOrderId ??
      event?.client_order_id ?? source.client_order_id,
    reduce_only: detail.reduce_only ?? event?.reduce_only ?? source.reduce_only
  };

  const closeOrderId = detail.close_order_id ??
    detail.order_id ??
    source.close_order_id ??
    source.closing_order_id ??
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
