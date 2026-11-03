export const GRID_MAX_POSITION_CHOICES = Object.freeze([1, 3, 4]);
export const GRID_BRIDGE_MAX_POSITIONS = 1;
export const GRID_RISK_PER_TRADE_CHOICES = Object.freeze([0.3, 0.5, 0.75, 1]);
export const GRID_DAILY_LOSS_CHOICES = Object.freeze([2, 2.25, 2.5]);
export const GRID_MOMENTUM_PAUSE_CHOICES = Object.freeze([2.5, 2.75, 3]);

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
  testnetDiagnostics = null
} = {}) {
  const state = gridState && typeof gridState === 'object' ? gridState : {};
  const stateStatus = String(state.status || (gridEnabled ? 'ACTIVE' : 'OFF')).toUpperCase();
  const pausedReason = typeof state.pausedReason === 'string' ? state.pausedReason.trim() : '';
  const deltaTestnetGrid = executionMode === 'testnet' ||
    gridEntrySafety?.executionMode === 'testnet' || state.executionMode === 'DELTA_TESTNET';
  const gridNotMigratedToDelta = gridEntrySafety?.reason === 'GRID_NOT_MIGRATED_TO_DELTA_TESTNET';

  if (deltaTestnetGrid) {
    if (pausedReason || stateStatus === 'HALTED') {
      const reason = pausedReason ? ': ' + pausedReason.replaceAll('_', ' ') : '';
      return {
        label: 'DIAGNOSTICS ACTIVE · GRID HALTED',
        detail: 'Diagnostic market evaluation continues in dry-run mode. Persisted Grid strategy is halted' +
          reason + '. Testnet order routing remains locked; no exchange orders or reservations are created.'
      };
    }

    if (stateStatus === 'MOMENTUM_PAUSE') {
      return {
        label: 'DIAGNOSTICS ACTIVE · MOMENTUM PAUSED',
        detail: 'Diagnostic market evaluation continues in dry-run mode. Grid entries are paused by the momentum filter; Testnet order routing remains locked.'
      };
    }

    if (!gridEnabled || stateStatus === 'OFF') {
      return {
        label: 'DIAGNOSTICS ACTIVE · GRID OFF',
        detail: 'The diagnostic worker may inspect market data, but the persisted Grid strategy is off. Testnet order routing remains locked.'
      };
    }

    if (testnetDiagnostics?.testnetProductAvailable !== true) {
      return {
        label: 'DIAGNOSTICS ACTIVE · WAITING FOR TESTNET PRODUCTS',
        detail: 'Grid market data is evaluated in an isolated dry run. The selected instrument has no verified Testnet product; no exchange orders or positions are created.'
      };
    }

    return {
      label: 'DIAGNOSTICS ACTIVE · ORDERS LOCKED',
      detail: 'Grid diagnostics are active in dry-run mode. A verified product alone does not enable Grid execution; order routing remains locked pending a reviewed execution lifecycle.'
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
