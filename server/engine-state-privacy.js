const hideSignalSizing = rows => (Array.isArray(rows) ? rows : []).map(row => {
  const existing = Array.isArray(row?.blocked_reasons)
    ? row.blocked_reasons.filter(item => typeof item === 'string')
    : String(row?.blocked_reasons || '').split(' · ').filter(Boolean);
  return {
    ...row,
    qty: null,
    quantity: null,
    qty_contracts: null,
    notional: null,
    risk_usd: null,
    ready: false,
    blocked_reasons: [...new Set([...existing, 'Account sizing hidden; enter ENGINE_SECRET'])]
  };
});

export function findWorkerHeartbeatRow(logs) {
  return (Array.isArray(logs) ? logs : []).find(item =>
    String(item?.message || '').startsWith('Worker heartbeat scan')
  ) || null;
}

export function normalizeWorkerExecutionMode(row) {
  const mode = String(row?.data?.executionMode || row?.data?.deltaExecutionMode || '').trim().toLowerCase();
  return ['testnet', 'disabled'].includes(mode) ? mode : 'unknown';
}

function publicHeartbeatRows(logs) {
  const row = findWorkerHeartbeatRow(logs);
  if (!row) return [];
  const mode = normalizeWorkerExecutionMode(row);
  const grid = row?.data?.gridEntrySafety;
  return [{
    id: row.id ?? null,
    level: row.level ?? 'INFO',
    message: 'Worker heartbeat scan',
    created_at: row.created_at ?? null,
    data: {
      executionMode: mode,
      deltaExecutionMode: mode,
      deltaEnvironment: String(row?.data?.deltaEnvironment || '').slice(0, 40) || null,
      lastTickAt: row?.data?.lastTickAt || null,
      gridEntrySafety: grid && typeof grid === 'object' ? {
        configured: grid.configured === true,
        trusted: typeof grid.trusted === 'boolean' ? grid.trusted : null,
        blocked: grid.blocked === true,
        reason: String(grid.reason || '').slice(0, 100) || null
      } : null
    }
  }];
}

/** Hide private account ledgers and sizing unless the engine session is authenticated. */
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
    activity: payload?.activity && typeof payload.activity === 'object'
      ? {
          ...payload.activity,
          lastExecutedTradeAt: null,
          lastExecutedTradeAvailable: false,
          executedTradesTodayCount: null
        }
      : null,
    ledger: [],
    ledgerRowCount: null,
    signals: hideSignalSizing(payload?.signals),
    signalCache: hideSignalSizing(payload?.signalCache),
    optionCache: hideSignalSizing(payload?.optionCache),
    logs: publicHeartbeatRows(payload?.logs),
    executionCoverage: {
      directDeltaExecutionEnabled: false,
      deltaExecutionMode: payload?.executionCoverage?.deltaExecutionMode || 'unknown',
      deltaExecutionModeSource: payload?.executionCoverage?.deltaExecutionModeSource || 'unavailable',
      gridEntrySafety: null
    },
    deltaTestnetPositions: [],
    deltaTestnetOpenPositionCount: null,
    deltaTestnetOrders: [],
    deltaTestnetOrderCount: null,
    deltaTestnetTrades: [],
    deltaTestnetTradeRowCount: null,
    deltaTestnetClosedTodayCount: null,
    deltaTestnetClosedTodayPnl: null,
    deltaTestnetClosedTodayPnlComplete: false,
    deltaTestnetFillSyncState: null,
    deltaTestnetFillCount: null
  };
}
