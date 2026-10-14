const cleanSymbols = value => Array.isArray(value)
  ? [...new Set(value.map(item => String(item ?? '').trim().toUpperCase()).filter(Boolean))]
  : [];

const finiteNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function hideSignalSizing(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const existing = Array.isArray(row?.blocked_reasons)
      ? row.blocked_reasons.filter(item => typeof item === 'string')
      : String(row?.blocked_reasons || '').split(' · ').filter(Boolean);
    const reason = 'Account sizing hidden; enter ENGINE_SECRET';
    return {
      ...row,
      qty: null,
      quantity: null,
      qty_contracts: null,
      notional: null,
      risk_usd: null,
      ready: false,
      blocked_reasons: [...new Set([...existing, reason])]
    };
  });
}

function publicHeartbeatRows(logs) {
  const rows = Array.isArray(logs) ? logs : [];
  return rows
    .filter(row => row?.message === 'Worker heartbeat scan' && row?.data?.tradetronRouting)
    .slice(0, 1)
    .map(row => {
      const routing = row.data.tradetronRouting || {};
      return {
        id: row.id ?? null,
        level: row.level ?? 'INFO',
        message: 'Worker heartbeat scan',
        created_at: row.created_at ?? null,
        data: {
          tradetronRouting: {
            supportedSymbols: cleanSymbols(routing.supportedSymbols),
            configuredSymbols: cleanSymbols(routing.configuredSymbols),
            unavailableMarketSymbols: cleanSymbols(routing.unavailableMarketSymbols),
            marketSymbolCount: finiteNumber(routing.marketSymbolCount),
            configuredRoutes: finiteNumber(routing.configuredRoutes),
            optionsRouteConfigured: routing.optionsRouteConfigured === true
          },
          reservedSignals: finiteNumber(row.data.reservedSignals),
          signalReservationTtlMs: finiteNumber(row.data.signalReservationTtlMs),
          tradetronEntrySafety: row.data.tradetronEntrySafety && typeof row.data.tradetronEntrySafety === 'object'
            ? {
                configured: row.data.tradetronEntrySafety.configured === true,
                trusted: typeof row.data.tradetronEntrySafety.trusted === 'boolean'
                  ? row.data.tradetronEntrySafety.trusted : null,
                reason: String(row.data.tradetronEntrySafety.reason || '').slice(0, 100) || null,
                lastSuccessAt: row.data.tradetronEntrySafety.lastSuccessAt || null,
                ageMs: finiteNumber(row.data.tradetronEntrySafety.ageMs)
              }
            : null,
          gridEntrySafety: row.data.gridEntrySafety && typeof row.data.gridEntrySafety === 'object'
            ? {
                configured: row.data.gridEntrySafety.configured === true,
                trusted: typeof row.data.gridEntrySafety.trusted === 'boolean'
                  ? row.data.gridEntrySafety.trusted : null,
                blocked: row.data.gridEntrySafety.blocked === true,
                reason: String(row.data.gridEntrySafety.reason || '').slice(0, 100) || null
              }
            : null
        }
      };
    });
}

/**
 * Keep public market/signal information available, but never serialize private
 * account ledgers or balance/position details without the configured engine
 * secret. Empty redacted arrays must be accompanied by accountDataProtected.
 */
export function protectEngineState(payload, authorized) {
  const state = { ...payload, accountDataProtected: !authorized };
  if (authorized) return state;

  const settings = payload?.settings && typeof payload.settings === 'object'
    ? {
        ...payload.settings,
        equity: null,
        available_balance: null,
        realized_pnl: null,
        unrealized_pnl: null,
        fees_today: null,
        grid_state: null
      }
    : null;

  return {
    ...state,
    settings,
    positions: [],
    trades: [],
    ledger: [],
    counters: null,
    daily: null,
    signalOrders: [],
    signalOrderCount: null,
    tradeRowCount: null,
    ledgerRowCount: null,
    signals: hideSignalSizing(payload.signals),
    signalCache: hideSignalSizing(payload.signalCache),
    optionCache: hideSignalSizing(payload.optionCache),
    signalOrderStats: {
      total: null,
      sent: null,
      pending: null,
      expired: null,
      failed: null,
      events: null
    },
    tradetronEvents: [],
    logs: publicHeartbeatRows(payload?.logs),
    tradetronDeveloperDataProtected: true,
    tradetronDeveloperSync: null,
    tradetronDeveloperSnapshots: [],
    tradetronDeveloperNotificationSync: null,
    tradetronDeveloperNotifications: [],
    tradetronDeveloperPnlHistory: []
  };
}
