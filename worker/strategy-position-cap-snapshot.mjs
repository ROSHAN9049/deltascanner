import { assessStrategyPositionCap, normalizeStrategyPositionKey } from '../shared/strategy-position-limits.js';

const DEFAULT_STRATEGIES = Object.freeze(['MOMENTUM', 'SCALPING']);

export async function loadStrategyPositionCapSnapshot({
  database,
  settings = {},
  strategies = DEFAULT_STRATEGIES,
  now = Date.now()
} = {}) {
  if (typeof database?.selectWithCount !== 'function') {
    throw new TypeError('Strategy position-cap snapshot requires database.selectWithCount');
  }

  const keys = [...new Set((Array.isArray(strategies) ? strategies : [])
    .map(normalizeStrategyPositionKey)
    .filter(Boolean))];
  if (!keys.length) return {};

  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const recentFilledAfter = encodeURIComponent(new Date(nowMs - 120_000).toISOString());
  const [openSnapshot, entryOrderSnapshot] = await Promise.all([
    database.selectWithCount(
      'dd_delta_positions',
      'status=eq.OPEN&select=id,symbol,strategy,status,entry_order_id,client_order_id,order_id'
    ),
    database.selectWithCount(
      'dd_orders',
      'role=eq.ENTRY&or=(state.in.(PENDING,UNKNOWN,NEW,OPEN,PARTIALLY_FILLED),and(state.eq.FILLED,created_at.gte.' +
        recentFilledAfter +
        '))&select=id,client_order_id,strategy,role,state,created_at'
    )
  ]);
  const openPositions = openSnapshot?.rows;
  const entryOrders = entryOrderSnapshot?.rows;
  const openTotal = Number(openSnapshot?.total);
  const entryOrderTotal = Number(entryOrderSnapshot?.total);

  if (!Array.isArray(openPositions) || !Array.isArray(entryOrders) ||
      !Number.isSafeInteger(openTotal) || !Number.isSafeInteger(entryOrderTotal)) {
    throw new Error('Position or entry-reservation query returned malformed data');
  }
  if (openTotal !== openPositions.length || entryOrderTotal !== entryOrders.length ||
      openTotal > 1000 || entryOrderTotal > 1000) {
    throw new Error('Position or entry-reservation snapshot was truncated or exceeded its safe row cap; new entries fail closed');
  }

  return Object.fromEntries(keys.map(strategy => [strategy, assessStrategyPositionCap({
    strategy,
    settings,
    openPositions,
    pendingOrders: entryOrders,
    now: nowMs
  })]));
}
