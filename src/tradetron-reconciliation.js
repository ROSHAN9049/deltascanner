import { summarizeTradetronSnapshots } from './tradetron-position-sync.js';

const clean = value => String(value ?? '').trim();
const normalizedSide = value => {
  const side = clean(value).toUpperCase();
  if (['BUY', 'LONG'].includes(side)) return 'BUY';
  if (['SELL', 'SHORT'].includes(side)) return 'SELL';
  return '';
};
const absoluteQuantity = value => {
  if (value === null || value === undefined || clean(value) === '') return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) ? Math.abs(quantity) : null;
};
const timeValue = value => {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
};
const accepted = order => {
  const raw = order?.raw && typeof order.raw === 'object' && !Array.isArray(order.raw)
    ? order.raw
    : {};
  const acceptedFlag = order?.bridge_accepted ?? raw.bridge_accepted;
  if (acceptedFlag === true || String(acceptedFlag).toLowerCase() === 'true') return true;
  const response = clean(order?.bridge_response ?? raw.bridge_response).toLowerCase();
  return ['ok', 'success', 'accepted'].includes(response);
};
const orderSymbol = order => clean(order?.symbol || order?.raw?.symbol).toUpperCase();
const orderSide = order => normalizedSide(order?.side || order?.raw?.side);
const orderQuantity = order => absoluteQuantity(
  order?.size ?? order?.qty ?? order?.quantity ??
  order?.raw?.size ?? order?.raw?.qty ?? order?.raw?.quantity
);
const orderTime = order => {
  const value = order?.created_at || order?.captured_at || order?.updated_at;
  return { value: value || null, epoch: timeValue(value) };
};

function latestAcceptedSignals(signalOrders) {
  const latest = new Map();
  for (const order of Array.isArray(signalOrders) ? signalOrders : []) {
    if (!accepted(order)) continue;
    const symbol = orderSymbol(order);
    if (!symbol) continue;
    const time = orderTime(order);
    const previous = latest.get(symbol);
    // The dashboard API normally returns newest-first; retain the first row if
    // timestamps are equal or missing to avoid letting an older row replace it.
    if (!previous || (time.epoch !== null && (previous.time.epoch === null || time.epoch > previous.time.epoch))) {
      latest.set(symbol, {
        symbol,
        side: orderSide(order),
        quantity: orderQuantity(order),
        createdAt: time.value,
        timestampMs: time.epoch,
        state: clean(order?.state || 'UNKNOWN').toUpperCase(),
        id: clean(order?.id || '')
      });
    }
  }
  return latest;
}

/**
 * Compares read-only current Tradetron position snapshots with the most recent
 * scanner signal accepted by the Tradetron bridge for each symbol.
 *
 * This is a diagnostic comparison only: it cannot prove a fill, entry, exit,
 * or current strategy ownership. EXPIRED is the scanner's reservation TTL state,
 * not a fill/close result.
 */
export function buildTradetronPositionReconciliation({
  deployments = [],
  signalOrders = []
} = {}) {
  const snapshotRows = Array.isArray(deployments) ? deployments : [];
  const mirror = summarizeTradetronSnapshots(snapshotRows);
  const snapshotAsOf = mirror.asOf || snapshotRows
    .map(row => row?.last_success_at || row?.as_of || null)
    .filter(Boolean)
    .sort((a, b) => (timeValue(b) ?? -Infinity) - (timeValue(a) ?? -Infinity))[0] || null;
  const snapshotEpoch = timeValue(snapshotAsOf);
  const acceptedSignals = latestAcceptedSignals(signalOrders);

  const rows = mirror.openRows.map(position => {
    const signal = acceptedSignals.get(String(position.symbol || '').toUpperCase()) || null;
    const currentSide = normalizedSide(position.side);
    const currentQuantity = absoluteQuantity(position.quantity);
    let status = 'MATCH';

    if (!signal) {
      status = 'NO_ACCEPTED_SIGNAL';
    } else if (snapshotEpoch !== null && signal.timestampMs !== null && signal.timestampMs > snapshotEpoch) {
      // The snapshot predates the latest accepted signal, so comparing them as
      // if contemporaneous would create a false direction/quantity discrepancy.
      status = 'SIGNAL_NEWER_THAN_SNAPSHOT';
    } else if (!currentSide || currentQuantity === null || currentQuantity === 0 ||
               !signal.side || signal.quantity === null || signal.quantity === 0) {
      status = 'SIGNAL_DATA_INCOMPLETE';
    } else {
      const directionMismatch = currentSide !== signal.side;
      const quantityMismatch = Math.abs(currentQuantity - signal.quantity) > 1e-9;
      status = directionMismatch && quantityMismatch
        ? 'DIRECTION_AND_QUANTITY_MISMATCH'
        : directionMismatch
          ? 'DIRECTION_MISMATCH'
          : quantityMismatch
            ? 'QUANTITY_MISMATCH'
            : 'MATCH';
    }

    return {
      symbol: position.symbol,
      currentSide,
      currentQuantity,
      signalSide: signal?.side || '',
      signalQuantity: signal?.quantity ?? null,
      signalCreatedAt: signal?.createdAt || null,
      signalState: signal?.state || null,
      comparisonStatus: status,
      snapshotKey: position.key || null
    };
  });

  const count = status => rows.filter(row => row.comparisonStatus === status).length;
  const mismatchCount = rows.filter(row => [
    'DIRECTION_MISMATCH',
    'QUANTITY_MISMATCH',
    'DIRECTION_AND_QUANTITY_MISMATCH'
  ].includes(row.comparisonStatus)).length;
  const snapshotAvailable = snapshotRows.length > 0 && !mirror.positionsHidden;

  return {
    snapshotAvailable,
    positionsHidden: mirror.positionsHidden,
    snapshotAsOf,
    openPositionCount: mirror.openCount,
    visibleOpenRowCount: mirror.openRows.length,
    latestAcceptedSignalSymbols: acceptedSignals.size,
    mismatchCount,
    matchedCount: count('MATCH'),
    noAcceptedSignalCount: count('NO_ACCEPTED_SIGNAL'),
    newerSignalCount: count('SIGNAL_NEWER_THAN_SNAPSHOT'),
    incompleteCount: count('SIGNAL_DATA_INCOMPLETE'),
    rows
  };
}
