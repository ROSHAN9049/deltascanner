export const GRID_MAX_POSITION_CHOICES = Object.freeze([2]);
export const GRID_BRIDGE_MAX_POSITIONS = 2;
export const GRID_RISK_PER_TRADE_CHOICES = Object.freeze([0.3, 0.5, 0.75, 1]);
export const GRID_DAILY_LOSS_CHOICES = Object.freeze([2]);
export const GRID_MOMENTUM_PAUSE_CHOICES = Object.freeze([2.5, 2.75, 3]);

/**
 * Resolve active Grid symbols from the fixed Testnet allowlist and persisted
 * per-symbol settings. A paused symbol remains in grid_symbol_configs; it is
 * merely omitted from the worker's active execution set.
 */
export function resolveActiveGridSymbols(configuredSymbols = [], gridSymbolConfigs = {}) {
  let configs = gridSymbolConfigs;
  if (typeof configs === 'string') {
    try { configs = JSON.parse(configs); } catch { return []; }
  }
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) configs = {};
  return [...new Set((Array.isArray(configuredSymbols) ? configuredSymbols : [])
    .map(symbol => String(symbol || '').trim().toUpperCase())
    .filter(Boolean))]
    .filter(symbol => configs[symbol]?.paused !== true);
}

export function isAllowedGridRiskPerTradePct(value) {
  const number = Number(value);
  return Number.isFinite(number) && GRID_RISK_PER_TRADE_CHOICES.includes(number);
}

/** Map legacy values to the nearest supported UI setting instead of an empty select. */
export function normalizeGridRiskPerTradePct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return GRID_RISK_PER_TRADE_CHOICES[0];
  return GRID_RISK_PER_TRADE_CHOICES.reduce((nearest, candidate) =>
    Math.abs(candidate - number) < Math.abs(nearest - number) ? candidate : nearest
  , GRID_RISK_PER_TRADE_CHOICES[0]);
}


/**
 * Keep the diagnostic worker state separate from the persisted Grid strategy state.
 * In Testnet diagnostic mode, the worker may keep evaluating market data while the
 * actual Grid strategy remains halted/off and all order routing stays locked.
 */
export function getGridDisplayStatus({
  executionMode = 'disabled',
  gridEntrySafety = null,
  gridState = {},
  gridEnabled = false,
  testnetDiagnostics = null,
  gridExecutionAllowed = false
} = {}) {
  const state = gridState && typeof gridState === 'object' ? gridState : {};
  const stateStatus = String(state.status || (gridEnabled ? 'ACTIVE' : 'OFF')).toUpperCase();
  const pausedReason = typeof state.pausedReason === 'string' ? state.pausedReason.trim() : '';
  const deltaTestnetGrid = executionMode === 'testnet' ||
    gridEntrySafety?.executionMode === 'testnet' || state.executionMode === 'DELTA_TESTNET';
  const gridNotMigratedToDelta = gridEntrySafety?.reason === 'GRID_NOT_MIGRATED_TO_DELTA_TESTNET';
  const executionGateOpen = gridExecutionAllowed === true ||
    testnetDiagnostics?.gridExecutionAllowed === true;

  if (deltaTestnetGrid) {
    if (!executionGateOpen) {
      return {
        label: 'TESTNET GRID · EXECUTION DISABLED',
        detail: 'Grid market data can be inspected, but order routing is off. GRID_EXECUTION_ALLOWED must be true in the explicit Delta TESTNET profile; no exchange orders are submitted.'
      };
    }

    if (pausedReason || stateStatus === 'HALTED') {
      const reason = pausedReason ? ': ' + pausedReason.replaceAll('_', ' ') : '';
      return {
        label: 'TESTNET GRID · HALTED',
        detail: 'Grid execution is opted in for Delta Testnet, but the strategy is halted' +
          reason + '. Existing exchange-side SL/TP remains authoritative; no new entries are allowed.'
      };
    }

    if (stateStatus === 'MOMENTUM_PAUSE') {
      return {
        label: 'TESTNET GRID · MOMENTUM PAUSED',
        detail: 'New Grid entries are paused by the momentum filter. Existing exchange-side SL/TP protection remains active.'
      };
    }

    if (stateStatus === 'ENTRY_PENDING') {
      return {
        label: 'TESTNET GRID · LIMIT ENTRY PENDING',
        detail: 'A bracket-protected Testnet limit entry is awaiting exchange fill confirmation; the symbol remains reserved and will not be blindly retried.'
      };
    }

    if (!gridEnabled || stateStatus === 'OFF') {
      return {
        label: 'TESTNET GRID · GRID OFF',
        detail: 'Testnet execution is permitted by configuration, but the Grid strategy is off. Starting still requires at least one non-paused allowlisted pool symbol with a valid range and all worker safety checks; other pool symbols may remain pending.'
      };
    }

    if (testnetDiagnostics?.executionLocked === true) {
      return {
        label: 'TESTNET GRID · SAFETY BLOCKED',
        detail: 'A Testnet execution or reconciliation check is blocking new entries. Review the worker heartbeat and symbol-specific reason before restarting.'
      };
    }

    return {
      label: 'TESTNET GRID · ACTIVE',
      detail: 'Dynamic Testnet Grid is running with up to six allowlisted pool symbols and independent exchange-side SL/TP per active symbol, automatic Futures handoff, and shared daily-loss and 5% drawdown controls.'
    };
  }

  if (gridNotMigratedToDelta) {
    return {
      label: 'HELD · NOT MIGRATED',
      detail: 'Grid has not been migrated to the Delta Testnet execution model. Offline simulator only; no exchange orders are sent.'
    };
  }

  return {
    label: stateStatus.replaceAll('_', ' '),
    detail: 'Offline simulator only; not an exchange order engine.'
  };
}
