import React, { useEffect, useMemo, useState } from 'react';
import { safeNum } from './formatters.js';
import { apiUrl } from './api-url.js';
import { calculateAtrGridRange, selectLatestCompletedDailyCandle } from '../shared/grid-auto-range.js';
import { readGridSymbolConfig, resolveGridAtrSnapshot } from './grid-atr-snapshot.js';
import { GRID_BRIDGE_MAX_POSITIONS, GRID_RISK_PER_TRADE_CHOICES, getGridDisplayStatus, normalizeGridRiskPerTradePct } from '../shared/grid-settings.js';

const DEFAULT_GRID_SYMBOLS = Object.freeze(['PAXGUSD', 'NVDAXUSD', 'SPYXUSD', 'XAUTUSD', 'SLVONUSD', 'ADAUSD']);
const n = value => safeNum(value) ?? 0;
const usd = value => {
  const amount = safeNum(value);
  return amount === null ? '—' : '$' + amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const price = value => {
  const amount = safeNum(value);
  return amount !== null && amount > 0 ? amount.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—';
};

function levelsFor(lower, upper, count) {
  const lo = n(lower), hi = n(upper), length = Math.round(n(count));
  if (!(lo > 0 && hi > lo) || length < 8 || length > 12) return [];
  const ratio = Math.pow(hi / lo, 1 / (length - 1));
  const levels = Array.from({ length }, (_, index) => ({
    index,
    price: lo * Math.pow(ratio, index),
    target: index < length - 1 ? lo * Math.pow(ratio, index + 1) : 0
  }));
  levels[length - 1].price = hi;
  return levels;
}
function resolveSymbols(settings, diagnostics, apiSymbols = []) {
  const fromWorker = Array.isArray(diagnostics?.poolSymbols)
    ? diagnostics.poolSymbols.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
    : [];
  if (fromWorker.length) return [...new Set(fromWorker)];
  const fromApi = Array.isArray(apiSymbols)
    ? apiSymbols.map(value => String(value || '').trim().toUpperCase()).filter(Boolean) : [];
  if (fromApi.length) return [...new Set(fromApi)];
  const fromSettings = settings.grid_symbol_configs && typeof settings.grid_symbol_configs === 'object'
    ? Object.keys(settings.grid_symbol_configs).map(value => value.toUpperCase()) : [];
  return fromSettings.length ? [...new Set(fromSettings)] : [...DEFAULT_GRID_SYMBOLS];
}
function parseDraft(settings, symbols, maxConcurrentSymbols = GRID_BRIDGE_MAX_POSITIONS) {
  const saved = settings.grid_symbol_configs && typeof settings.grid_symbol_configs === 'object'
    ? settings.grid_symbol_configs : {};
  const gridSymbolConfigs = Object.fromEntries(symbols.map((symbol, index) => {
    const config = saved[symbol] || {};
    const legacyLower = index === 0 ? settings.grid_lower_price : null;
    const legacyUpper = index === 0 ? settings.grid_upper_price : null;
    const snapshot = resolveGridAtrSnapshot(settings, symbol, config);
    return [symbol, {
      lowerPrice: String(config.lowerPrice ?? config.grid_lower_price ?? legacyLower ?? ''),
      upperPrice: String(config.upperPrice ?? config.grid_upper_price ?? legacyUpper ?? ''),
      levelsCount: Number(config.levelsCount ?? config.grid_levels_count ?? (index === 0 ? settings.grid_levels_count : 10) ?? 10),
      atr: snapshot.atr,
      atrPct: snapshot.atrPct,
      atr_14d: snapshot.atr,
      atr_pct: snapshot.atrPct,
      atrSnapshotStatus: snapshot.status,
      atr_snapshot_status: snapshot.status,
      atrFallback: snapshot.fallback,
      atrSnapshotAt: snapshot.snapshotAt,
      atr_snapshot_at: snapshot.snapshotAt,
      multiplier: config.multiplier ?? 2.5,
      widthPct: config.widthPct ?? null,
      paused: config.paused === true
    }];
  }));
  return {
    gridSymbolConfigs,
    gridMaxPositions: maxConcurrentSymbols,
    gridRiskPerTradePct: normalizeGridRiskPerTradePct(settings.grid_risk_per_trade_pct ?? 0.3),
    gridDailyLossPct: 2,
    gridMomentumPausePct: Number(settings.grid_momentum_pause_pct || 2.5),
    gridReduceAfterLosses: settings.grid_reduce_after_losses !== false
  };
}

export default function GridStrategy({
  settings = {},
  market = [],
  busy = false,
  mutate,
  accountDataProtected = false,
  gridEntrySafety = null,
  executionMode = 'disabled',
  testnetDiagnostics = null,
  apiGridExecutionAllowed = false,
  apiGridTrailingEnvironmentEnabled = false,
  workerGridAutoRangeEnvironmentEnabled = null,
  workerGridAutoRangeHeartbeatFresh = false,
  apiGridSymbols = [],
  apiGridRejectedPoolSymbols = [],
  apiGridMaxConcurrentSymbols = GRID_BRIDGE_MAX_POSITIONS
}) {
  const gridSymbols = useMemo(() =>
    resolveSymbols(settings, testnetDiagnostics, apiGridSymbols),
  [apiGridSymbols.join(','), testnetDiagnostics?.poolSymbols?.join(','), settings.grid_symbol_configs]);
  const rejectedPoolSymbols = (Array.isArray(testnetDiagnostics?.gridRejectedPoolSymbols)
    ? testnetDiagnostics.gridRejectedPoolSymbols
    : Array.isArray(apiGridRejectedPoolSymbols) ? apiGridRejectedPoolSymbols : [])
    .map(value => String(value).toUpperCase());
  const gridExecutableSymbols = gridSymbols.filter(symbol => !rejectedPoolSymbols.includes(symbol));
  const maxConcurrentSymbols = Math.max(1, Math.min(6,
    Number(testnetDiagnostics?.maxConcurrentSymbols ?? apiGridMaxConcurrentSymbols ?? settings.max_grid_positions ?? GRID_BRIDGE_MAX_POSITIONS) || GRID_BRIDGE_MAX_POSITIONS));
  const [draft, setDraft] = useState(() => parseDraft(settings, gridSymbols, maxConcurrentSymbols));
  const [autoRangeBusy, setAutoRangeBusy] = useState(false);
  const [autoRangeMessage, setAutoRangeMessage] = useState('');
  const [autoRangeError, setAutoRangeError] = useState('');
  const gridState = settings.grid_state && typeof settings.grid_state === 'object' ? settings.grid_state : {};
  const positions = Array.isArray(gridState.positions) ? gridState.positions : [];
  const pendingEntries = Array.isArray(gridState.pendingEntries) ? gridState.pendingEntries : [];
  const trades = Array.isArray(gridState.trades) ? [...gridState.trades].reverse() : [];
  const events = Array.isArray(gridState.events) ? [...gridState.events].reverse().slice(0, 12) : [];

  useEffect(() => {
    setDraft(parseDraft(settings, gridSymbols, maxConcurrentSymbols));
  }, [
    settings.grid_symbol_configs, settings.grid_lower_price, settings.grid_upper_price,
    settings.grid_levels_count, settings.grid_max_positions, settings.grid_risk_per_trade_pct,
    settings.grid_daily_loss_pct, settings.grid_momentum_pause_pct, settings.grid_reduce_after_losses,
    gridSymbols.join(','), maxConcurrentSymbols
  ]);

  const views = gridSymbols.map(symbol => {
    const config = draft.gridSymbolConfigs?.[symbol] || { lowerPrice: '', upperPrice: '', levelsCount: 10 };
    const ticker = market.find(row => String(row.symbol || '').toUpperCase() === symbol) || {};
    const currentPrice = n(ticker.mark_price || ticker.price || ticker.close);
    const levels = levelsFor(config.lowerPrice, config.upperPrice, config.levelsCount);
    // Read the database's canonical snake_case fields directly. Keep draft/legacy
    // aliases as fallbacks so the ATR card remains populated during UI edits.
    const savedSymbolConfig = readGridSymbolConfig(settings, symbol);
    const resolvedAtrSnapshot = resolveGridAtrSnapshot(settings, symbol, config);
    const atrSnapshot = {
      ...resolvedAtrSnapshot,
      atr: safeNum(savedSymbolConfig.atr_14d ?? savedSymbolConfig.atr) ??
        safeNum(config.atr_14d ?? config.atr) ?? resolvedAtrSnapshot.atr,
      atrPct: safeNum(savedSymbolConfig.atr_pct ?? savedSymbolConfig.atrPct) ??
        safeNum(config.atr_pct ?? config.atrPct) ?? resolvedAtrSnapshot.atrPct
    };
    const symbolPositions = positions.filter(position => String(position.symbol || '').toUpperCase() === symbol);
    const symbolPending = pendingEntries.filter(order => String(order.symbol || '').toUpperCase() === symbol);
    const persistedSymbolState = gridState.symbolStates?.[symbol] || gridState.symbolSummaries?.[symbol] || {};
    const workerSymbolState = testnetDiagnostics?.symbolStatuses?.[symbol] || {};
    const symbolState = { ...persistedSymbolState, ...workerSymbolState };
    const unavailable = rejectedPoolSymbols.includes(symbol);
    const status = config.paused === true ? 'PAUSED'
      : String(symbolState.status || (unavailable ? 'PENDING' : 'PENDING')).toUpperCase();
    const blockingPosition = symbolState.blockingPosition || symbolState.futuresBlocker || null;
    return {
      symbol, config, atrSnapshot, currentPrice, levels, symbolPositions, symbolPending, symbolState,
      status,
      unavailable,
      blockingPosition,
      valid: levels.length >= 8 && n(config.lowerPrice) > 0 && n(config.upperPrice) > n(config.lowerPrice)
    };
  });

  const openRisk = safeNum(gridState.openRiskUsd);
  const dayStartEquity = safeNum(gridState.dayStartEquity);
  const dailyLossPct = 2;
  const dailyCap = dayStartEquity === null ? null : dayStartEquity * dailyLossPct / 100;
  const realizedGridPnl = safeNum(gridState.realizedPnl);
  const dayPnl = safeNum(gridState.dayPnl);
  const unrealizedPnl = safeNum(gridState.unrealizedPnl);
  const totalDayPnl = dayPnl !== null && unrealizedPnl !== null ? dayPnl + unrealizedPnl : null;
  const currentEquity = safeNum(gridState.currentEquity);
  const drawdownPct = safeNum(gridState.drawdownPct);
  const momentum = gridState.momentum || {};
  const allRangesValid = views.some(view => view.valid && !view.unavailable && view.config.paused !== true);
  const activeSlots = new Set([
    ...positions.map(position => String(position.symbol || '').toUpperCase()),
    ...pendingEntries.map(order => String(order.symbol || '').toUpperCase())
  ]).size;
  const lockedConfig = activeSlots > 0;
  const gridNotMigratedToDelta = gridEntrySafety?.reason === 'GRID_NOT_MIGRATED_TO_DELTA_TESTNET';
  const deltaTestnetGrid = executionMode === 'testnet' ||
    gridEntrySafety?.executionMode === 'testnet' || gridState.executionMode === 'DELTA_TESTNET';
  const gridExecutionAllowed = apiGridExecutionAllowed === true && testnetDiagnostics?.gridExecutionAllowed === true;
  const { label: visibleGridStatus, detail: visibleGridStatusDetail } = getGridDisplayStatus({
    executionMode,
    gridEntrySafety,
    gridState,
    gridEnabled: settings.grid_enabled === true,
    testnetDiagnostics,
    gridExecutionAllowed
  });
  const gridSafetyBlocked = gridEntrySafety?.blocked === true;
  const gridSafetyReason = gridEntrySafety?.reason || 'SNAPSHOT_NOT_VERIFIED';
  const trailingSettingEnabled = settings.grid_trailing_enabled === true;
  const trailingCapabilityEnabled = apiGridTrailingEnvironmentEnabled === true &&
    testnetDiagnostics?.gridTrailingEnvironmentEnabled === true &&
    deltaTestnetGrid && gridExecutionAllowed;
  const trailingActive = trailingSettingEnabled && trailingCapabilityEnabled;
  const workerAutoRangeFlag = typeof workerGridAutoRangeEnvironmentEnabled === 'boolean'
    ? workerGridAutoRangeEnvironmentEnabled
    : typeof testnetDiagnostics?.gridAutoRangeEnvironmentEnabled === 'boolean'
      ? testnetDiagnostics.gridAutoRangeEnvironmentEnabled : null;
  const workerAutoRangeHeartbeatIsFresh = workerGridAutoRangeHeartbeatFresh === true;
  const dailyAutoRangeStatus = !workerAutoRangeHeartbeatIsFresh
    ? 'WORKER HEARTBEAT STALE'
    : workerAutoRangeFlag === true ? 'ENABLED'
      : workerAutoRangeFlag === false ? 'DISABLED' : 'AWAITING WORKER FLAG';
  const lastShiftEvent = events.find(event => event.type === 'SHIFT') || null;
  const lastTrade = trades[0];

  if (accountDataProtected) return <Panel title="Grid Strategy · Protected"><div className="lockedText">Grid position state, exchange orders, symbol ranges and risk locks are private. Enter the configured engine key in Settings before reviewing or changing Grid configuration.</div></Panel>;

  const updateGlobal = (key, value) => setDraft(old => ({ ...old, [key]: value }));
  const updateSymbol = (symbol, key, value) => setDraft(old => ({
    ...old,
    gridSymbolConfigs: {
      ...old.gridSymbolConfigs,
      [symbol]: { ...(old.gridSymbolConfigs?.[symbol] || {}), [key]: value }
    }
  }));
  const payload = {
    gridSymbolConfigs: Object.fromEntries(gridExecutableSymbols.map(symbol => {
      const config = draft.gridSymbolConfigs?.[symbol] || {};
      return [symbol, {
        lowerPrice: Number.isFinite(Number(config.lowerPrice)) ? Number(config.lowerPrice) : null,
        upperPrice: Number.isFinite(Number(config.upperPrice)) ? Number(config.upperPrice) : null,
        levelsCount: Number(config.levelsCount),
        atr: config.atr, atrPct: config.atrPct, atr_14d: config.atr, atr_pct: config.atrPct, multiplier: config.multiplier,
        widthPct: config.widthPct, atrFallback: config.atrFallback === true, atr_snapshot_status: config.atrSnapshotStatus,
        paused: config.paused === true
      }];
    })),
    gridMaxPositions: maxConcurrentSymbols,
    gridRiskPerTradePct: draft.gridRiskPerTradePct,
    gridDailyLossPct: 2,
    gridMomentumPausePct: draft.gridMomentumPausePct,
    gridReduceAfterLosses: draft.gridReduceAfterLosses
  };
  const globalSafetyAllowsStart = settings.emergency_stop !== true && settings.auto_trade === true && settings.enabled === true && settings.continuous_mode !== false;
  const readyToStart = allRangesValid && (!deltaTestnetGrid || gridExecutionAllowed) && globalSafetyAllowsStart;
  const autoSetRangeFromDailyCandles = async () => {
    if (autoRangeBusy || lockedConfig) return;
    setAutoRangeBusy(true);
    setAutoRangeMessage('');
    setAutoRangeError('');
    try {
      const end = Math.floor(Date.now() / 1000);
      const start = end - 20 * 24 * 60 * 60;
      const calculated = await Promise.all(gridExecutableSymbols.map(async symbol => {
        const query = new URLSearchParams({
          type: 'candles',
          resolution: '1d',
          symbol,
          start: String(start),
          end: String(end)
        });
        const response = await fetch(apiUrl('/api/market') + '?' + query.toString(), { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || data?.success !== true || !Array.isArray(data.result)) {
          throw new Error(data?.error || ('Daily candle data unavailable for ' + symbol));
        }
        const candle = selectLatestCompletedDailyCandle(data.result, Date.now());
        if (!candle) throw new Error('No completed previous-UTC-day 1D candle is available for ' + symbol);
        const ticker = market.find(row => String(row.symbol || '').toUpperCase() === symbol) || {};
        const currentPrice = n(ticker.mark_price || ticker.price || ticker.close || candle.close);
        const range = calculateAtrGridRange(data.result, {
          currentPrice, multiplier: 2.5, minRangePct: 2, maxRangePct: 20,
          fallbackCandle: candle, timestamp: Date.now()
        });
        if (!range.ok) throw new Error('ATR range calculation failed for ' + symbol);
        return {
          symbol,
          lowerPrice: String(range.lowerPrice),
          upperPrice: String(range.upperPrice),
          atr: range.atr,
          atrPct: range.atrPct,
          multiplier: range.multiplier,
          widthPct: range.widthPct,
          atrFallback: range.fallback === true, atrSnapshotStatus: range.fallback === true ? 'FALLBACK_3PCT' : 'READY'
        };
      }));
      setDraft(current => ({
        ...current,
        gridSymbolConfigs: {
          ...current.gridSymbolConfigs,
          ...Object.fromEntries(calculated.map(row => [row.symbol, {
            ...(current.gridSymbolConfigs?.[row.symbol] || {}),
            lowerPrice: row.lowerPrice,
            upperPrice: row.upperPrice,
            atr: row.atr, atrPct: row.atrPct, atr_14d: row.atr, atr_pct: row.atrPct, multiplier: row.multiplier,
            widthPct: row.widthPct, atrFallback: row.atrFallback, atrSnapshotStatus: row.atrSnapshotStatus
          }]))
        }
      }));
      setAutoRangeMessage('Daily ranges loaded for ' + calculated.map(row => row.symbol).join(' and ') +
        ' from the previous completed UTC 1D candle. Review the prices, then click Save Configuration to persist them.');
    } catch (error) {
      setAutoRangeError(String(error?.message || 'Could not calculate daily Grid ranges.'));
    } finally {
      setAutoRangeBusy(false);
    }
  };

  const save = () => {
    if (!allRangesValid) return;
    mutate({ ...payload, gridEnabled: settings.grid_enabled === true });
  };
  const start = () => {
    if (!readyToStart || settings.grid_enabled === true || gridState.pausedReason || gridSafetyBlocked) return;
    mutate({ ...payload, gridEnabled: true });
  };
  const pause = () => {
    if (window.confirm('Pause new Grid entries across the symbol pool? Existing positions remain protected by their exchange-side SL/TP.')) {
      mutate({ gridEnabled: false });
    }
  };
  const reset = () => {
    if (window.confirm('Reset Grid state? This does not trigger the global Emergency Stop.')) {
      mutate({ gridReset: true });
    }
  };

  return <>
    <section className="cards">
      <div className="card"><small>GRID STRATEGY STATUS</small><strong>{visibleGridStatus}</strong><span>{visibleGridStatusDetail}</span></div>
      <div className="card"><small>CONFIGURED TESTNET SYMBOL POOL</small><strong>{gridSymbols.length} symbols · {gridExecutableSymbols.length} allowlisted</strong><span>{gridSymbols.join(' · ')} · Each Grid symbol has an independent range and Independent exchange-side SL/TP protection. Unavailable symbols are visible but never routed.</span></div>
      <div className="card"><small>OPEN GRID SYMBOLS</small><strong>{activeSlots} / {maxConcurrentSymbols}</strong><span>{positions.length} open position(s) · {pendingEntries.length} pending limit entry(ies) · {usd(openRisk === null && positions.length === 0 ? 0 : openRisk)} estimated open risk.</span></div>
      <div className="card"><small>{deltaTestnetGrid ? 'DELTA TESTNET NET P&L' : 'SIMULATED GRID P&amp;L'}</small><strong className={realizedGridPnl === null ? 'muted' : realizedGridPnl >= 0 ? 'up' : 'down'}>{usd(realizedGridPnl)}</strong><span>{deltaTestnetGrid ? 'Only fully fill-matched trades with verified commissions; otherwise P&L is unverified.' : 'Offline estimate after estimated fees and slippage; not exchange-reported P&amp;L.'}</span></div>
      <div className="card"><small>DAY PNL</small><strong className={totalDayPnl === null ? 'muted' : totalDayPnl >= 0 ? 'up' : 'down'}>{usd(totalDayPnl)}</strong><span>Realized + combined mark-to-market · daily stop fixed at 2.0%.</span></div>
      <div className="card"><small>STRATEGY EQUITY</small><strong>{usd(currentEquity)}</strong><span>Delta Testnet account equity at Grid start · drawdown {drawdownPct === null ? 'NO DATA' : drawdownPct.toFixed(2) + '%'} · hard stop 5%.</span></div>
      <div className="card"><small>EXECUTION GATE</small><strong>{deltaTestnetGrid ? (gridExecutionAllowed ? 'TESTNET LIMIT ORDERS ENABLED' : 'TESTNET ORDERS LOCKED') : 'SIMULATOR'}</strong><span>{deltaTestnetGrid ? (gridExecutionAllowed ? 'Runtime opt-in verified. Entries still require fresh market data, an available Testnet product, global safety checks and a free symbol slot.' : 'Set GRID_EXECUTION_ALLOWED=true in the Delta TESTNET worker and API environments. The default is false.') : 'Offline simulator; no exchange orders are sent.'}</span></div>
      <div className="card"><small>TRAILING GRID</small><strong>{trailingActive ? 'GRID TRAILING ACTIVE' : trailingSettingEnabled ? 'ENVIRONMENT GATE OFF' : 'DISABLED'}</strong><span>{trailingActive ? 'Breakouts close all Grid exposure at market, cancel pending Grid entries, shift the breached symbol range by 10%, and resume on the next verified tick.' : 'Requires the dashboard toggle plus GRID_TRAILING_ENABLED=true in both API and Worker runtimes.'}{lastShiftEvent ? ' Last shift: ' + lastShiftEvent.direction + ' · ' + (lastShiftEvent.at ? new Date(lastShiftEvent.at).toLocaleString('en-IN') : 'time unavailable') + '.' : ''}</span></div>
    </section>

    <Panel title={"Grid Configuration · Dynamic Symbol Pool (" + gridSymbols.length + ")"}>
      <div className="gridButtons">
        <button className="action" disabled={busy || autoRangeBusy || lockedConfig} onClick={autoSetRangeFromDailyCandles}>
          {autoRangeBusy ? 'Fetching Daily High / Low…' : 'Auto-Set ATR Range (14d)'}
        </button>
      </div>
      <div className="lockedText">Uses 14 completed daily candles for ATR, a 2.5x multiplier, and a 2%–20% clamped range. Fewer than 14 candles falls back to the legacy 3% buffer. This fills the draft; click Save Configuration to persist.</div>
      {autoRangeMessage ? <div className="statusLine">{autoRangeMessage}</div> : null}
      {autoRangeError ? <div className="errorText">{autoRangeError}</div> : null}
      <div className="grid2">
        {views.map(view => <div className="card" key={view.symbol}>
          <div className="gridMeta">
            <strong>{view.symbol}</strong>
            <span className={view.status === 'ACTIVE' ? 'up' : view.status === 'SKIPPED' ? 'warn' : 'muted'}>{view.unavailable ? 'PENDING · NOT ALLOWLISTED' : view.config.paused ? 'PAUSED' : view.status}</span>
          </div>
          {view.blockingPosition ? <span className="warn">Futures blocker: {view.blockingPosition.strategy || 'FUTURES'} · position #{view.blockingPosition.id ?? '—'} · order #{view.blockingPosition.orderId ?? '—'}</span> : null}
          {view.unavailable ? <span className="lockedText">Not present in the current Delta Testnet execution allowlist. It remains visible in the requested pool but cannot receive Grid orders.</span> : null}
          <span>Current public mark: {view.currentPrice > 0 ? price(view.currentPrice) : 'Waiting for market price'}</span>
          <div className="gridConfig">
            <label>{view.symbol} Lower Price<input type="number" inputMode="decimal" min="0" step="any" placeholder="Set lower boundary" value={view.config.lowerPrice} onChange={event => updateSymbol(view.symbol, 'lowerPrice', event.target.value)} disabled={lockedConfig}/></label>
            <label>{view.symbol} Upper Price<input type="number" inputMode="decimal" min="0" step="any" placeholder="Set upper boundary" value={view.config.upperPrice} onChange={event => updateSymbol(view.symbol, 'upperPrice', event.target.value)} disabled={lockedConfig}/></label>
            <label>{view.symbol} Grid Levels<select value={view.config.levelsCount} onChange={event => updateSymbol(view.symbol, 'levelsCount', Number(event.target.value))} disabled={lockedConfig}>{[8,9,10,11,12].map(value => <option key={value} value={value}>{value} levels</option>)}</select></label>
          </div>
          <span>{view.valid ? view.levels.length + ' geometric levels · ' + (((Math.pow(n(view.config.upperPrice) / n(view.config.lowerPrice), 1 / Math.max(1, view.levels.length - 1))) - 1) * 100).toFixed(3) + '% per step' : 'Range not configured · upper must exceed lower'}</span>
          <span>14d ATR: {view.atrSnapshot.atr !== null ? usd(view.atrSnapshot.atr) + ' (' + (view.atrSnapshot.atrPct === null ? 'ATR% unavailable' : view.atrSnapshot.atrPct.toFixed(2) + '%') + ')' : view.atrSnapshot.fallback ? 'Insufficient daily candles · 3% fallback active' : view.atrSnapshot.status === 'READY' ? 'Snapshot marked READY · numeric ATR unavailable' : 'Awaiting worker ATR snapshot'}</span>
          <span>Calculated Range: {price(view.config.lowerPrice)} - {price(view.config.upperPrice)} (Width: {view.config.widthPct ? n(view.config.widthPct).toFixed(2) : ((n(view.config.upperPrice)-n(view.config.lowerPrice))/Math.max(1,n(view.currentPrice))*100).toFixed(2)}%)</span>
          <span>Multiplier: {n(view.config.multiplier || 2.5).toFixed(1)}x {view.config.atrFallback ? '· 3% fallback active' : ''}</span>
          <span>{view.symbolPositions.length} open position(s) · {view.symbolPending.length} pending limit entry(ies)</span>
          {view.symbolState.pausedReason ? <span className="down">Status: {view.symbolState.pausedReason}</span> : null}
        </div>)}
      </div>
      <div className="gridConfig">
        <label>Maximum Concurrent Grid Symbols<select value={maxConcurrentSymbols} disabled><option value={maxConcurrentSymbols}>{maxConcurrentSymbols} active symbol(s) · env controlled</option></select></label>
        <label>Target Risk / Trade<select value={draft.gridRiskPerTradePct} onChange={event => updateGlobal('gridRiskPerTradePct', Number(event.target.value))}>{GRID_RISK_PER_TRADE_CHOICES.map(value => <option key={value} value={value}>{value.toFixed(2)}%{value === 0.3 ? ' · conservative default' : ' target'}</option>)}</select></label>
        <label>Daily Loss Limit<select value={2} disabled><option value={2}>2.0% · fixed safety limit</option></select></label>
        <label>Momentum Pause<select value={draft.gridMomentumPausePct} onChange={event => updateGlobal('gridMomentumPausePct', Number(event.target.value))}><option value={2.5}>2.5% one-way move</option><option value={2.75}>2.75% one-way move</option><option value={3}>3.0% one-way move</option></select></label>
      </div>
      <label className="gridCheck"><input type="checkbox" checked={draft.gridReduceAfterLosses} onChange={event => updateGlobal('gridReduceAfterLosses', event.target.checked)}/> Reduce position sizing by 50% after 2 consecutive losses</label>
      <label className="gridCheck"><input type="checkbox" checked={trailingSettingEnabled} disabled={busy || (!trailingCapabilityEnabled && !trailingSettingEnabled)} onChange={event => mutate({ gridTrailingEnabled: event.target.checked })}/> Trailing Grid (Auto-Shift on Breakout)</label>
      {!trailingCapabilityEnabled ? <div className="lockedText">Trailing Grid is unavailable until GRID_TRAILING_ENABLED=true is present in both the API and Worker environments and the worker heartbeat confirms it. The 2% daily-loss and 5% drawdown stops remain absolute.</div> : null}
      <div className="lockedText">Daily Auto-Range environment: {dailyAutoRangeStatus} · Worker-reported flag: {workerAutoRangeFlag === null ? 'not available' : String(workerAutoRangeFlag)} · Worker auto-refresh: {dailyAutoRangeStatus === 'ENABLED' ? (trailingCapabilityEnabled && trailingSettingEnabled ? 'awaiting next UTC day; each symbol range refreshes independently when that symbol is flat' : 'startup snapshot refresh is active; daily range rollover still requires Trailing Grid and its Worker gate') : dailyAutoRangeStatus === 'DISABLED' ? 'Worker heartbeat confirms GRID_AUTO_RANGE_ENABLED=false; automatic updates are off' : 'waiting for a fresh Worker heartbeat that includes the GRID_AUTO_RANGE_ENABLED diagnostic'}{gridState.autoRangeLastAppliedUtcDay ? ' · last applied UTC day: ' + gridState.autoRangeLastAppliedUtcDay : ''}</div>

      <div className="gridButtons">
        {gridSafetyBlocked ? <div className="errorText">Grid entries are blocked by worker safety ({gridSafetyReason}). Review the latest heartbeat and exchange position reconciliation before restarting. Existing positions remain protected by exchange-side SL/TP.</div> : null}
        <button className="action" disabled={busy || !allRangesValid || lockedConfig} onClick={save}>Save Configuration</button>
        <button className="action gridStart" disabled={busy || !readyToStart || settings.grid_enabled === true || !!gridState.pausedReason || gridSafetyBlocked || gridNotMigratedToDelta || !globalSafetyAllowsStart} onClick={start}>{deltaTestnetGrid ? (gridExecutionAllowed ? 'Start Grid (Delta Testnet)' : 'Testnet Execution Disabled') : 'Start Grid (Simulator)'}</button>
        <button className="action" title="New entries stop. Existing positions remain protected by exchange-side SL/TP." disabled={busy || settings.grid_enabled !== true} onClick={pause}>Pause Grid (Exit Only)</button>
        <button className="dangerBtn" title="Resets Grid state. Does NOT trigger global Emergency Stop." disabled={busy || lockedConfig || !gridState.pausedReason || settings.emergency_stop === true || ['DAILY_LOSS_LIMIT','OVERALL_DRAWDOWN_STOP'].includes(gridState.pausedReason)} onClick={reset}>Reset Grid State</button>
      </div>
      {!globalSafetyAllowsStart ? <div className="errorText">Grid cannot start while global E-STOP is active, Auto Trade is off, or the engine is disabled. Existing exchange-side brackets remain in place.</div> : null}
      {!allRangesValid ? <div className="errorText">Configure at least one allowlisted pool symbol with a valid range and 8–12 levels before starting. Other symbols can remain PENDING until their ATR/range data is ready.</div> : null}
      {lockedConfig ? <div className="lockedText">Symbol ranges are locked while an exchange position or pending entry exists. Let exchange-side SL/TP complete the position or close it before changing ranges.</div> : null}
      {gridState.pausedReason === 'DAILY_LOSS_LIMIT' ? <div className="errorText">The shared 2% daily-loss guard is active. It cannot be reset during the same India trading day.</div> : null}
      {gridState.pausedReason === 'OVERALL_DRAWDOWN_STOP' ? <div className="errorText">The shared 5% overall drawdown stop is terminal for this Grid run. Keep this run halted; do not reset its capital baseline to resume.</div> : null}
      <div className="lockedText"><b>Risk controls:</b> shared 2% daily-loss cap, 5% strategy drawdown stop, global 1.2% full-range break, per-symbol trailing shift and a {maxConcurrentSymbols}-symbol concurrency cap. Risk is aggregated across active Grid symbols. Actual quantities round down to whole contracts; if minimum size exceeds the risk budget, that entry is skipped.</div>
    </Panel>

    <Panel title="Pool Handoff Status">
      <div className="tablewrap">
        <table className="gridLevelsTable">
          <thead><tr><th>SYMBOL</th><th>STATUS</th><th>ATR</th><th>24H TURNOVER</th><th>SPREAD</th><th>FUTURES BLOCKER</th></tr></thead>
          <tbody>
            {views.map(view => <tr key={view.symbol}>
              <td>{view.symbol}</td>
              <td className={view.status === 'ACTIVE' ? 'up' : view.status === 'SKIPPED' ? 'warn' : 'muted'}>{view.unavailable ? 'PENDING' : view.config.paused ? 'PAUSED' : view.status}</td>
              <td>{view.atrSnapshot.status === 'READY' ? 'READY' : view.atrSnapshot.status || 'PENDING'}</td>
              <td>{view.symbolState.turnover24hUsd ? usd(view.symbolState.turnover24hUsd) : '—'}</td>
              <td>{Number.isFinite(Number(view.symbolState.spreadPct)) ? Number(view.symbolState.spreadPct).toFixed(3) + '%' : '—'}</td>
              <td>{view.blockingPosition ? (view.blockingPosition.strategy || 'FUTURES') + ' · pos ' + (view.blockingPosition.id ?? '—') + ' · order ' + (view.blockingPosition.orderId ?? '—') : '—'}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <div className="lockedText">Selection order: ATR READY first, then highest 24-hour turnover, then tightest spread. Futures-owned symbols are skipped and re-evaluated on every Grid cycle.</div>
    </Panel>
    <Panel title="Grid Levels and Open Positions · Per Pool Symbol">
      {views.map(view => {
        const targetLevelSet = new Set(view.symbolPositions.map(position => Number(position.levelIndex) + 1));
        return <div key={view.symbol} className="gridSymbolPanel">
          <div className="gridMeta">
            <b>{view.symbol}</b>
            <span>Mark: <b>{view.currentPrice > 0 ? price(view.currentPrice) : '—'}</b></span>
            <span>Upper break: <b>{n(view.config.upperPrice) > 0 ? price(n(view.config.upperPrice) * 1.012) : '—'}</b> (+1.2%)</span>
            <span>Lower break: <b>{n(view.config.lowerPrice) > 0 ? price(n(view.config.lowerPrice) * 0.988) : '—'}</b> (−1.2%)</span>
          </div>
          {view.levels.length ? <div className="tablewrap"><table className="gridLevelsTable"><thead><tr><th>LEVEL</th><th>PRICE</th><th>LIMIT ENTRY</th><th>NEXT TARGET</th><th>STATUS</th></tr></thead><tbody>
            {[...view.levels].reverse().map(level => {
              const position = view.symbolPositions.find(item => Number(item.levelIndex) === level.index);
              const target = targetLevelSet.has(level.index);
              const status = position ? 'POSITION OPEN' : target ? 'EXIT TARGET' : level.index === view.levels.length - 1 ? 'TOP · NO ENTRY' : (view.currentPrice > 0 && Math.abs(view.currentPrice - level.price) / level.price < 0.001 ? 'NEAR PRICE' : 'AVAILABLE');
              return <tr key={level.index}><td>G{String(level.index + 1).padStart(2,'0')}</td><td>{price(level.price)}</td><td>{level.index < view.levels.length - 1 ? (deltaTestnetGrid && gridExecutionAllowed ? 'LIMIT BUY + BRACKET' : 'LOCKED · NO ORDER') : '—'}</td><td>{level.target > 0 ? price(level.target) : '—'}</td><td className={position ? 'warn' : target ? 'up' : 'muted'}>{status}{position ? ' · ' + (safeNum(position.qty) === null ? 'QTY NO DATA' : safeNum(position.qty) + ' qty') : ''}</td></tr>;
            })}
          </tbody></table></div> : <div className="lockedText">Configure a valid range for {view.symbol} to see its levels.</div>}
          {view.symbolPositions.length ? <div className="tablewrap"><table className="gridLevelsTable"><thead><tr><th>OPEN LEVEL</th><th>ENTRY</th><th>SL</th><th>TP</th><th>QTY</th><th>RISK</th></tr></thead><tbody>
            {view.symbolPositions.map(position => <tr key={position.id}><td>G{Number(position.levelIndex)+1}</td><td>{price(position.entryPrice)}</td><td>{price(position.stopPrice)}</td><td>{price(position.targetPrice)}</td><td>{safeNum(position.qty) === null ? '—' : safeNum(position.qty)}</td><td>{usd(position.riskUsd)}</td></tr>)}
          </tbody></table></div> : <div className="lockedText">No open {view.symbol} Grid position.</div>}
          {view.symbolPending.length ? <div className="statusLine">{view.symbolPending.length} pending bracket-protected limit entry(ies); duplicate submissions are blocked while the exchange order is unresolved.</div> : null}
          {!view.unavailable ? <label className="gridCheck"><input type="checkbox" checked={view.config.paused === true} onChange={event => updateSymbol(view.symbol, 'paused', event.target.checked)} disabled={lockedConfig}/> Manual pause {view.symbol}; Futures auto-skip still operates independently</label> : null}
          {view.status === 'SKIPPED' && view.blockingPosition ? <span className="warn">Automatic handoff is enabled: this symbol is re-checked every cycle and re-enters the candidate pool after the Futures position closes.</span> : null}
          {view.status === 'PENDING' ? <span className="muted">Waiting for verified ATR, range, Testnet product, or fresh market data.</span> : null}
        </div>;
      })}
    </Panel>

    <div className="grid2">
      <Panel title="Combined Risk Locks & Last Events">
        <div className="gridLockRow"><b>Daily loss</b><span>{dayPnl === null ? 'NO DATA' : usd(Math.max(0, -dayPnl))} / {usd(dailyCap)}</span></div>
        <div className="gridLockRow"><b>Open risk</b><span>{usd(openRisk === null && positions.length === 0 ? 0 : openRisk)}</span></div>
        <div className="gridLockRow"><b>Drawdown</b><span>{drawdownPct === null ? 'NO DATA' : drawdownPct.toFixed(2) + '%'} / 5.00%</span></div>
        <div className="gridLockRow"><b>Hard-stop reason</b><span className={gridState.pausedReason ? 'down' : 'up'}>{gridState.pausedReason || 'None'}</span></div>
        <div className="gridEvents">{events.length ? events.map((event, index) => <div key={String(event.at) + String(event.symbol || '') + index}><small>{event.at ? new Date(event.at).toLocaleTimeString('en-IN') : '—'}</small><b>{event.symbol || 'GRID'} · {event.type || 'INFO'}</b><span>{event.type === 'SHIFT' ? 'Shifted Grid ' + (event.direction || '—') + ' · new range ' + price(event.newLowerPrice) + '–' + price(event.newUpperPrice) + ' · realized P&L pending verified Delta ledger' : event.reason || (event.type === 'ENTRY' ? 'Entry' : event.type === 'EXIT' ? 'Exit' : 'Grid update')}{event.levelIndex != null ? ' · G' + (Number(event.levelIndex)+1) : ''}{event.price ? ' · ' + price(event.price) : ''}{event.pnl != null ? ' · ' + usd(event.pnl) : ''}</span></div>) : <span>No Grid events yet.</span>}</div>
      </Panel>
      <Panel title="Recent Verified Grid Trades">
        {trades.length ? <div className="tablewrap"><table className="gridLevelsTable"><thead><tr><th>SYMBOL</th><th>CLOSED</th><th>LEVEL</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>NET PNL</th><th>REASON</th></tr></thead><tbody>{trades.slice(0,20).map((trade,index) => <tr key={trade.id || trade.executionId || index}><td>{trade.symbol || '—'}</td><td>{trade.closedAt ? new Date(trade.closedAt).toLocaleString('en-IN') : '—'}</td><td>G{Number(trade.levelIndex)+1}</td><td>{price(trade.entryPrice)}</td><td>{price(trade.exitPrice)}</td><td>{safeNum(trade.qty) === null ? '—' : safeNum(trade.qty)}</td><td className={safeNum(trade.netPnl) === null ? 'muted' : safeNum(trade.netPnl) >= 0 ? 'up' : 'down'}>{usd(trade.netPnl)}</td><td>{trade.reason}</td></tr>)}</tbody></table></div> : <div className="lockedText">No completed Grid trades yet.</div>}
        {lastTrade ? <div className="statusLine">Last trade: {lastTrade.symbol} · {lastTrade.reason} · net {usd(lastTrade.netPnl)}</div> : null}
      </Panel>
    </div>
    <div className="gridTestNotice">{deltaTestnetGrid
      ? 'DELTA TESTNET GRID: ' + (gridExecutionAllowed ? 'Bracket-protected GTC limit entries are enabled only for the two configured allowlisted symbols. Independent exchange-side SL/TP applies to each active symbol; the 2% daily loss and 5% drawdown guards are shared across both.' : 'Read-only until GRID_EXECUTION_ALLOWED=true in the explicit Testnet profile. No orders are submitted while the opt-in is false.')
      : 'GRID SAFETY: This is an offline simulator, not a direct Delta Testnet order engine. Do not treat simulated P&L as exchange P&L.'}</div>
  </>;
}

function Panel({ title, children }) {
  return <section className="panel"><div className="panelTitle"><h2>{title}</h2></div><div className="pad">{children}</div></section>;
}
