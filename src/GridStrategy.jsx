import React, { useEffect, useMemo, useState } from 'react';
import { safeNum } from './formatters.js';
import { GRID_BRIDGE_MAX_POSITIONS, GRID_RISK_PER_TRADE_CHOICES, getGridDisplayStatus, normalizeGridRiskPerTradePct } from '../shared/grid-settings.js';

const DEFAULT_GRID_SYMBOLS = Object.freeze(['PAXGUSD', 'NVDAXUSD']);
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
  const step = (hi - lo) / (length - 1);
  return Array.from({ length }, (_, index) => ({
    index,
    price: lo + step * index,
    target: index < length - 1 ? lo + step * (index + 1) : 0
  }));
}
function resolveSymbols(settings, diagnostics) {
  const fromWorker = Array.isArray(diagnostics?.symbols)
    ? diagnostics.symbols.map(value => String(value || '').trim().toUpperCase())
    : [];
  if (fromWorker.length === 2 && fromWorker[0] !== fromWorker[1]) return fromWorker;
  const fromSettings = settings.grid_symbol_configs && typeof settings.grid_symbol_configs === 'object'
    ? Object.keys(settings.grid_symbol_configs).map(value => value.toUpperCase()) : [];
  return fromSettings.length === 2 ? fromSettings : [...DEFAULT_GRID_SYMBOLS];
}
function parseDraft(settings, symbols) {
  const saved = settings.grid_symbol_configs && typeof settings.grid_symbol_configs === 'object'
    ? settings.grid_symbol_configs : {};
  const first = symbols[0];
  const gridSymbolConfigs = Object.fromEntries(symbols.map((symbol, index) => {
    const config = saved[symbol] || {};
    const legacyLower = index === 0 ? settings.grid_lower_price : null;
    const legacyUpper = index === 0 ? settings.grid_upper_price : null;
    return [symbol, {
      lowerPrice: String(config.lowerPrice ?? config.grid_lower_price ?? legacyLower ?? ''),
      upperPrice: String(config.upperPrice ?? config.grid_upper_price ?? legacyUpper ?? ''),
      levelsCount: Number(config.levelsCount ?? config.grid_levels_count ?? (index === 0 ? settings.grid_levels_count : 10) ?? 10)
    }];
  }));
  return {
    gridSymbolConfigs,
    gridMaxPositions: GRID_BRIDGE_MAX_POSITIONS,
    gridRiskPerTradePct: normalizeGridRiskPerTradePct(settings.grid_risk_per_trade_pct ?? 0.3),
    gridDailyLossPct: Number(settings.grid_daily_loss_pct || 2),
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
  testnetDiagnostics = null
}) {
  const gridSymbols = useMemo(() => resolveSymbols(settings, testnetDiagnostics), [
    testnetDiagnostics?.symbols?.join(','), settings.grid_symbol_configs
  ]);
  const [draft, setDraft] = useState(() => parseDraft(settings, gridSymbols));
  const gridState = settings.grid_state && typeof settings.grid_state === 'object' ? settings.grid_state : {};
  const positions = Array.isArray(gridState.positions) ? gridState.positions : [];
  const pendingEntries = Array.isArray(gridState.pendingEntries) ? gridState.pendingEntries : [];
  const trades = Array.isArray(gridState.trades) ? [...gridState.trades].reverse() : [];
  const events = Array.isArray(gridState.events) ? [...gridState.events].reverse().slice(0, 12) : [];

  useEffect(() => {
    setDraft(parseDraft(settings, gridSymbols));
  }, [
    settings.grid_symbol_configs, settings.grid_lower_price, settings.grid_upper_price,
    settings.grid_levels_count, settings.grid_max_positions, settings.grid_risk_per_trade_pct,
    settings.grid_daily_loss_pct, settings.grid_momentum_pause_pct, settings.grid_reduce_after_losses,
    gridSymbols.join(',')
  ]);

  const views = gridSymbols.map(symbol => {
    const config = draft.gridSymbolConfigs?.[symbol] || { lowerPrice: '', upperPrice: '', levelsCount: 10 };
    const ticker = market.find(row => String(row.symbol || '').toUpperCase() === symbol) || {};
    const currentPrice = n(ticker.mark_price || ticker.price || ticker.close);
    const levels = levelsFor(config.lowerPrice, config.upperPrice, config.levelsCount);
    const symbolPositions = positions.filter(position => String(position.symbol || '').toUpperCase() === symbol);
    const symbolPending = pendingEntries.filter(order => String(order.symbol || '').toUpperCase() === symbol);
    const symbolState = gridState.symbolStates?.[symbol] || gridState.symbolSummaries?.[symbol] || {};
    return {
      symbol, config, currentPrice, levels, symbolPositions, symbolPending, symbolState,
      valid: levels.length >= 8 && n(config.lowerPrice) > 0 && n(config.upperPrice) > n(config.lowerPrice)
    };
  });

  const openRisk = safeNum(gridState.openRiskUsd);
  const dayStartEquity = safeNum(gridState.dayStartEquity);
  const dailyLossPct = safeNum(settings.grid_daily_loss_pct) ?? 2;
  const dailyCap = dayStartEquity === null ? null : dayStartEquity * dailyLossPct / 100;
  const realizedGridPnl = safeNum(gridState.realizedPnl);
  const dayPnl = safeNum(gridState.dayPnl);
  const unrealizedPnl = safeNum(gridState.unrealizedPnl);
  const totalDayPnl = dayPnl !== null && unrealizedPnl !== null ? dayPnl + unrealizedPnl : null;
  const currentEquity = safeNum(gridState.currentEquity);
  const drawdownPct = safeNum(gridState.drawdownPct);
  const momentumBySymbol = gridState.momentumBySymbol || {};
  const momentum = gridState.momentum || {};
  const allRangesValid = views.length === 2 && views.every(view => view.valid);
  const activeSlots = new Set([
    ...positions.map(position => String(position.symbol || '').toUpperCase()),
    ...pendingEntries.map(order => String(order.symbol || '').toUpperCase())
  ]).size;
  const lockedConfig = activeSlots > 0;
  const gridNotMigratedToDelta = gridEntrySafety?.reason === 'GRID_NOT_MIGRATED_TO_DELTA_TESTNET';
  const deltaTestnetGrid = executionMode === 'testnet' ||
    gridEntrySafety?.executionMode === 'testnet' || gridState.executionMode === 'DELTA_TESTNET';
  const gridExecutionAllowed = testnetDiagnostics?.gridExecutionAllowed === true;
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
    gridSymbolConfigs: Object.fromEntries(gridSymbols.map(symbol => {
      const config = draft.gridSymbolConfigs?.[symbol] || {};
      return [symbol, {
        lowerPrice: Number(config.lowerPrice),
        upperPrice: Number(config.upperPrice),
        levelsCount: Number(config.levelsCount)
      }];
    })),
    gridMaxPositions: GRID_BRIDGE_MAX_POSITIONS,
    gridRiskPerTradePct: draft.gridRiskPerTradePct,
    gridDailyLossPct: draft.gridDailyLossPct,
    gridMomentumPausePct: draft.gridMomentumPausePct,
    gridReduceAfterLosses: draft.gridReduceAfterLosses
  };
  const readyToStart = allRangesValid && (!deltaTestnetGrid || gridExecutionAllowed);
  const save = () => {
    if (!allRangesValid) return;
    mutate({ ...payload, gridEnabled: settings.grid_enabled === true });
  };
  const start = () => {
    if (!readyToStart || settings.grid_enabled === true || gridState.pausedReason || gridSafetyBlocked) return;
    mutate({ ...payload, gridEnabled: true });
  };
  const pause = () => {
    if (window.confirm('Pause new Grid entries on both symbols? Existing positions remain protected by their exchange-side SL/TP.')) {
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
      <div className="card"><small>CONFIGURED TESTNET SYMBOLS</small><strong>{gridSymbols.join(' · ')}</strong><span>Each symbol has its own range, limit entries and exchange-side stop/target bracket.</span></div>
      <div className="card"><small>OPEN GRID SYMBOLS</small><strong>{activeSlots} / {GRID_BRIDGE_MAX_POSITIONS}</strong><span>{positions.length} open position(s) · {pendingEntries.length} pending limit entry(ies) · {usd(openRisk === null && positions.length === 0 ? 0 : openRisk)} estimated open risk.</span></div>
      <div className="card"><small>{deltaTestnetGrid ? 'DELTA TESTNET NET P&L' : 'SIMULATED GRID P&amp;L'}</small><strong className={realizedGridPnl === null ? 'muted' : realizedGridPnl >= 0 ? 'up' : 'down'}>{usd(realizedGridPnl)}</strong><span>{deltaTestnetGrid ? 'Only fully fill-matched trades with verified commissions; otherwise P&L is unverified.' : 'Offline estimate after estimated fees and slippage; not exchange-reported P&amp;L.'}</span></div>
      <div className="card"><small>DAY PNL</small><strong className={totalDayPnl === null ? 'muted' : totalDayPnl >= 0 ? 'up' : 'down'}>{usd(totalDayPnl)}</strong><span>Realized + combined mark-to-market · daily stop {Number(settings.grid_daily_loss_pct || 2).toFixed(1)}%.</span></div>
      <div className="card"><small>STRATEGY EQUITY</small><strong>{usd(currentEquity)}</strong><span>Delta Testnet account equity at Grid start · drawdown {drawdownPct === null ? 'NO DATA' : drawdownPct.toFixed(2) + '%'} · hard stop 5%.</span></div>
      <div className="card"><small>EXECUTION GATE</small><strong>{deltaTestnetGrid ? (gridExecutionAllowed ? 'TESTNET LIMIT ORDERS ENABLED' : 'TESTNET ORDERS LOCKED') : 'SIMULATOR'}</strong><span>{deltaTestnetGrid ? (gridExecutionAllowed ? 'Runtime opt-in verified. Entries still require fresh market data, an available Testnet product, global safety checks and a free symbol slot.' : 'Set GRID_EXECUTION_ALLOWED=true in the Delta TESTNET worker and API environments. The default is false.') : 'Offline simulator; no exchange orders are sent.'}</span></div>
    </section>

    <Panel title="Grid Configuration · Two Independent Symbols">
      <div className="grid2">
        {views.map(view => <div className="card" key={view.symbol}>
          <strong>{view.symbol}</strong>
          <span>Current public mark: {view.currentPrice > 0 ? price(view.currentPrice) : 'Waiting for market price'}</span>
          <div className="gridConfig">
            <label>{view.symbol} Lower Price<input type="number" inputMode="decimal" min="0" step="any" placeholder="Set lower boundary" value={view.config.lowerPrice} onChange={event => updateSymbol(view.symbol, 'lowerPrice', event.target.value)} disabled={lockedConfig}/></label>
            <label>{view.symbol} Upper Price<input type="number" inputMode="decimal" min="0" step="any" placeholder="Set upper boundary" value={view.config.upperPrice} onChange={event => updateSymbol(view.symbol, 'upperPrice', event.target.value)} disabled={lockedConfig}/></label>
            <label>{view.symbol} Grid Levels<select value={view.config.levelsCount} onChange={event => updateSymbol(view.symbol, 'levelsCount', Number(event.target.value))} disabled={lockedConfig}>{[8,9,10,11,12].map(value => <option key={value} value={value}>{value} levels</option>)}</select></label>
          </div>
          <span>{view.valid ? view.levels.length + ' levels · ' + price((n(view.config.upperPrice) - n(view.config.lowerPrice)) / (view.levels.length - 1)) + ' spacing' : 'Range not configured · upper must exceed lower'}</span>
          <span>{view.symbolPositions.length} open position(s) · {view.symbolPending.length} pending limit entry(ies)</span>
          {view.symbolState.pausedReason ? <span className="down">Status: {view.symbolState.pausedReason}</span> : null}
        </div>)}
      </div>
      <div className="gridConfig">
        <label>Maximum Open Positions<select value={GRID_BRIDGE_MAX_POSITIONS} disabled><option value={GRID_BRIDGE_MAX_POSITIONS}>2 positions · one per symbol</option></select></label>
        <label>Target Risk / Trade<select value={draft.gridRiskPerTradePct} onChange={event => updateGlobal('gridRiskPerTradePct', Number(event.target.value))}>{GRID_RISK_PER_TRADE_CHOICES.map(value => <option key={value} value={value}>{value.toFixed(2)}%{value === 0.3 ? ' · conservative default' : ' target'}</option>)}</select></label>
        <label>Daily Loss Limit<select value={draft.gridDailyLossPct} onChange={event => updateGlobal('gridDailyLossPct', Number(event.target.value))}><option value={2}>2.0%</option><option value={2.25}>2.25%</option><option value={2.5}>2.5%</option></select></label>
        <label>Momentum Pause<select value={draft.gridMomentumPausePct} onChange={event => updateGlobal('gridMomentumPausePct', Number(event.target.value))}><option value={2.5}>2.5% one-way move</option><option value={2.75}>2.75% one-way move</option><option value={3}>3.0% one-way move</option></select></label>
      </div>
      <label className="gridCheck"><input type="checkbox" checked={draft.gridReduceAfterLosses} onChange={event => updateGlobal('gridReduceAfterLosses', event.target.checked)}/> Reduce position sizing by 50% after 2 consecutive losses</label>
      <div className="gridButtons">
        {gridSafetyBlocked ? <div className="errorText">Grid entries are blocked by worker safety ({gridSafetyReason}). Review the latest heartbeat and exchange position reconciliation before restarting. Existing positions remain protected by exchange-side SL/TP.</div> : null}
        <button className="action" disabled={busy || !allRangesValid || lockedConfig} onClick={save}>Save Configuration</button>
        <button className="action gridStart" disabled={busy || !readyToStart || settings.grid_enabled === true || !!gridState.pausedReason || gridSafetyBlocked || gridNotMigratedToDelta} onClick={start}>{deltaTestnetGrid ? (gridExecutionAllowed ? 'Start Grid (Delta Testnet)' : 'Testnet Execution Disabled') : 'Start Grid (Simulator)'}</button>
        <button className="action" title="New entries stop. Existing positions remain protected by exchange-side SL/TP." disabled={busy || settings.grid_enabled !== true} onClick={pause}>Pause Grid (Exit Only)</button>
        <button className="dangerBtn" title="Resets Grid state. Does NOT trigger global Emergency Stop." disabled={busy || lockedConfig || !gridState.pausedReason || settings.emergency_stop === true || ['DAILY_LOSS_LIMIT','OVERALL_DRAWDOWN_STOP'].includes(gridState.pausedReason)} onClick={reset}>Reset Grid State</button>
      </div>
      {!allRangesValid ? <div className="errorText">Set a valid range and choose 8–12 levels for both symbols before starting. Each upper bound must be greater than its lower bound.</div> : null}
      {lockedConfig ? <div className="lockedText">Symbol ranges are locked while an exchange position or pending entry exists. Let exchange-side SL/TP complete the position or close it before changing ranges.</div> : null}
      {gridState.pausedReason === 'DAILY_LOSS_LIMIT' ? <div className="errorText">The shared 2% daily-loss guard is active. It cannot be reset during the same India trading day.</div> : null}
      {gridState.pausedReason === 'OVERALL_DRAWDOWN_STOP' ? <div className="errorText">The shared 5% overall drawdown stop is terminal for this Grid run. Keep this run halted; do not reset its capital baseline to resume.</div> : null}
      <div className="lockedText"><b>Risk controls:</b> shared 2% daily-loss cap, 5% strategy drawdown stop, 1.2% full-range break, momentum pause and global two-position cap. Risk is aggregated across both symbols. Actual quantities round down to whole contracts; if minimum size exceeds the risk budget, that entry is skipped.</div>
    </Panel>

    <Panel title="Grid Levels and Open Positions · Per Symbol">
      {views.map(view => {
        const openLevelSet = new Set(view.symbolPositions.map(position => Number(position.levelIndex)));
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
        </div>;
      })}
    </Panel>

    <div className="grid2">
      <Panel title="Combined Risk Locks & Last Events">
        <div className="gridLockRow"><b>Daily loss</b><span>{dayPnl === null ? 'NO DATA' : usd(Math.max(0, -dayPnl))} / {usd(dailyCap)}</span></div>
        <div className="gridLockRow"><b>Open risk</b><span>{usd(openRisk === null && positions.length === 0 ? 0 : openRisk)}</span></div>
        <div className="gridLockRow"><b>Drawdown</b><span>{drawdownPct === null ? 'NO DATA' : drawdownPct.toFixed(2) + '%'} / 5.00%</span></div>
        <div className="gridLockRow"><b>Hard-stop reason</b><span className={gridState.pausedReason ? 'down' : 'up'}>{gridState.pausedReason || 'None'}</span></div>
        <div className="gridEvents">{events.length ? events.map((event, index) => <div key={String(event.at) + String(event.symbol || '') + index}><small>{event.at ? new Date(event.at).toLocaleTimeString('en-IN') : '—'}</small><b>{event.symbol || 'GRID'} · {event.type || 'INFO'}</b><span>{event.reason || (event.type === 'ENTRY' ? 'Entry' : event.type === 'EXIT' ? 'Exit' : 'Grid update')}{event.levelIndex != null ? ' · G' + (Number(event.levelIndex)+1) : ''}{event.price ? ' · ' + price(event.price) : ''}{event.pnl != null ? ' · ' + usd(event.pnl) : ''}</span></div>) : <span>No Grid events yet.</span>}</div>
      </Panel>
      <Panel title="Recent Verified Grid Trades">
        {trades.length ? <div className="tablewrap"><table className="gridLevelsTable"><thead><tr><th>SYMBOL</th><th>CLOSED</th><th>LEVEL</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>NET PNL</th><th>REASON</th></tr></thead><tbody>{trades.slice(0,20).map((trade,index) => <tr key={trade.id || trade.executionId || index}><td>{trade.symbol || '—'}</td><td>{trade.closedAt ? new Date(trade.closedAt).toLocaleString('en-IN') : '—'}</td><td>G{Number(trade.levelIndex)+1}</td><td>{price(trade.entryPrice)}</td><td>{price(trade.exitPrice)}</td><td>{safeNum(trade.qty) === null ? '—' : safeNum(trade.qty)}</td><td className={safeNum(trade.netPnl) === null ? 'muted' : safeNum(trade.netPnl) >= 0 ? 'up' : 'down'}>{usd(trade.netPnl)}</td><td>{trade.reason}</td></tr>)}</tbody></table></div> : <div className="lockedText">No completed Grid trades yet.</div>}
        {lastTrade ? <div className="statusLine">Last trade: {lastTrade.symbol} · {lastTrade.reason} · net {usd(lastTrade.netPnl)}</div> : null}
      </Panel>
    </div>
    <div className="gridTestNotice">{deltaTestnetGrid
      ? 'DELTA TESTNET GRID: ' + (gridExecutionAllowed ? 'Bracket-protected GTC limit entries are enabled only for the two configured allowlisted symbols. Each symbol has its own exchange-side SL/TP; the 2% daily loss and 5% drawdown guards are shared across both.' : 'Read-only until GRID_EXECUTION_ALLOWED=true in the explicit Testnet profile. No orders are submitted while the opt-in is false.')
      : 'GRID SAFETY: This is an offline simulator, not a direct Delta Testnet order engine. Do not treat simulated P&L as exchange P&L.'}</div>
  </>;
}

function Panel({ title, children }) {
  return <section className="panel"><div className="panelTitle"><h2>{title}</h2></div><div className="pad">{children}</div></section>;
}
