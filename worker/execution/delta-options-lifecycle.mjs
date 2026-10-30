import {
  resolveCreditSpreadEntryProgress,
  resolveCreditSpreadExitProgress
} from './delta-options-execution-policy.mjs';

const ROLES = new Set(['LONG_PREMIUM', 'PROTECTIVE_WING', 'SHORT_OPTION']);
const INTENTS = new Set(['ENTRY', 'EXIT', 'UNWIND']);
const ACTIVE_ORDER_STATES = new Set([
  'RESERVED', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'UNKNOWN',
  'RECONCILIATION_REQUIRED'
]);
const TERMINAL_ORDER_STATES = new Set([
  'FILLED', 'CLOSED', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'FAILED'
]);
const upper = value => String(value ?? '').trim().toUpperCase();
const positive = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const quantity = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

function latestOrder(orders, role, intent) {
  return orders
    .filter(row => upper(row.leg_role) === role && upper(row.intent) === intent)
    .sort((a, b) => Number(b.attempt_no) - Number(a.attempt_no))[0] || null;
}

function sumOrderFills(orders, role, intent) {
  return orders
    .filter(row => upper(row.leg_role) === role && upper(row.intent) === intent)
    .reduce((sum, row) => sum + (quantity(row.filled_qty) ?? 0), 0);
}

function actionFor({ leg, role, intent, attemptNo, now, quotes, maxQuoteAgeMs }) {
  const quote = quotes?.[role];
  const bid = positive(quote?.bid);
  const ask = positive(quote?.ask);
  const updatedAt = Date.parse(String(quote?.updatedAt ?? ''));
  const tick = positive(leg?.tick_size);
  if (!bid || !ask || ask < bid || !tick || !Number.isFinite(updatedAt) ||
      updatedAt > now || now - updatedAt > maxQuoteAgeMs) {
    return {
      status: 'WAITING_FOR_FRESH_QUOTE',
      reason: 'A fresh, valid bid/ask and verified tick size are required before an IOC order can be planned'
    };
  }
  const side = intent === 'ENTRY'
    ? upper(leg.side)
    : upper(leg.side) === 'BUY' ? 'SELL' : 'BUY';
  const limitPrice = side === 'BUY' ? ask : bid;
  const tickUnits = limitPrice / tick;
  if (Math.abs(tickUnits - Math.round(tickUnits)) > 1e-8) {
    return {
      status: 'QUOTE_NOT_TICK_ALIGNED',
      reason: 'The executable quote is not aligned to the persisted Testnet tick size'
    };
  }
  return {
    status: 'ACTION_READY',
    nextAction: {
      groupId: String(leg.group_id),
      legRole: role,
      intent,
      attemptNo,
      side,
      limitPrice,
      reduceOnly: intent !== 'ENTRY',
      timeInForce: 'IOC'
    }
  };
}

function orderStatus(order) {
  return upper(order?.order_state || '');
}

function isUnresolved(order) {
  return Boolean(order && ACTIVE_ORDER_STATES.has(orderStatus(order)));
}

function validateSnapshot(group, legs, orders) {
  if (!group || !['OPTIONS_BUY', 'OPTIONS_SELL'].includes(upper(group.strategy)) ||
      !Array.isArray(legs) || !Array.isArray(orders) || legs.length < 1 || legs.length > 2) {
    return 'Options lifecycle snapshot is malformed';
  }
  const roles = legs.map(row => upper(row.leg_role));
  if (roles.some(role => !ROLES.has(role)) || new Set(roles).size !== roles.length) {
    return 'Options lifecycle contains missing, duplicate or unsupported leg roles';
  }
  if (upper(group.strategy) === 'OPTIONS_BUY' && (legs.length !== 1 || roles[0] !== 'LONG_PREMIUM')) {
    return 'Long-premium group must contain exactly one LONG_PREMIUM leg';
  }
  if (upper(group.strategy) === 'OPTIONS_SELL' &&
      (legs.length !== 2 || !roles.includes('PROTECTIVE_WING') || !roles.includes('SHORT_OPTION'))) {
    return 'Credit-spread group must contain exactly one protective and one short leg';
  }
  for (const leg of legs) {
    if (!quantity(leg.requested_qty) || Number(leg.requested_qty) < 1 ||
        !quantity(leg.filled_qty) || Number(leg.filled_qty) > Number(leg.requested_qty) ||
        !quantity(leg.exit_filled_qty) || Number(leg.exit_filled_qty) > Number(leg.filled_qty)) {
      return 'Persisted leg fill balances are missing or inconsistent';
    }
  }
  for (const order of orders) {
    if (!ROLES.has(upper(order.leg_role)) || !INTENTS.has(upper(order.intent)) ||
        !TERMINAL_ORDER_STATES.has(orderStatus(order)) &&
        !ACTIVE_ORDER_STATES.has(orderStatus(order))) {
      return 'Order ledger contains an unknown role, intent or state';
    }
  }
  return null;
}

/**
 * Pure decision engine. It never calls the database, exchange, or order
 * coordinator. The caller must persist and re-read any action before dispatch.
 */
export function planDeltaOptionsLifecycle({
  group,
  legs = [],
  orders = [],
  quotes = {},
  entrySignalReady = false,
  exitRequested = false,
  expiryExitDue = false,
  now = Date.now(),
  maxQuoteAgeMs = 5_000
} = {}) {
  const malformed = validateSnapshot(group, legs, orders);
  if (malformed) return { status: 'RECONCILIATION_REQUIRED', reason: malformed };
  if (upper(group.state) === 'RECONCILIATION_REQUIRED') {
    return { status: 'RECONCILIATION_REQUIRED', reason: 'Group is durably locked for reconciliation' };
  }
  const clock = Number(now);
  const quoteAge = Number(maxQuoteAgeMs);
  if (!Number.isFinite(clock) || clock <= 0 || !Number.isFinite(quoteAge) || quoteAge < 1) {
    return { status: 'RECONCILIATION_REQUIRED', reason: 'Lifecycle clock or quote-age limit is invalid' };
  }

  const byRole = new Map(legs.map(row => [upper(row.leg_role), row]));
  const exitDue = exitRequested === true || expiryExitDue === true;
  const attemptNoFor = (role, intent) =>
    orders.filter(row => upper(row.leg_role) === role && upper(row.intent) === intent)
      .reduce((max, row) => Math.max(max, Number(row.attempt_no) || 0), 0) + 1;
  const plan = (role, intent) => actionFor({
    leg: byRole.get(role), role, intent,
    attemptNo: attemptNoFor(role, intent),
    now: clock, quotes, maxQuoteAgeMs: quoteAge
  });

  if (upper(group.strategy) === 'OPTIONS_BUY') {
    const leg = byRole.get('LONG_PREMIUM');
    const entry = latestOrder(orders, 'LONG_PREMIUM', 'ENTRY');
    const entryFilled = Number(leg.filled_qty);
    const remainingEntry = Number(leg.requested_qty) - entryFilled;
    if (isUnresolved(entry)) return { status: 'ORDER_PENDING', reason: 'Long-premium entry IOC is unresolved' };
    if (!exitDue && remainingEntry > 0) {
      if (!entrySignalReady) return { status: 'WAITING_FOR_CONFIRMED_ENTRY', reason: 'A fresh ready BUY/SELL underlying signal is required for entry or remaining-size retry' };
      return plan('LONG_PREMIUM', 'ENTRY');
    }
    if (exitDue) {
      const exit = latestOrder(orders, 'LONG_PREMIUM', 'EXIT');
      if (isUnresolved(exit)) return { status: 'ORDER_PENDING', reason: 'Long-premium reduce-only exit IOC is unresolved' };
      const exitFilled = sumOrderFills(orders, 'LONG_PREMIUM', 'EXIT');
      if (entryFilled <= exitFilled) return { status: 'CLOSED', reason: 'Long-premium position is confirmed flat' };
      return plan('LONG_PREMIUM', 'EXIT');
    }
    if (entryFilled > 0 && remainingEntry <= 0) return { status: 'OPEN', reason: 'Long-premium entry is fully filled' };
    if (entryFilled > 0) return { status: 'OPEN_PARTIAL', reason: 'Long-premium position is partially filled; no further entry without a fresh ready signal' };
    if (entry && ['REJECTED', 'FAILED', 'EXPIRED'].includes(orderStatus(entry))) {
      return { status: 'ENTRY_REJECTED', reason: 'Long-premium entry ended without a position' };
    }
    return { status: 'WAITING', reason: 'No actionable long-premium lifecycle transition' };
  }

  const protective = byRole.get('PROTECTIVE_WING');
  const short = byRole.get('SHORT_OPTION');
  const protectiveEntry = latestOrder(orders, 'PROTECTIVE_WING', 'ENTRY');
  const shortEntry = latestOrder(orders, 'SHORT_OPTION', 'ENTRY');
  const protectiveQty = Number(protective.filled_qty);
  const shortQty = Number(short.filled_qty);

  if (isUnresolved(protectiveEntry)) {
    return { status: 'ORDER_PENDING', reason: 'Protective BUY must reach a terminal, reconciled state before short SELL' };
  }
  if (!protectiveEntry) {
    if (!entrySignalReady && !exitDue) {
      return { status: 'WAITING_FOR_CONFIRMED_ENTRY', reason: 'A fresh ready underlying signal is required before protective BUY' };
    }
    if (exitDue) return { status: 'CLOSED', reason: 'No protective leg was entered; there is no spread exposure to exit' };
    return plan('PROTECTIVE_WING', 'ENTRY');
  }

  if (protectiveQty === 0 && !shortEntry) {
    return { status: 'ENTRY_REJECTED', reason: 'Protective BUY ended without confirmed fills; short SELL is prohibited' };
  }

  if (isUnresolved(shortEntry)) {
    return { status: 'ORDER_PENDING', reason: 'Short SELL must reach a terminal, reconciled state before matching or unwind' };
  }

  const unwind = latestOrder(orders, 'PROTECTIVE_WING', 'UNWIND');
  if (shortEntry) {
    const progress = resolveCreditSpreadEntryProgress({
      protectiveState: orderStatus(protectiveEntry),
      protectiveFilledQty: protectiveQty,
      shortSubmitted: true,
      shortState: orderStatus(shortEntry),
      shortFilledQty: shortQty,
      protectiveFullUnwindSubmitted: shortQty === 0 && Boolean(unwind),
      protectiveFullUnwindState: orderStatus(unwind),
      protectiveFullUnwoundQty: sumOrderFills(orders, 'PROTECTIVE_WING', 'UNWIND'),
      protectiveExcessUnwindSubmitted: shortQty > 0 && Boolean(unwind),
      protectiveExcessUnwindState: orderStatus(unwind),
      protectiveExcessUnwoundQty: sumOrderFills(orders, 'PROTECTIVE_WING', 'UNWIND')
    });
    if (progress.state === 'RECONCILIATION_REQUIRED') return { status: progress.state, reason: progress.reason };
    if (progress.state === 'UNWIND_PENDING') return plan('PROTECTIVE_WING', 'UNWIND');
    if (progress.state === 'REJECTED') return { status: 'ENTRY_REJECTED', reason: progress.reason };
    if (progress.state === 'SHORT_ENTRY_READY') return plan('SHORT_OPTION', 'ENTRY');
    if (progress.state !== 'OPEN') return { status: progress.state, reason: progress.reason };
  } else {
    return plan('SHORT_OPTION', 'ENTRY');
  }

  if (!exitDue) return { status: 'OPEN', matchedQty: Math.min(protectiveQty - sumOrderFills(orders, 'PROTECTIVE_WING', 'UNWIND'), shortQty) };

  const shortExit = latestOrder(orders, 'SHORT_OPTION', 'EXIT');
  const protectiveExit = latestOrder(orders, 'PROTECTIVE_WING', 'EXIT');
  const shortExitFilled = sumOrderFills(orders, 'SHORT_OPTION', 'EXIT');
  const protectiveExitFilled = sumOrderFills(orders, 'PROTECTIVE_WING', 'EXIT');
  const protectiveUnwound = sumOrderFills(orders, 'PROTECTIVE_WING', 'UNWIND');
  const progress = resolveCreditSpreadExitProgress({
    shortPositionQty: shortQty,
    shortCloseSubmitted: Boolean(shortExit),
    shortCloseState: orderStatus(shortExit),
    shortCloseFilledQty: shortExitFilled,
    protectivePositionQty: protectiveQty - protectiveUnwound,
    protectiveCloseSubmitted: Boolean(protectiveExit),
    protectiveCloseState: orderStatus(protectiveExit),
    protectiveCloseFilledQty: protectiveExitFilled
  });
  if (progress.state === 'RECONCILIATION_REQUIRED') return { status: progress.state, reason: progress.reason };
  if (progress.state === 'CLOSED') return { status: 'CLOSED', reason: progress.reason };
  if (progress.state === 'SHORT_EXIT_PENDING') {
    return shortExit && TERMINAL_ORDER_STATES.has(orderStatus(shortExit))
      ? plan('SHORT_OPTION', 'EXIT')
      : shortExit ? { status: 'ORDER_PENDING', reason: progress.reason } : plan('SHORT_OPTION', 'EXIT');
  }
  if (progress.state === 'HEDGE_EXIT_PENDING') {
    return protectiveExit && TERMINAL_ORDER_STATES.has(orderStatus(protectiveExit))
      ? plan('PROTECTIVE_WING', 'EXIT')
      : protectiveExit ? { status: 'ORDER_PENDING', reason: progress.reason } : plan('PROTECTIVE_WING', 'EXIT');
  }
  return { status: progress.state, reason: progress.reason };
}
