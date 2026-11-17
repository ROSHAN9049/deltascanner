import { assessStrategyPositionCap, normalizeStrategyPositionKey } from '../shared/strategy-position-limits.js';

const DEFAULT_STRATEGIES = Object.freeze(['MOMENTUM', 'SCALPING']);

export async function loadStrategyPositionCapSnapshot({
  database,
  settings = {},
  strategies = DEFAULT_STRATEGIES,
  now = Date.now()
} = {}) {
  if (typeof database?.select !== 'function') {
    throw new TypeError('Strategy position-cap snapshot requires database.select');
  }

  const keys = [...new Set((Array.isArray(strategies) ? strategies : [])
    .map(normalizeStrategyPositionKey)
    .filter(Boolean))];
  if (!keys.length) return {};

  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const recentFilledAfter = encodeURIComponent(new Date(nowMs - 120_000).toISOString());
  const [openPositions, entryOrders] = await Promise.all([
    database.select(
      'dd_delta_positions',
      'status=eq.OPEN&select=id,symbol,strategy,status,entry_order_id,client_order_id,order_id&limit=1001'
    ),
    database.select(
      'dd_orders',
      'role=eq.ENTRY&or=(state.in.(PENDING,UNKNOWN,NEW,OPEN,PARTIALLY_FILLED),and(state.eq.FILLED,created_at.gte.' +
        recentFilledAfter +
        '))&select=id,client_order_id,strategy,role,state,created_at&limit=1001'
    )
  ]);

  if (!Array.isArray(openPositions) || !Array.isArray(entryOrders)) {
    throw new Error('Position or entry-reservation query returned malformed data');
  }
  if (openPositions.length >= 1001 || entryOrders.length >= 1001) {
    throw new Error('Position or entry-reservation snapshot exceeded its safe row cap; new entries fail closed');
  }

  return Object.fromEntries(keys.map(strategy => [strategy, assessStrategyPositionCap({
    strategy,
    settings,
    openPositions,
    pendingOrders: entryOrders,
    now: nowMs
  })]));
}
