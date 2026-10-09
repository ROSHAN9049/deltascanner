import React, { useEffect, useMemo, useState } from 'react';

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const usd = value => '$' + n(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
const price = value => n(value) > 0 ? n(value).toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—';

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
function parseDraft(settings) {
  return {
    gridSymbol: settings.grid_symbol || 'ETHUSD',
    gridLowerPrice: settings.grid_lower_price ? String(settings.grid_lower_price) : '',
    gridUpperPrice: settings.grid_upper_price ? String(settings.grid_upper_price) : '',
    gridLevelsCount: Number(settings.grid_levels_count || 10),
    gridMaxPositions: Number(settings.grid_max_positions || 4),
    gridRiskPerTradePct: Number(settings.grid_risk_per_trade_pct || 1),
    gridDailyLossPct: Number(settings.grid_daily_loss_pct || 2),
    gridMomentumPausePct: Number(settings.grid_momentum_pause_pct || 2.5),
    gridReduceAfterLosses: settings.grid_reduce_after_losses !== false
  };
}
const fieldMap = {
  gridSymbol: 'gridSymbol',
  gridLowerPrice: 'gridLowerPrice',
  gridUpperPrice: 'gridUpperPrice',
  gridLevelsCount: 'gridLevelsCount',
  gridMaxPositions: 'gridMaxPositions',
  gridRiskPerTradePct: 'gridRiskPerTradePct',
  gridDailyLossPct: 'gridDailyLossPct',
  gridMomentumPausePct: 'gridMomentumPausePct',
  gridReduceAfterLosses: 'gridReduceAfterLosses'
};

export default function GridStrategy({ settings = {}, market = [], busy = false, mutate }) {
  const [draft, setDraft] = useState(() => parseDraft(settings));
  const gridState = settings.grid_state && typeof settings.grid_state === 'object'
    ? settings.grid_state : {};
  useEffect(() => {
    setDraft(parseDraft(settings));
  }, [
    settings.grid_symbol, settings.grid_lower_price, settings.grid_upper_price,
    settings.grid_levels_count, settings.grid_max_positions, settings.grid_risk_per_trade_pct,
    settings.grid_daily_loss_pct, settings.grid_momentum_pause_pct, settings.grid_reduce_after_losses
  ]);

  const symbol = String(draft.gridSymbol || 'ETHUSD').toUpperCase();
  const ticker = market.find(row => String(row.symbol || '').toUpperCase() === symbol) || {};
  const currentPrice = n(ticker.mark_price || ticker.price || ticker.close);
  const levels = useMemo(() => levelsFor(draft.gridLowerPrice, draft.gridUpperPrice, draft.gridLevelsCount), [
    draft.gridLowerPrice, draft.gridUpperPrice, draft.gridLevelsCount
  ]);
  const positions = Array.isArray(gridState.positions) ? gridState.positions : [];
  const trades = Array.isArray(gridState.trades) ? [...gridState.trades].reverse() : [];
  const events = Array.isArray(gridState.events) ? [...gridState.events].reverse().slice(0, 10) : [];
  const openRisk = n(gridState.openRiskUsd);
  const dailyCap = n(gridState.dayStartEquity) * n(settings.grid_daily_loss_pct || 2) / 100;
  const momentum = gridState.momentum || {};
  const valid = levels.length >= 8 && n(draft.gridLowerPrice) < n(draft.gridUpperPrice);
  const openLevelSet = new Set(positions.map(position => Number(position.levelIndex)));
  const targetLevelSet = new Set(positions.map(position => Number(position.levelIndex) + 1));
  const lockedConfig = positions.length > 0;
  const stateStatus = gridState.status || 'OFF';
  const lastTrade = trades[0];

  const update = (key, value) => setDraft(old => ({ ...old, [key]: value }));
  const payload = Object.fromEntries(Object.entries(draft).map(([key, value]) => {
    if (key === 'gridLowerPrice' || key === 'gridUpperPrice') return [fieldMap[key], Number(value)];
    return [fieldMap[key] || key, value];
  }));
  const readyToStart = valid && n(draft.gridLowerPrice) > 0 && n(draft.gridUpperPrice) > n(draft.gridLowerPrice);
  const save = () => {
    if (!readyToStart) return;
    mutate({ ...payload, gridEnabled: settings.grid_enabled === true });
  };
  const start = () => {
    if (!readyToStart) return;
    mutate({ ...payload, gridEnabled: true });
  };
  const pause = () => mutate({ gridEnabled: false });
  const reset = () => mutate({ gridReset: true });

  return <>
    <section className="cards">
      <div className="card"><small>GRID ENGINE</small><strong>{stateStatus.replaceAll('_', ' ')}</strong><span>Dedicated BTC/ETH grid; independent from momentum/scalping.</span></div>
      <div className="card"><small>INSTRUMENT / LIVE PRICE</small><strong>{symbol}</strong><span>{currentPrice > 0 ? price(currentPrice) : 'Waiting for market price'} · Delta public market feed</span></div>
      <div className="card"><small>OPEN GRID POSITIONS</small><strong>{positions.length} / {Number(settings.grid_max_positions || 4)}</strong><span>{usd(openRisk)} estimated remaining-to-grid-stop risk.</span></div>
      <div className="card"><small>GRID PNL · TEST LEDGER</small><strong className={n(gridState.realizedPnl) >= 0 ? 'up' : 'down'}>{usd(gridState.realizedPnl)}</strong><span>Realized after estimated maker fees and slippage; simulator only.</span></div>
      <div className="card"><small>DAY PNL</small><strong className={n(gridState.dayPnl) >= 0 ? 'up' : 'down'}>{usd(gridState.dayPnl + n(gridState.unrealizedPnl))}</strong><span>Realized + mark-to-market; daily stop {Number(settings.grid_daily_loss_pct || 2).toFixed(1)}%.</span></div>
      <div className="card"><small>STRATEGY EQUITY</small><strong>{usd(gridState.currentEquity || gridState.strategyStartEquity)}</strong><span>Drawdown {n(gridState.drawdownPct).toFixed(2)}% · hard stop 5%.</span></div>
      <div className="card"><small>MOMENTUM FILTER</small><strong className={momentum.paused ? 'warn' : 'up'}>{momentum.paused ? 'PAUSED' : 'CLEAR'}</strong><span>{momentum.direction || 'NONE'} · {n(momentum.movePct).toFixed(2)}% move · reversal {n(momentum.retracementPct).toFixed(2)}%.</span></div>
      <div className="card"><small>EXECUTION</small><strong>OFFLINE TEST</strong><span>Worker simulation only; no Delta orders or Tradetron entries are sent by this module.</span></div>
    </section>

    <Panel title="Grid Configuration · BTCUSD / ETHUSD">
      <div className="gridConfig">
        <label>Instrument<select value={draft.gridSymbol} onChange={e => update('gridSymbol', e.target.value)} disabled={lockedConfig}><option value="ETHUSD">ETHUSD · Recommended</option><option value="BTCUSD">BTCUSD</option></select></label>
        <label>Lower Price<input type="number" inputMode="decimal" min="0" step="any" placeholder="Set lower grid boundary" value={draft.gridLowerPrice} onChange={e => update('gridLowerPrice', e.target.value)} disabled={lockedConfig}/></label>
        <label>Upper Price<input type="number" inputMode="decimal" min="0" step="any" placeholder="Set upper grid boundary" value={draft.gridUpperPrice} onChange={e => update('gridUpperPrice', e.target.value)} disabled={lockedConfig}/></label>
        <label>Grid Levels<select value={draft.gridLevelsCount} onChange={e => update('gridLevelsCount', Number(e.target.value))} disabled={lockedConfig}>{[8,9,10,11,12].map(v => <option key={v} value={v}>{v} levels</option>)}</select></label>
        <label>Max Open Positions<select value={draft.gridMaxPositions} onChange={e => update('gridMaxPositions', Number(e.target.value))}><option value={3}>3 positions</option><option value={4}>4 positions</option></select></label>
        <label>Target Risk / Trade<select value={draft.gridRiskPerTradePct} onChange={e => update('gridRiskPerTradePct', Number(e.target.value))}><option value={1}>1.0% target</option><option value={1.25}>1.25% target</option><option value={1.5}>1.5% target</option></select></label>
        <label>Daily Loss Limit<select value={draft.gridDailyLossPct} onChange={e => update('gridDailyLossPct', Number(e.target.value))}><option value={2}>2.0%</option><option value={2.25}>2.25%</option><option value={2.5}>2.5%</option></select></label>
        <label>Momentum Pause<select value={draft.gridMomentumPausePct} onChange={e => update('gridMomentumPausePct', Number(e.target.value))}><option value={2.5}>2.5% one-way move</option><option value={2.75}>2.75% one-way move</option><option value={3}>3.0% one-way move</option></select></label>
      </div>
      <label className="gridCheck"><input type="checkbox" checked={draft.gridReduceAfterLosses} onChange={e => update('gridReduceAfterLosses', e.target.checked)}/> Reduce position sizing by 50% after 2 consecutive losses</label>
      <div className="gridButtons">
        <button className="action" disabled={busy || !readyToStart} onClick={save}>Save Configuration</button>
        <button className="action gridStart" disabled={busy || !readyToStart || settings.grid_enabled === true || !!gridState.pausedReason} onClick={start}>Start Offline Test</button>
        <button className="action" disabled={busy || settings.grid_enabled !== true} onClick={pause}>Pause New Entries</button>
        <button className="dangerBtn" disabled={busy || lockedConfig || !gridState.pausedReason} onClick={reset}>Reset Hard Stop</button>
      </div>
      {!valid ? <div className="errorText">Set a valid lower and upper price and choose 8–12 grid levels before starting. Upper must be greater than lower.</div> : null}
      {lockedConfig ? <div className="lockedText">Grid range and instrument edits are locked while a simulated position is open. Pause entries and let positions exit or reset only after positions are closed.</div> : null}
      <div className="lockedText">
        <b>Risk sizing guard:</b> The configured 1–1.5% is a target, not a promise. Actual per-position risk is capped at the smaller of that target or daily-loss limit ÷ max positions, and rounded down to whole contracts. If one contract exceeds its risk budget, the entry is skipped. The 5% strategy drawdown limit and 1.2% full-range break close all simulated positions and hard-stop the grid.
      </div>
    </Panel>

    <Panel title={'Grid Levels · equal spacing · ' + levels.length + ' levels'}>
      <div className="gridMeta">
        <span>Spacing: <b>{levels.length > 1 ? price((n(draft.gridUpperPrice) - n(draft.gridLowerPrice)) / (levels.length - 1)) : '—'}</b></span>
        <span>Upper break: <b>{n(draft.gridUpperPrice) > 0 ? price(n(draft.gridUpperPrice) * 1.012) : '—'}</b> (+1.2%)</span>
        <span>Lower break: <b>{n(draft.gridLowerPrice) > 0 ? price(n(draft.gridLowerPrice) * 0.988) : '—'}</b> (−1.2%)</span>
      </div>
      <div className="tablewrap"><table className="gridLevelsTable"><thead><tr><th>LEVEL</th><th>PRICE</th><th>ENTRY</th><th>NEXT EXIT TARGET</th><th>STATUS</th></tr></thead><tbody>
        {[...levels].reverse().map(level => {
          const position = positions.find(item => Number(item.levelIndex) === level.index);
          const targetFor = positions.filter(item => Number(item.levelIndex) + 1 === level.index);
          const status = position ? 'POSITION OPEN' : targetFor.length ? 'EXIT TARGET' : level.index === levels.length - 1 ? 'TOP · NO ENTRY' : (currentPrice > 0 && Math.abs(currentPrice - level.price) / level.price < 0.001 ? 'NEAR PRICE' : 'AVAILABLE');
          return <tr key={level.index}><td>G{String(level.index + 1).padStart(2,'0')}</td><td>{price(level.price)}</td><td>{level.index < levels.length - 1 ? 'LIMIT BUY' : '—'}</td><td>{level.target > 0 ? price(level.target) : '—'}</td><td className={position ? 'warn' : targetFor.length ? 'up' : 'muted'}>{status}{position ? ' · ' + n(position.qty) + ' qty' : ''}</td></tr>;
        })}
      </tbody></table></div>
    </Panel>

    <div className="grid2">
      <Panel title="Open Grid Positions">
        {positions.length ? <div className="tablewrap"><table className="gridLevelsTable"><thead><tr><th>LEVEL</th><th>ENTRY</th><th>TARGET</th><th>QTY</th><th>RISK</th><th>OPENED</th></tr></thead><tbody>{positions.map(position => <tr key={position.id}><td>G{Number(position.levelIndex)+1}</td><td>{price(position.entryPrice)}</td><td>{price(position.targetPrice)}</td><td>{n(position.qty)}</td><td>{usd(position.riskUsd)}</td><td>{position.openedAt ? new Date(position.openedAt).toLocaleTimeString('en-IN') : '—'}</td></tr>)}</tbody></table></div> : <div className="lockedText">No open grid positions. A level is only entered when price crosses it downward from above; a closed level becomes available again.</div>}
      </Panel>
      <Panel title="Risk Locks & Last Events">
        <div className="gridLockRow"><b>Daily loss</b><span>{usd(Math.max(0, -n(gridState.dayPnl)))} / {usd(dailyCap)}</span></div>
        <div className="gridLockRow"><b>Open risk</b><span>{usd(openRisk)}</span></div>
        <div className="gridLockRow"><b>Drawdown</b><span>{n(gridState.drawdownPct).toFixed(2)}% / 5.00%</span></div>
        <div className="gridLockRow"><b>Hard-stop reason</b><span className={gridState.pausedReason ? 'down' : 'up'}>{gridState.pausedReason || 'None'}</span></div>
        <div className="gridEvents">{events.length ? events.map((event, index) => <div key={String(event.at) + index}><small>{event.at ? new Date(event.at).toLocaleTimeString('en-IN') : '—'}</small><b>{event.type || 'INFO'}</b><span>{event.reason || (event.type === 'ENTRY' ? 'Entry' : event.type === 'EXIT' ? 'Exit' : 'Grid update')}{event.levelIndex != null ? ' · G' + (Number(event.levelIndex)+1) : ''}{event.price ? ' · ' + price(event.price) : ''}{event.pnl != null ? ' · ' + usd(event.pnl) : ''}</span></div>) : <span>No grid events yet.</span>}</div>
      </Panel>
    </div>

    <Panel title="Recent Grid Test Trades">
      {trades.length ? <div className="tablewrap"><table className="gridLevelsTable"><thead><tr><th>CLOSED</th><th>LEVEL</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>NET PNL</th><th>REASON</th></tr></thead><tbody>{trades.slice(0,20).map(trade => <tr key={trade.id}><td>{trade.closedAt ? new Date(trade.closedAt).toLocaleString('en-IN') : '—'}</td><td>G{Number(trade.levelIndex)+1}</td><td>{price(trade.entryPrice)}</td><td>{price(trade.exitPrice)}</td><td>{n(trade.qty)}</td><td className={n(trade.netPnl) >= 0 ? 'up' : 'down'}>{usd(trade.netPnl)}</td><td>{trade.reason}</td></tr>)}</tbody></table></div> : <div className="lockedText">No completed grid trades yet.</div>}
      {lastTrade ? <div className="statusLine">Last trade: {lastTrade.reason} · net {usd(lastTrade.netPnl)} · {lastTrade.symbol}</div> : null}
    </Panel>
    <div className="gridTestNotice">SAFETY MODE: this separate strategy runs only in the Railway worker's simulated ledger. It does not place Delta orders or send Tradetron signals. After the offline ledger is verified, a dedicated Tradetron grid template and its entry/exit variable mapping must be wired and tested before any Live Offline deployment.</div>
  </>;
}

function Panel({ title, children }) {
  return <section className="panel"><div className="panelTitle"><h2>{title}</h2></div><div className="pad">{children}</div></section>;
}
