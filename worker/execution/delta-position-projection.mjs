const text = value => String(value ?? '').trim();
const price = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * Resolve the exchange-authoritative SL/TP projection for a legacy ENGINE row.
 * The row is matched by its stable client order ID or exchange entry order ID;
 * signal-cache prices are never allowed to override the canonical exchange row.
 */
export function projectCanonicalDeltaBrackets(enginePosition, canonicalRows) {
  const symbol = text(enginePosition?.symbol).toUpperCase();
  const executionId = text(enginePosition?.execution_id || enginePosition?.client_order_id);
  const entryOrderId = text(enginePosition?.entry_order_id);
  if (!symbol || (!executionId && !entryOrderId) || !Array.isArray(canonicalRows)) {
    return { ok: false, reason: 'CANONICAL_DELTA_POSITION_IDENTITY_UNAVAILABLE' };
  }

  const canonical = canonicalRows.find(row =>
    text(row?.symbol).toUpperCase() === symbol &&
    ((executionId && text(row?.client_order_id) === executionId) ||
     (entryOrderId && text(row?.entry_order_id) === entryOrderId))
  );
  if (!canonical) {
    return { ok: false, reason: 'CANONICAL_DELTA_POSITION_NOT_FOUND' };
  }
  if (text(canonical.status).toUpperCase() !== 'OPEN') {
    return { ok: false, reason: 'CANONICAL_DELTA_POSITION_NOT_OPEN' };
  }

  const stop = price(canonical.sl_price);
  const target = price(canonical.tp_price);
  if (stop === null || target === null) {
    return { ok: false, reason: 'CANONICAL_DELTA_BRACKET_LEVELS_UNAVAILABLE' };
  }

  const patch = {};
  if (price(enginePosition.stop_price) !== stop) patch.stop_price = stop;
  if (price(enginePosition.tp_price) !== target) patch.tp_price = target;
  if (canonical.entry_order_id && text(enginePosition.entry_order_id) !== text(canonical.entry_order_id)) {
    patch.entry_order_id = String(canonical.entry_order_id);
  }
  return { ok: true, canonical, patch, changed: Object.keys(patch).length > 0 };
}
