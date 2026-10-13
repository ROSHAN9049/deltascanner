import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import GridStrategy from './GridStrategy.jsx';
import { routeStatusForSymbol } from './market-route-status.js';
import { getTradetronDiagnosticDetails } from './tradetron-diagnostics.js';
import { summarizeTradetronSnapshots } from './tradetron-position-sync.js';
import { DEFAULT_VISIBLE_MARKET_LIMIT, selectVisibleMarketRows, selectVisibleSignalRows } from './market-view.js';

const tabs = [
  ['dashboard','Dashboard'],['rotation','Profit Rotation'],['momentum','Momentum'],['momentum-history','Mom History'],
  ['scalping','Scalping'],['grid','Grid Strategy'],['scalp-history','Scalp History'],['options','Options'],['positions','Positions'],['trade-history','Trade History'],
  ['pnl','PNL'],['paper','Paper Trading'],['testnet','Legacy Demo OFF'],['live','Live Trading'],['analytics','Analytics'],['settings','Settings']
];
const num = v => Number.isFinite(+v) ? +v : 0;
const pct = v => (num(v) >= 0 ? '+' : '') + num(v).toFixed(2) + '%';
const USD_INR_RATE = Math.max(1, Number(import.meta.env.VITE_USD_INR_RATE || 96.83));
const money = v => '₹' + (num(v) * USD_INR_RATE).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const price = v => num(v).toLocaleString('en-IN', { maximumFractionDigits: 8 });
const isPass = v => v === true;
const latestSignals = list => {
  const m = new Map();
  for (const x of list || []) {
    const key = x.symbol + ':' + x.strategy;
    if (!m.has(key) || new Date(x.captured_at) > new Date(m.get(key).captured_at)) m.set(key, x);
  }
  return [...m.values()];
};

function App() {
  const [tab, setTab] = useState('dashboard');
  const [state, setState] = useState(null);
  const [market, setMarket] = useState([]);
  const [health, setHealth] = useState(null);
  const [secret, setSecret] = useState(sessionStorage.getItem('delta-engine-secret') || '');
  const secretRef = useRef(secret);
  const [error, setError] = useState('');
  const [marketError, setMarketError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [inspect, setInspect] = useState('');

  const load = async () => {
    const cacheBust = '?t=' + Date.now();
    const privateHeaders = secretRef.current ? { 'x-engine-secret': secretRef.current } : {};
    // Market rendering is independent of the slower health / engine-state requests.
    const marketRequest = (async () => {
      const response = await fetch('/api/market' + cacheBust, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Market unavailable');
      setMarket(Array.isArray(result.result) ? result.result : []);
      setMarketError('');
    })().catch(e => setMarketError(e.message || 'Market unavailable'));

    const stateRequest = (async () => {
      const responses = await Promise.all([
        fetch('/api/health' + cacheBust, { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/engine/state' + cacheBust, { cache: 'no-store', headers: privateHeaders }).then(r => r.json())
      ]);
      setHealth(responses[0]);
      if (responses[1].success) {
        setState(responses[1]);
        setError('');
      } else {
        throw new Error(responses[1].error || 'Engine state unavailable');
      }
    })().catch(e => setError(e.message || 'Dashboard data unavailable'));

    await Promise.allSettled([marketRequest, stateRequest]);
  };
  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, []);
  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(id); }, []);

  const settings = state?.settings || {};
  const trades = state?.trades || [];
  const positions = state?.positions || [];
  const signals = latestSignals(state?.signalCache || state?.signals || []);
  const today = new Date().toISOString().slice(0,10);
  const todayTrades = trades.filter(t => String(t.closed_at || '').slice(0,10) === today);
  const wins = todayTrades.filter(t => num(t.net_pnl) > 0).length;
  const losses = todayTrades.filter(t => num(t.net_pnl) < 0).length;

  const mutate = async patch => {
    if (!secret) { setTab('settings'); setError('ENGINE_SECRET is required for control actions.'); return false; }
    setBusy(true);
    try {
      const res = await fetch('/api/engine/toggle', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-engine-secret': secret },
        body: JSON.stringify(patch)
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Control failed');
      await load();
      return true;
    } catch (e) {
      setError(e.message || 'Control failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const selected = useMemo(() => {
    const chosen = inspect || signals[0]?.symbol || '';
    const candidates = signals.filter(x => x.symbol === chosen);
    return candidates.find(x => x.strategy === 'MOMENTUM') || candidates[0] || null;
  }, [inspect, signals]);

  const selectedScalp = selected ? signals.find(x => x.symbol === selected.symbol && x.strategy === 'SCALPING') : null;
  const stale = !health?.tickFresh;
  // The dashboard API and Railway worker have separate environment variables.
  // Prefer the actual worker's heartbeat telemetry over Vercel's local config,
  // which may not contain the Railway-only Tradetron token or allowlist.
  const workerRoutingLog = (state?.logs || []).find(row =>
    row?.message === 'Worker heartbeat scan' && row?.data?.tradetronRouting
  );
  const workerRouting = workerRoutingLog?.data?.tradetronRouting || null;
  const normalizeSymbols = value => Array.isArray(value)
    ? [...new Set(value.map(symbol => String(symbol || '').trim().toUpperCase()).filter(Boolean))]
    : [];
  const workerSupportedSymbols = normalizeSymbols(workerRouting?.supportedSymbols);
  const workerConfiguredSymbols = normalizeSymbols(workerRouting?.configuredSymbols);
  const configuredRouteSymbols = workerConfiguredSymbols.length ? workerConfiguredSymbols : workerSupportedSymbols;
  const unavailableMarketSymbols = Array.isArray(workerRouting?.unavailableMarketSymbols)
    ? normalizeSymbols(workerRouting.unavailableMarketSymbols)
    : configuredRouteSymbols.filter(symbol => !workerSupportedSymbols.includes(symbol));
  const executionCoverage = workerRouting ? {
    ...(state?.executionCoverage || {}),
    routedFuturesSymbols: workerSupportedSymbols.length,
    routedSymbols: workerSupportedSymbols,
    configuredRouteSymbols,
    unavailableMarketSymbols,
    marketSymbolCount: Number(workerRouting.marketSymbolCount) || null,
    configuredFuturesRoutes: Number(workerRouting.configuredRoutes) || 0,
    optionsRouteConfigured: workerRouting.optionsRouteConfigured === true,
    reservedSignals: Number(workerRoutingLog?.data?.reservedSignals) || 0,
    signalReservationTtlMinutes: Number(workerRoutingLog?.data?.signalReservationTtlMs) > 0
      ? Math.round(Number(workerRoutingLog.data.signalReservationTtlMs) / 60000)
      : 15,
    routingStatusSource: 'worker-heartbeat',
    routingObservedAt: workerRoutingLog?.created_at || null
  } : (state?.executionCoverage || null);
  return <div className="terminal">
    <header className="topbar">
      <div>
        <div className="brand">D <span>DEALDOST</span></div>
        <div className="sub">DELTA INDIA · PERPETUAL FUTURES COMMAND CENTER</div>
      </div>
      <div className="headerRight">
        <span>BUILD v2.0.20261013.01</span>
        <span>UTC {new Date(clock).toISOString().slice(11,19)}</span>
        <span>LOCAL {new Date(clock).toLocaleTimeString('en-IN')}</span>
        <b className="badge test">LIVE MARKET · SIGNAL ONLY</b>
        <b className="badge lock">LIVE LOCKED</b>
        <button className="estop" disabled={busy || !secret} onClick={() => mutate({ emergencyStop: !settings.emergency_stop })}>
          {settings.emergency_stop ? 'RELEASE E-STOP' : 'EMERGENCY STOP'}
        </button>
      </div>
    </header>
    {stale ? <div className="danger">⚠ WORKER HEARTBEAT / MARKET TICK STALE FOR MORE THAN 3 MINUTES. NEW ENTRIES MUST BE TREATED AS BLOCKED.</div> : null}
    {error || marketError ? <div className="error">{error || marketError}</div> : null}
    <nav>{tabs.map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'live' ? ' 🔒' : ''}</button>)}</nav>

    {tab === 'dashboard' && <Dashboard market={market} settings={settings} health={health} trades={trades} positions={positions} signals={signals} signalOrderStats={state?.signalOrderStats || null} tradetronEvents={state?.tradetronEvents || []} executionCoverage={executionCoverage} developerSync={state?.tradetronDeveloperSync || null} developerSnapshots={state?.tradetronDeveloperSnapshots || []} developerApiConfigured={executionCoverage?.tradetronDeveloperApiConfigured === true} developerDataProtected={state?.tradetronDeveloperDataProtected === true} developerNotifications={state?.tradetronDeveloperNotifications || []} developerNotificationSync={state?.tradetronDeveloperNotificationSync || null} developerPnlHistory={state?.tradetronDeveloperPnlHistory || []} onInspect={setInspect} inspect={selected} logs={state?.logs || []} />}
    {tab === 'rotation' && <Rotation ledger={state?.ledger || []} />}
    {tab === 'momentum' && <EngineView engine="MOMENTUM" signals={signals} />}
    {tab === 'momentum-history' && <TradeHistory trades={trades.filter(t => t.strategy === 'MOMENTUM')} title="Momentum History" />}
    {tab === 'scalping' && <EngineView engine="SCALPING" signals={signals} />}
    {tab === 'grid' && <GridStrategy settings={settings} market={market} busy={busy} mutate={mutate} />}
    {tab === 'options' && <OptionsView signals={signals} settings={settings} optionCache={state?.optionCache || []} executionCoverage={state?.executionCoverage || null} />}
    {tab === 'scalp-history' && <TradeHistory trades={trades.filter(t => t.strategy === 'SCALPING')} title="Scalping History" />}
    {tab === 'positions' && <><Positions rows={positions} tradetronDeployments={state?.tradetronDeveloperDataProtected ? [] : (state?.tradetronDeveloperSnapshots || [])} snapshotsLocked={state?.tradetronDeveloperDataProtected === true} /><TradetronDeveloperApiPanel configured={executionCoverage?.tradetronDeveloperApiConfigured === true} sync={state?.tradetronDeveloperSync || null} deployments={state?.tradetronDeveloperSnapshots || []} privateDataProtected={state?.tradetronDeveloperDataProtected === true} notifications={state?.tradetronDeveloperNotifications || []} notificationSync={state?.tradetronDeveloperNotificationSync || null} pnlHistory={state?.tradetronDeveloperPnlHistory || []} /></>}
    {tab === 'trade-history' && <><TradeHistory trades={trades} title="Trade History · Webhook-Synced Tradetron Records" /><TradetronActivity events={state?.tradetronEvents || []} signalStats={state?.signalOrderStats || null} webhookSecretConfigured={executionCoverage?.webhookSecretConfigured === true} /></>}
    {tab === 'pnl' && <><PNL trades={trades} settings={settings} /><TradetronDeveloperApiPanel configured={executionCoverage?.tradetronDeveloperApiConfigured === true} sync={state?.tradetronDeveloperSync || null} deployments={state?.tradetronDeveloperSnapshots || []} privateDataProtected={state?.tradetronDeveloperDataProtected === true} notifications={state?.tradetronDeveloperNotifications || []} notificationSync={state?.tradetronDeveloperNotificationSync || null} pnlHistory={state?.tradetronDeveloperPnlHistory || []} /></>}
    {tab === 'paper' && <Panel title="Paper Trading"><div className="lockedText">Scanner is signal-only. No Delta order is placed here; Tradetron Live Offline runs the simulated execution.</div></Panel>}
    {tab === 'testnet' && <Testnet settings={settings} health={health} busy={busy} mutate={mutate} positions={positions} />}
    {tab === 'live' && <Panel title="Live Trading"><div className="liveLock">🔒 DIRECT DELTA EXECUTION LOCKED<br/><small>The scanner never sends production orders. Future live execution must be enabled manually in Tradetron.</small></div></Panel>}
    {tab === 'analytics' && <Analytics trades={trades} />}
    {tab === 'settings' && <Settings settings={settings} secret={secret} setSecret={v => { secretRef.current = v; setSecret(v); sessionStorage.setItem('delta-engine-secret', v); }} busy={busy} mutate={mutate} />}
    <footer>Delta Exchange India · production market feed · Tradetron signal-only · no direct orders · no guaranteed win rate</footer>
  </div>;
}

function Panel({ title, children }) {
  return <section className="panel"><div className="panelTitle"><h2>{title}</h2></div><div className="pad">{children}</div></section>;
}
function Card({ label, value, sub }) {
  return <div className="card"><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>;
}
function Dashboard({ market, settings, health, trades, positions, signals, signalOrderStats = null, tradetronEvents = [], executionCoverage = null, developerSync = null, developerSnapshots = [], developerApiConfigured = false, developerDataProtected = false, developerNotifications = [], developerNotificationSync = null, developerPnlHistory = [], onInspect, inspect, logs }) {
  const today = new Date().toISOString().slice(0,10);
  const configuredRouteSymbols = new Set(executionCoverage?.routedSymbols || []);
  const activeRoutedCount = configuredRouteSymbols.size
    ? (market || []).filter(row => configuredRouteSymbols.has(String(row.symbol || '').toUpperCase())).length
    : Math.min(executionCoverage?.routedFuturesSymbols || 0, market?.length || 0);
  const unroutedCount = Math.max(0, (market?.length || 0) - activeRoutedCount);
  const developerSnapshotRowCount = (developerSnapshots || []).reduce(
    (count, deployment) => count + (Array.isArray(deployment?.positions) ? deployment.positions.length : 0), 0
  );
  const tradetronMirror = summarizeTradetronSnapshots(developerSnapshots);
  const unavailableMarketSymbols = executionCoverage?.unavailableMarketSymbols || [];
  const polReplacementAvailable = unavailableMarketSymbols.includes('MATICUSD') &&
    (market || []).some(row => String(row.symbol || '').toUpperCase() === 'POLUSD') &&
    !(executionCoverage?.configuredRouteSymbols || []).includes('POLUSD');
  const todayTrades = trades.filter(t => String(t.closed_at || '').slice(0,10) === today);
  const wins = todayTrades.filter(t => num(t.net_pnl) > 0).length;
  const loss = todayTrades.filter(t => num(t.net_pnl) < 0).length;
  const reasons = {};
  for (const s of signals) for (const r of (String(s.blocked_reasons || '').split(' · ').filter(Boolean))) reasons[r] = (reasons[r] || 0) + 1;
  const top = Object.entries(reasons).sort((a,b) => b[1]-a[1]).slice(0,3).map(x => x[0] + ' (' + x[1] + ')').join(', ');
  const visibleSignalStages = selectVisibleSignalRows(market, signals, DEFAULT_VISIBLE_MARKET_LIMIT);
  const visibleStageCoinCount = new Set(visibleSignalStages.map(s => s.symbol)).size;
  return <>
    <section className="cards">
      <Card label="EQUITY" value={money(settings.equity)} sub={'USD ledger converted at approx ₹' + USD_INR_RATE.toFixed(2) + '/USD'}/>
      <Card label="AVAILABLE" value={money(settings.available_balance)} sub="signal sizing reference"/>
      <Card label="REALIZED PNL" value={money(settings.realized_pnl)} sub="closed trades after fees"/>
      <Card label="UNREALIZED PNL" value={money(settings.unrealized_pnl)} sub="open positions"/>
      <Card label="TOTAL PNL" value={money(num(settings.realized_pnl)+num(settings.unrealized_pnl))} sub="realized + unrealized"/>
      <Card label="FEES TODAY" value={money(settings.fees_today)} sub="fees reported by activity callbacks"/>
      <Card label="OPEN POSITIONS" value={positions.length} sub="webhook-confirmed position ledger"/>
      <Card label="TT OPEN LEGS" value={developerDataProtected ? 'LOCKED' : developerApiConfigured ? tradetronMirror.openCount : '—'} sub="current Tradetron Developer API snapshot"/>
      <Card label="TT P&L SNAPSHOT" value={developerDataProtected ? 'LOCKED' : (developerApiConfigured && tradetronMirror.reportedPnl !== null ? money(tradetronMirror.reportedPnl) : '—')} sub="reported deployment P&L; shown separately"/>
      <Card label="TT SNAPSHOT ROWS" value={developerDataProtected ? 'LOCKED' : developerApiConfigured ? developerSnapshotRowCount : '—'} sub="raw API rows, including closed rows"/>
      <Card label="TT SIGNAL RECORDS" value={signalOrderStats?.total ?? '—'} sub="all states including expired; not fills"/>
      <Card label="TT SENT" value={signalOrderStats?.sent ?? '—'} sub="API accepted historically; may now be expired; not fills"/>
      <Card label="TT EVENTS" value={signalOrderStats?.events ?? '—'} sub="authenticated activity events received"/>
      <Card label="TODAY" value={todayTrades.length} sub={wins + ' wins / ' + loss + ' losses · ' + (todayTrades.length ? (wins/todayTrades.length*100).toFixed(1) : '0.0') + '% WR'}/>
    </section>
    <Panel title="Tradetron Execution Coverage">
      <section className="cards">
        <Card label="LIVE FUTURES SCANNED" value={market?.length || 0} sub="Delta India perpetual tickers" />
        <Card label="FUTURES SYMBOLS ROUTED" value={activeRoutedCount + ' / ' + (market?.length || 0)} sub={(executionCoverage?.configuredFuturesRoutes ?? 0) + ' worker-confirmed bridge(s); ' + (executionCoverage?.routingStatusSource === 'worker-heartbeat' ? 'live worker telemetry' : 'API config fallback')} />
        <Card label="PENDING SIGNAL RESERVATIONS" value={executionCoverage?.reservedSignals ?? '—'} sub={'unconfirmed signals within ' + (executionCoverage?.signalReservationTtlMinutes || 15) + 'm; not open positions'} />
        <Card label="SCAN-ONLY SYMBOLS" value={unroutedCount} sub="No Tradetron entry can be routed for these symbols" />
        <Card label="OPTIONS UNDERLYINGS" value="BTC · ETH · GOLD" sub="Gold contract symbol: XAUT" />
        <Card label="OPTIONS EXECUTION" value={executionCoverage?.optionsRouteConfigured ? 'CONFIGURED' : 'LOCKED'} sub={executionCoverage?.optionsRouteConfigured ? 'Dedicated options route detected; validate in Live Offline' : 'Options bridge and its Tradetron token are not configured'} />
      </section>
      <div className="lockedText"><b>Worker-confirmed futures basket:</b> {(executionCoverage?.routedSymbols || []).join(', ') || 'No worker-confirmed symbols yet'}<br/><small>Routing source: {executionCoverage?.routingStatusSource || 'API config fallback'}{executionCoverage?.routingObservedAt ? ' · heartbeat ' + new Date(executionCoverage.routingObservedAt).toLocaleTimeString('en-IN') : ''}. Unsupported symbols remain scan-only; direct Delta orders stay locked.</small></div>
      {unavailableMarketSymbols.length ? <div className="lockedText"><b>Configured but absent from the current live Delta market:</b> {unavailableMarketSymbols.join(', ')}.<br/><small>These are not worker-confirmed routes and must stay scan-only until the exchange exposes a matching live contract. {polReplacementAvailable ? 'POLUSD is present in the live market feed but is not configured for this Tradetron basket; add matching POLUSD_el / POLUSD_es variables and entry conditions in the linked Tradetron strategy before adding POLUSD to the worker allowlist.' : 'Any replacement symbol must first be configured in the linked Tradetron strategy variables and entry conditions; do not force-route a stale symbol.'}</small></div> : null}
    </Panel>
    <Panel title={'Full Delta Market Scanner · ' + (market?.length || 0) + ' live perpetuals · Signal Only'}>
      <MarketTable market={market} signals={signals} routedSymbols={executionCoverage?.routedSymbols || []}/>
    </Panel>
    <section className="grid2">
      <RiskGovernor signals={signals} health={health} positions={positions} onInspect={onInspect} inspect={inspect}/>
      <Panel title={'Signal Stages · ' + visibleStageCoinCount + ' coins · WATCH → SETUP → CONFIRMED'}>
        <div className="marketCount">Momentum and Scalping status for the same top {visibleStageCoinCount} coins shown in the market table. Missing snapshots are marked NO DATA; the full background scanner remains active.</div>
        <div className="tablewrap"><table><thead><tr><th>COIN</th><th>ENG</th><th>STAGE</th><th>SIDE</th><th>SCORE</th><th>QTY</th><th>NOTIONAL</th><th>RISK</th><th>READY</th><th>WHY BLOCKED</th></tr></thead><tbody>{visibleSignalStages.map(s => <tr key={s.symbol + ':' + s.strategy}><td className="symbol">{s.symbol}</td><td>{s.strategy === 'MOMENTUM' ? 'MOM' : 'SCALP'}</td><td>{s.snapshot_missing ? 'WATCH · NO DATA' : s.stage}</td><td className={s.side === 'BUY' ? 'up' : s.side === 'SELL' ? 'down' : 'muted'}>{s.side || '—'}</td><td><b>{s.snapshot_missing ? '—' : num(s.score).toFixed(0) + '/100'}</b></td><td>{s.snapshot_missing ? '—' : fmtQty(s.qty_contracts)}</td><td>{s.snapshot_missing ? '—' : money(s.notional)}</td><td>{s.snapshot_missing ? '—' : money(s.risk_usd)}</td><td className={s.snapshot_missing ? 'muted' : s.ready ? 'up' : 'down'}>{s.snapshot_missing ? '—' : s.ready ? 'YES' : 'NO'}</td><td className="muted">{s.snapshot_missing ? 'No signal snapshot available' : fmtReasons(s.blocked_reasons)}</td></tr>)}</tbody></table></div>
      </Panel>
    </section>
    <Panel title="Signal Mode"><div className="idle">SCANNER → TRADETRON → LIVE OFFLINE <span>No orders are sent by the scanner. Tradetron owns Live Offline execution and position management.</span></div></Panel>
    <TradetronActivity events={tradetronEvents} signalStats={signalOrderStats} webhookSecretConfigured={executionCoverage?.webhookSecretConfigured === true} />
    <TradetronDeveloperApiPanel configured={developerApiConfigured} sync={developerSync} deployments={developerSnapshots} privateDataProtected={developerDataProtected} notifications={developerNotifications} notificationSync={developerNotificationSync} pnlHistory={developerPnlHistory} />
    <Panel title="Idle Reason"><div className="idle">{idleFromSignals(signals)} <span>Top blocks: {top || 'none recorded'}</span></div></Panel>
    <Panel title="Engine Log · last 200 lines"><Log rows={logs || []}/></Panel>
    <div className="micro"><span className={health?.workerLeaseActive ? 'up' : 'down'}>Worker {health?.workerLeaseActive ? 'ONLINE' : 'OFFLINE'}</span><span>Last tick {settings.last_tick_at ? new Date(settings.last_tick_at).toLocaleTimeString('en-IN') : '—'}</span><span>Time drift {health?.timeDriftMs == null ? '—' : Math.round(health.timeDriftMs) + ' ms'}</span><span>Auto {settings.auto_trade ? 'ON' : 'OFF'}</span><span>Continuous {settings.continuous_mode ? 'ON' : 'OFF'}</span></div>
  </>;
}
function idleFromSignals(signals) {
  const c = {WATCH:0,SETUP:0,CONFIRMED:0};
  for (const s of signals) c[s.stage] = (c[s.stage] || 0) + 1;
  return 'Stages: WATCH ' + c.WATCH + ' · SETUP ' + c.SETUP + ' · CONFIRMED ' + c.CONFIRMED;
}
function fmtReasons(v) {
  if (Array.isArray(v)) return v.join(' · ');
  if (!v) return '—';
  return String(v);
}
function formatUnderlying(value) {
  const symbol = String(value || '').toUpperCase().replace(/USD$/, '');
  if (symbol === 'XAUT') return 'GOLD (XAUT)';
  return symbol || '—';
}
function fmtQty(v) {
  return num(v) === 0 ? '—' : num(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function MarketTable({ market, signals, routedSymbols = [] }) {
  const visibleMarket = selectVisibleMarketRows(market, DEFAULT_VISIBLE_MARKET_LIMIT);
  const map = new Map();
  for (const s of signals || []) {
    if (!map.has(s.symbol)) map.set(s.symbol, {});
    map.get(s.symbol)[s.strategy] = s;
  }
  return <><div className="marketCount">Showing {visibleMarket.length} of {(market || []).length} instruments · sorted by 24h turnover · full background scanner remains active.</div><div className="tablewrap"><table><thead><tr><th>#</th><th>COIN</th><th>PRICE</th><th>24H %</th><th>TURNOVER</th><th>VOL SPIKE</th><th>MOM</th><th>SCALP</th><th>TREND</th><th>SUPPORT</th><th>RESIST.</th><th>SIGNAL</th><th>TT ROUTE</th></tr></thead><tbody>{visibleMarket.map((m,i) => {
    const x = map.get(m.symbol) || {};
    const best = [x.MOMENTUM,x.SCALPING].filter(Boolean).sort((a,b) => num(b.score)-num(a.score))[0];
    const routeInfo = routeStatusForSymbol(m.symbol, [x.MOMENTUM, x.SCALPING], routedSymbols);
    return <tr key={m.symbol}><td>{i+1}</td><td className="symbol">{m.symbol}</td><td>{price(m.mark_price || m.close)}</td><td className={num(m.ltp_change_24h)>=0?'up':'down'}>{pct(m.ltp_change_24h)}</td><td>{money(m.turnover_usd)}</td><td>{best ? num(best.volume_spike).toFixed(2) + 'x' : '—'}</td><td><span className={x.MOMENTUM?.side==='BUY'?'up':x.MOMENTUM?.side==='SELL'?'down':''}>{x.MOMENTUM ? num(x.MOMENTUM.score).toFixed(0) + ' ' + (x.MOMENTUM.side || '') : '—'}</span></td><td><span className={x.SCALPING?.side==='BUY'?'up':x.SCALPING?.side==='SELL'?'down':''}>{x.SCALPING ? num(x.SCALPING.score).toFixed(0) + ' ' + (x.SCALPING.side || '') : '—'}</span></td><td>{best?.trend || '—'} / {best?.confirm_trend || '—'}</td><td>{price(best?.support)}</td><td>{price(best?.resistance)}</td><td><b className={best?.stage==='CONFIRMED'?'up':best?.stage==='SETUP'?'warn':'muted'}>{best?.stage || 'WATCH'}</b></td><td><button className={`tiny ${routeInfo.tone}`} disabled title={routeInfo.title}>{routeInfo.label}</button></td></tr>;
  })}</tbody></table></div></>;
}

function RiskGovernor({ signals, health, positions, onInspect, inspect, scoreMin = 80 }) {
  const selected = inspect;
  if (!selected) return <Panel title="Risk Governor"><div className="lockedText">No signal selected yet.</div></Panel>;
  const details = typeof selected.details === 'string' ? (() => { try { return JSON.parse(selected.details); } catch { return {}; } })() : (selected.details || {});
  const blockedText = Array.isArray(selected.blocked_reasons) ? selected.blocked_reasons.join(' · ') : String(selected.blocked_reasons || '');
  const gate = reason => !blockedText.toLowerCase().includes(reason.toLowerCase());
  const minimumScore = Math.max(80, num(scoreMin) || 80);
  const btcOverride = details.btcRegimeOverride === true;
  const gates = [
    ['Signal CONFIRMED', selected.stage === 'CONFIRMED' && num(selected.score) >= minimumScore, selected.stage + ' · min ' + minimumScore],
    ['Tradetron futures route', !blockedText.toLowerCase().includes('tradetron route unavailable'), blockedText.toLowerCase().includes('tradetron route unavailable') ? 'BLOCKED · symbol not mapped' : 'PASS'],
    ['Fee + spread vs 1R', num(selected.fee_risk_ratio) <= (selected.strategy === 'SCALPING' ? 0.25 : 0.20), (num(selected.fee_risk_ratio)*100).toFixed(1)+'% of 1R'],
    ['24h anti-chase', !selected.change_24h || (selected.side === 'BUY' ? num(selected.change_24h) <= 15 : selected.side === 'SELL' ? num(selected.change_24h) >= -15 : false), pct(selected.change_24h)],
    ['5m range <= 3.00 ATR', num(selected.atr_5m) > 0 && gate('5m range'), 'range gate'],
    ['EMA21 distance <= 2.50 ATR', !gate('Price > 2.50'), (selected.ema21 ? price(selected.ema21) : '—')],
    ['BTC regime', !gate('BTC regime') || btcOverride, btcOverride ? 'ADAPTIVE OVERRIDE · local ' + num(details.localScore).toFixed(0) + '/95' : (selected.btc_trend || '—')],
    ['Spread', !gate('Spread >'), num(selected.spread_pct).toFixed(3)+'% (max 0.35%)'],
    ['Fresh closed candles', !gate('Fresh closed candles'), details.candlesFresh === false ? 'STALE' : 'FRESH'],
    ['API / worker healthy', !!health?.workerLeaseActive && !!health?.exchangeHealthy && !!health?.tickFresh, health?.tickFresh ? 'PASS' : 'BLOCK'],
    ['Duplicate symbol', !positions.some(p => p.symbol === selected.symbol), positions.some(p => p.symbol === selected.symbol) ? 'BLOCK' : 'PASS'],
    ['Margin / min size', num(selected.qty_contracts) >= 1 && num(selected.notional) > 0, num(selected.qty_contracts) >= 1 ? 'PASS' : 'below minimum']
  ];
  return <Panel title="Risk Governor">
    <div className="inspectRow"><label>Inspect coin<select value={selected.symbol} onChange={e => onInspect(e.target.value)}>{[...new Set(signals.map(x=>x.symbol))].slice(0,50).map(x => <option key={x}>{x}</option>)}</select></label><span>{selected.strategy} · {selected.side || 'NO SIDE'} · {num(selected.score).toFixed(0)}/100</span></div>
    <div className="gates">{gates.map(([name,ok,detail]) => <div key={name}><b className={isPass(ok)?'pass':'block'}>{isPass(ok)?'PASS':'BLOCK'}</b><span>{name}</span><em>{detail}</em></div>)}</div>
  </Panel>;
}

function EngineView({ engine, signals }) {
  const rows = signals.filter(x => x.strategy === engine).sort((a,b) => num(b.score)-num(a.score));
  return <Panel title={engine + ' · Closed-Candle Signal Engine'}><div className="tablewrap"><table><thead><tr><th>COIN</th><th>STAGE</th><th>SIDE</th><th>SCORE</th><th>RSI</th><th>VOL</th><th>EMA21</th><th>ATR</th><th>SL</th><th>TP1</th><th>TP</th><th>QTY</th><th>RISK</th><th>BLOCKED</th></tr></thead><tbody>{rows.map(x => <tr key={x.symbol}><td className="symbol">{x.symbol}</td><td>{x.stage}</td><td className={x.side==='BUY'?'up':x.side==='SELL'?'down':''}>{x.side || '—'}</td><td><b>{num(x.score).toFixed(0)}</b></td><td>{num(x.rsi).toFixed(1)}</td><td>{num(x.volume_spike).toFixed(2)}x</td><td>{price(x.ema21)}</td><td>{price(x.atr_5m)}</td><td>{price(x.stop_price)}</td><td>{price(x.tp1_price)}</td><td>{price(x.tp_price)}</td><td>{fmtQty(x.qty_contracts)}</td><td>{money(x.risk_usd)}</td><td className="muted">{fmtReasons(x.blocked_reasons)}</td></tr>)}</tbody></table></div></Panel>;
}

function OptionsView({ signals, settings, optionCache = [], executionCoverage = null }) {
  const rows = (optionCache.length ? optionCache : signals.filter(x => x.strategy === 'OPTIONS_BUY' || x.strategy === 'OPTIONS_SELL'))
    .sort((a,b) => num(b.score) - num(a.score));
  const buys = rows.filter(x => x.strategy === 'OPTIONS_BUY');
  const sells = rows.filter(x => x.strategy === 'OPTIONS_SELL');
  return <>
    <section className="cards">
      <Card label="OPTIONS ENGINE" value={settings.options_enabled === false ? 'OFF' : 'ON'} sub="BTC / ETH / GOLD (XAUT) only"/>
      <Card label="BUY" value={settings.options_buy_enabled === false ? 'OFF' : 'ON'} sub="ATM / near-ITM · Δ 0.45–0.65"/>
      <Card label="SELL" value={settings.options_sell_enabled === false ? 'OFF' : 'ON'} sub="defined-risk spread only"/>
      <Card label="OPTIONS ROUTE" value={executionCoverage?.optionsRouteConfigured === true ? "CONFIGURED" : "LOCKED"} sub={executionCoverage?.optionsRouteConfigured === true ? "Dedicated Tradetron route reported by worker" : "Needs a dedicated Tradetron Options strategy and Railway token"}/>
    </section>
    <Panel title="Options BUY">
      <OptionTable rows={buys} type="BUY" />
    </Panel>
    <Panel title="Options SELL · Defined Risk">
      <OptionTable rows={sells} type="SELL" />
    </Panel>
  </>;
}

function OptionTable({ rows, type }) {
  return <div className="tablewrap"><table><thead><tr>
    <th>TIME</th><th>UNDERLYING</th><th>CONTRACT</th><th>TYPE</th><th>STRIKE</th><th>DTE</th><th>Δ</th><th>BID</th><th>ASK</th><th>SPREAD</th><th>OI</th><th>VOL</th><th>SCORE</th><th>STAGE</th><th>STATUS</th>
  </tr></thead><tbody>{rows.slice(0,30).map(s => {
    let d = s.details || {};
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
    return <tr key={s.id || s.symbol + s.strategy + s.captured_at}>
      <td>{s.cached_at ? new Date(s.cached_at).toLocaleTimeString('en-IN') : (s.captured_at ? new Date(s.captured_at).toLocaleTimeString('en-IN') : '—')}</td>
      <td className="symbol">{formatUnderlying(d.underlyingSymbol || s.underlying)}</td>
      <td className="symbol">{s.symbol}</td>
      <td>{d.optionType || '—'} / {type}</td>
      <td>{num(d.strike).toLocaleString('en-IN',{maximumFractionDigits:2})}</td>
      <td>{num(d.dte).toFixed(1)}</td>
      <td>{num(d.delta).toFixed(2)}</td>
      <td>{price(d.bid)}</td>
      <td>{price(d.ask)}</td>
      <td>{num(s.spread_pct).toFixed(2)}%</td>
      <td>{num(d.openInterest).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
      <td>{num(d.volume).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
      <td><b>{num(s.score).toFixed(0)}</b>/100</td>
      <td>{s.stage}</td>
      <td className={s.ready ? 'up' : 'down'}>{s.ready ? 'READY' : (fmtReasons(s.blocked_reasons).toLowerCase().includes('route unavailable') || fmtReasons(s.blocked_reasons).toLowerCase().includes('execution') ? 'LOCKED' : 'WAIT')}</td>
    </tr>;
  })}</tbody></table></div>;
}

function Positions({ rows = [], tradetronDeployments = [], snapshotsLocked = false }) {
  const mirror = summarizeTradetronSnapshots(tradetronDeployments);
  const pendingTradetronRows = mirror.openRows.map(position => ({
    execution_id: 'tt-api:' + position.key,
    opened_at: null,
    symbol: position.symbol,
    strategy: 'TT current snapshot',
    side: position.side,
    qty: position.quantity,
    entry_price: position.entryPrice,
    current_price: position.markPrice,
    stop_price: null,
    tp1_price: null,
    tp_price: null,
    origin: 'TRADETRON API',
    snapshot_only: true,
    snapshot_pnl: position.pnl,
    snapshot_value: position.marketValue,
    snapshot_status: position.status
  }));

  // Where an event-confirmed engine row matches a TT snapshot exactly, render
  // one enriched row rather than double-counting the same symbol/side/quantity.
  const matchKey = row => [
    String(row.symbol || '').toUpperCase(),
    String(row.side || '').toUpperCase(),
    Math.abs(Number(row.qty ?? row.quantity ?? 0))
  ].join('|');
  const usedSnapshotIndexes = new Set();
  const engineRows = (rows || []).map((position, index) => {
    const matchIndex = pendingTradetronRows.findIndex((snapshot, snapshotIndex) =>
      !usedSnapshotIndexes.has(snapshotIndex) && matchKey(snapshot) === matchKey(position)
    );
    const snapshot = matchIndex >= 0 ? pendingTradetronRows[matchIndex] : null;
    if (snapshot) usedSnapshotIndexes.add(matchIndex);
    return {
      ...position,
      execution_id: position.execution_id || 'engine:' + matchKey(position) + ':' + index,
      display_origin: snapshot ? 'ENGINE + TT API MATCH' : (position.origin || 'ENGINE / EVENT LEDGER'),
      snapshot_pnl: snapshot?.snapshot_pnl ?? null,
      snapshot_value: snapshot?.snapshot_value ?? null,
      current_price: snapshot?.current_price ?? position.current_price,
      snapshot_only: false
    };
  });
  const snapshotOnlyRows = pendingTradetronRows.filter((_, index) => !usedSnapshotIndexes.has(index));
  const displayRows = [...engineRows, ...snapshotOnlyRows];
  const matchedCount = usedSnapshotIndexes.size;

  return <Panel title="Positions · Tradetron + Engine Origin">
    <div className="lockedText">
      <b>Engine/event-ledger positions:</b> {(rows || []).length} · <b>Tradetron API open legs:</b> {mirror.openCount} · <b>matched rows:</b> {matchedCount}
      <p>Tradetron-only rows are read-only current-position snapshots. Entry price, market value, stop-loss and targets are shown only when a trusted source actually supplies them; the scanner does not estimate missing values.</p>
      {snapshotsLocked ? <p className="apiStateWarn">Private Tradetron snapshot is locked. Enter the configured ENGINE_SECRET in Settings to load current Tradetron rows.</p> : null}
    </div>
    <div className="tablewrap"><table>
      <thead><tr><th>TIME / SNAPSHOT</th><th>COIN</th><th>STRATEGY / SOURCE</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>MARK</th><th>VALUE</th><th>M2M / P&amp;L</th><th>SL</th><th>TP1</th><th>TP</th><th>PROTECTION</th><th>ORIGIN</th></tr></thead>
      <tbody>{displayRows.map((p, index) => {
        const snapshotOnly = p.snapshot_only === true;
        const protection = snapshotOnly ? 'NOT IN API' : (p.protection_verified ? 'VERIFIED' : (p.stop_price != null || p.tp_price != null ? 'LEVELS PRESENT' : 'NOT CONFIRMED'));
        const when = p.opened_at ? new Date(p.opened_at).toLocaleTimeString('en-IN') : (snapshotOnly ? 'Current snapshot' : '—');
        return <tr key={p.execution_id || 'position:' + index}>
          <td>{when}</td>
          <td className="symbol">{p.symbol || '—'}</td>
          <td>{p.strategy || (snapshotOnly ? 'TT current snapshot' : 'Engine position')}</td>
          <td className={p.side === 'BUY' ? 'up' : p.side === 'SELL' ? 'down' : 'muted'}>{p.side || '—'}</td>
          <td>{p.qty == null ? '—' : fmtQty(p.qty)}</td>
          <td>{p.entry_price == null ? '—' : price(p.entry_price)}</td>
          <td>{p.current_price == null ? '—' : price(p.current_price)}</td>
          <td>{p.snapshot_value == null ? '—' : money(p.snapshot_value)}</td>
          <td>{p.snapshot_pnl == null ? '—' : money(p.snapshot_pnl)}</td>
          <td>{p.stop_price == null ? '—' : price(p.stop_price)}</td>
          <td>{p.tp1_price == null ? '—' : price(p.tp1_price)}</td>
          <td>{p.tp_price == null ? '—' : price(p.tp_price)}</td>
          <td className={protection === 'VERIFIED' ? 'up' : 'muted'}>{protection}</td>
          <td>{p.display_origin || p.origin || 'TRADETRON API (READ-ONLY)'}</td>
        </tr>;
      })}{!displayRows.length ? <tr><td colSpan={14}>{snapshotsLocked ? 'No private snapshot rows are available while locked.' : 'No open positions are currently available from the engine ledger or the Tradetron snapshot.'}</td></tr> : null}</tbody>
    </table></div>
  </Panel>;
}
function TradeHistory({ trades, title }) {
  return <Panel title={title}><div className="tablewrap"><table><thead><tr><th>TIME</th><th>COIN</th><th>MODE</th><th>STRATEGY</th><th>SIDE</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>FEES</th><th>GROSS</th><th>NET</th><th>PNL%</th><th>R</th><th>EXIT REASON</th><th>RESULT</th></tr></thead><tbody>{trades.map(t => <tr key={t.execution_id}><td>{t.closed_at ? new Date(t.closed_at).toLocaleString('en-IN') : '—'}</td><td className="symbol">{t.symbol}</td><td>TRADetron OFFLINE</td><td>{t.strategy}</td><td className={t.side==='BUY'?'up':'down'}>{t.side}</td><td>{price(t.entry_price)}</td><td>{price(t.exit_price)}</td><td>{fmtQty(t.qty)}</td><td>{money(t.fees)}</td><td>{money(t.gross_pnl)}</td><td className={num(t.net_pnl)>=0?'up':'down'}>{money(t.net_pnl)}</td><td>{pct(t.pnl_pct)}</td><td>{num(t.r_multiple).toFixed(2)}</td><td>{t.exit_reason || '—'}</td><td>{t.result}</td></tr>)}</tbody></table></div></Panel>;
}
function PNL({ trades, settings }) {
  const net = trades.reduce((s,t)=>s+num(t.net_pnl),0);
  const fees = trades.reduce((s,t)=>s+num(t.fees),0);
  return <section className="cards"><Card label="REALIZED NET" value={money(net)} sub="Tradetron webhook-synced closed trades"/><Card label="FEES" value={money(fees)} sub="real fill commissions"/><Card label="EQUITY" value={money(settings.equity)} sub="current Demo equity"/><Card label="UNREALIZED" value={money(settings.unrealized_pnl)} sub="Tradetron activity feed"/></section>;
}
function Rotation({ ledger }) {
  const nowDay = new Date().toISOString().slice(0,10); const todayLedger = ledger.filter(x => String(x.created_at || '').slice(0,10) === nowDay); const released = todayLedger.reduce((s,x)=>s+num(x.released),0), retained = todayLedger.reduce((s,x)=>s+num(x.retained),0);
  return <><section className="cards"><Card label="EVENTS TODAY" value={todayLedger.length} sub="real profitable exits"/><Card label="RELEASED 90%" value={money(released)} sub="linked to execution ID"/><Card label="ALLOCATED" value={money(released)} sub="rotation released"/><Card label="RETAINED 10%" value={money(retained)} sub="ledger reserve"/></section><Panel title="Profit Rotation V3 Ledger"><div className="tablewrap"><table><thead><tr><th>TIME</th><th>EXECUTION ID</th><th>PROFIT</th><th>RELEASED</th><th>RETAINED</th><th>ROTATION ID</th></tr></thead><tbody>{ledger.map(x=><tr key={x.execution_id}><td>{new Date(x.created_at).toLocaleString('en-IN')}</td><td className="mono">{x.execution_id}</td><td className="up">{money(x.profit)}</td><td>{money(x.released)}</td><td>{money(x.retained)}</td><td>{x.rotation_id}</td></tr>)}</tbody></table></div></Panel></>;
}
function Analytics({ trades }) {
  const engines = ['MOMENTUM','SCALPING'].map(e => {
    const a = trades.filter(t=>t.strategy===e), wins=a.filter(t=>num(t.net_pnl)>0), losses=a.filter(t=>num(t.net_pnl)<0);
    const avgWin=wins.length?wins.reduce((s,t)=>s+num(t.net_pnl),0)/wins.length:0, avgLoss=losses.length?losses.reduce((s,t)=>s+num(t.net_pnl),0)/losses.length:0;
    const avgR=a.length?a.reduce((s,t)=>s+num(t.r_multiple),0)/a.length:0;
    return {e,a,wins,losses,wr:a.length?wins.length/a.length*100:0,avgWin,avgLoss,avgR,net:a.reduce((s,t)=>s+num(t.net_pnl),0)};
  });
  const sorted=[...trades].sort((a,b)=>num(b.net_pnl)-num(a.net_pnl)), excluded=sorted.slice(0,5).reduce((s,t)=>s+num(t.net_pnl),0), exNet=trades.reduce((s,t)=>s+num(t.net_pnl),0)-excluded;
  const byReason={}; for(const t of trades) byReason[t.exit_reason]=(byReason[t.exit_reason]||0)+1;
  return <><section className="panel"><div className="panelTitle"><h2>Per-engine statistics</h2></div><div className="engineStats">{engines.map(x=><div key={x.e}><h3>{x.e}</h3><b>{x.wr.toFixed(1)}% win rate</b><span>{x.a.length} trades · avg win {money(x.avgWin)} · avg loss {money(x.avgLoss)} · avg R {x.avgR.toFixed(2)} · net {money(x.net)}</span></div>)}</div></section><section className="cards"><Card label="NET EXCLUDING TOP 5 WINNERS" value={money(exNet)} sub="stress-test metric"/><Card label="EXIT REASONS" value={Object.keys(byReason).length} sub="SL / TP1 / TP / BE / TRAIL / TIMEOUT / MANUAL"/><Card label="TOTAL TRADES" value={trades.length} sub="real fills only"/></section><Panel title="Exits by reason"><div className="chips">{Object.entries(byReason).map(([k,v])=><span key={k}>{k}: {v}</span>)}</div></Panel><Panel title="Equity Curve"><div className="curve">{equityPoints(trades).map((x,i)=><span key={i} style={{height:Math.max(4,Math.min(150,70+x.delta))}} title={x.label}></span>)}</div></Panel></>;
}
function equityPoints(trades) {
  let total=0; return trades.slice().reverse().map(t=>{total+=num(t.net_pnl); return {delta:total,label:money(total)}});
}
function Testnet({ settings, health, busy, mutate, positions }) {
  return <><section className="cards"><Card label="ENVIRONMENT" value="SIGNAL ONLY" sub="production market feed"/><Card label="AUTO" value="BRIDGE ON" sub="Tradetron signal route"/><Card label="CONTINUOUS MODE" value="NO POSITION CAP" sub="scanner opportunity routing"/><Card label="VERIFIED OPEN POSITIONS" value={positions.length} sub="from synchronized position records"/></section><Panel title="Testnet Controls"><div className="lockedText">Direct Delta execution is disabled. Tradetron Live Offline is the only execution/simulation layer.</div><div className="statusLine">Worker {health?.workerLeaseActive?'ONLINE':'OFFLINE'} · Tick {health?.tickFresh?'FRESH':'STALE'} · Exchange {health?.exchangeHealthy?'HEALTHY':'DOWN'}</div><p className="muted">No scanner-side global position or rolling signal-count cap. Same-symbol duplicate protection, signal idempotency, technical-quality checks, per-trade sizing, route readiness and emergency stop remain active.</p></Panel></>;
}
function Settings({ settings, secret, setSecret, busy, mutate }) {
  const serverValues = useMemo(() => ({
    riskPct: settings.risk_pct ?? 0.3,
    momentumRr: settings.momentum_rr ?? 2.0,
    scalpingRr: settings.scalping_rr ?? 2.0,
    tp1Pct: settings.tp1_pct ?? 33,
    maxHoldMinutes: settings.max_hold_minutes ?? 240
  }), [settings.risk_pct, settings.momentum_rr, settings.scalping_rr, settings.tp1_pct, settings.max_hold_minutes]);
  const [draft, setDraft] = useState(serverValues);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [saveState, setSaveState] = useState('');

  useEffect(() => {
    if (!dirtyRef.current) setDraft(serverValues);
  }, [serverValues]);

  const changeDraft = (key, value) => {
    setDraft(current => ({ ...current, [key]: value }));
    dirtyRef.current = true;
    setDirty(true);
    setSaveState('Unsaved changes');
  };
  const discardChanges = () => {
    dirtyRef.current = false;
    setDraft(serverValues);
    setDirty(false);
    setSaveState('Changes discarded');
  };
  const saveSettings = async event => {
    event.preventDefault();
    const patch = {
      riskPct: Number(draft.riskPct),
      momentumRr: Number(draft.momentumRr),
      scalpingRr: Number(draft.scalpingRr),
      tp1Pct: Number(draft.tp1Pct),
      maxHoldMinutes: Number(draft.maxHoldMinutes)
    };
    if (!Object.values(patch).every(Number.isFinite)) {
      setSaveState('Enter a valid number in every field.');
      return;
    }
    if (patch.riskPct < 0.1 || patch.riskPct > 5 ||
        patch.momentumRr < 1 || patch.momentumRr > 5 ||
        patch.scalpingRr < 1 || patch.scalpingRr > 5 ||
        patch.tp1Pct < 1 || patch.tp1Pct > 99 ||
        patch.maxHoldMinutes < 1 || patch.maxHoldMinutes > 1440) {
      setSaveState('Please check the allowed range for each setting.');
      return;
    }
    setSaveState('Saving settings…');
    const saved = await mutate(patch);
    if (saved) {
      setDraft({
        riskPct: patch.riskPct,
        momentumRr: patch.momentumRr,
        scalpingRr: patch.scalpingRr,
        tp1Pct: patch.tp1Pct,
        maxHoldMinutes: patch.maxHoldMinutes
      });
      dirtyRef.current = false;
      setDirty(false);
      setSaveState('Settings saved to server.');
    } else {
      setSaveState('Save failed. Check the error message above and retry.');
    }
  };

  const statusClass = dirty ? 'pending' : saveState === 'Settings saved to server.' ? 'saved' : '';
  return <><Panel title="Server Controls"><div className="padSettings"><form className="settingsForm" onSubmit={saveSettings}>
    <div className="settings">
      <label>ENGINE_SECRET<input type="password" value={secret} onChange={e=>setSecret(e.target.value)} placeholder="Stored in this browser session only" autoComplete="current-password"/><small className="settingHint">This key stays in this browser session; it is not saved to scanner settings.</small></label>
      <label>Risk % per trade<input type="number" min="0.1" max="5" step="0.1" value={draft.riskPct} onChange={e=>changeDraft('riskPct',e.target.value)} disabled={busy} required/></label>
      <div className="lockedText"><b>Global scanner position cap: DISABLED.</b> Entries still require a valid signal, an available Tradetron route, acceptable margin and duplicate-symbol checks.</div>
      <label>Momentum RR<input type="number" min="1" max="5" step="0.1" value={draft.momentumRr} onChange={e=>changeDraft('momentumRr',e.target.value)} disabled={busy} required/></label>
      <label>Scalping RR<input type="number" min="1" max="5" step="0.1" value={draft.scalpingRr} onChange={e=>changeDraft('scalpingRr',e.target.value)} disabled={busy} required/></label>
      <label>TP1 %<input type="number" min="1" max="99" step="1" value={draft.tp1Pct} onChange={e=>changeDraft('tp1Pct',e.target.value)} disabled={busy} required/></label>
      <label>Max hold minutes<input type="number" min="1" max="1440" step="1" value={draft.maxHoldMinutes} onChange={e=>changeDraft('maxHoldMinutes',e.target.value)} disabled={busy} required/></label>
    </div>
    <div className="settingsActions">
      <span className={`saveStatus ${statusClass}`} aria-live="polite">{saveState || 'Save the current values to the server. Changes are kept only after a successful save.'}</span>
      <div className="settingsButtons"><button className="action" type="button" onClick={discardChanges} disabled={busy || !dirty}>Discard</button><button className="saveSettings" type="submit" disabled={busy} title="Persist these settings to the server">{busy ? 'Saving…' : 'Save Settings'}</button></div>
    </div>
  </form></div></Panel><Panel title="Strategy / Safety Defaults"><div className="ruleGrid"><span>Momentum: EMA9/21/50 + RSI 54–68 / 32–46 + adaptive volume gate + ATR stop ≥0.95%</span><span>Scalping: 1m/5m EMA + RSI + VWAP + adaptive volume gate + stop ≥0.75%</span><span>Confirmed score: ≥80 (hard floor)</span><span>Volume qualification: momentum default 0.75x with controlled sparse-volume fallback; scalping default 1.25x</span><span>Entry candle-range gate: Momentum ≤4.00x ATR; Scalping ≤3.00x ATR</span><span>Price-to-EMA21 distance: Momentum ≤3.50x ATR; Scalping ≤2.50x ATR</span><span>BTC regime: FLAT/mixed is neutral; only fully opposing BTC 5m+15m blocks; extreme opposing regimes can use the strong-local override</span><span>Fee + spread budget: 20% of 1R Momentum / 25% Scalping</span><span>Risk sizing: configurable per-trade equity risk (database default 1%), whole contracts, max 3x configurable notional cap</span><span>BTC override still respects spread, cost, stop, margin and duplicate-symbol prevention; scanner daily loss / trade-count quotas are disabled</span><span>Exits: TP1 33% at 1R, BE+fees, trail 1R, final TP default 2.5R</span></div></Panel><Panel title="Environment Lock"><div className="liveLock">PRODUCTION MARKET · SIGNAL ONLY. The scanner reads Delta India production market data and sends signals only; direct Delta order APIs are hard-locked.</div></Panel></>;
}
function TradetronActivity({ events, signalStats = null, webhookSecretConfigured = false }) {
  const rows = (events || []).slice(0, 30);
  const webhookUrl = typeof window !== 'undefined'
    ? window.location.origin + '/api/tradetron/webhook'
    : '/api/tradetron/webhook';
  return <Panel title="Tradetron Offline Activity · actual events received">
    <div className="lockedText"><b>Outbound webhook:</b> <span className="mono">{webhookUrl}</span><br/><small>{webhookSecretConfigured ? 'Webhook secret is configured in Vercel. Confirm Tradetron or a supported relay sends authenticated fill/position/exit callbacks to this URL.' : 'WEBHOOK SECRET MISSING in Vercel. Set TRADETRON_WEBHOOK_SECRET there, redeploy Vercel, and configure Tradetron or a supported relay to send it in the X-Tradetron-Webhook-Secret header. Until then, activity events cannot authenticate.'}</small></div>
    {rows.length ? <div className="tablewrap"><table><thead><tr><th>TIME</th><th>EVENT</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>PNL</th><th>STATUS</th><th>EXECUTION</th></tr></thead><tbody>{rows.map(e => <tr key={e.event_id}><td>{e.event_at ? new Date(e.event_at).toLocaleTimeString('en-IN') : new Date(e.created_at).toLocaleTimeString('en-IN')}</td><td>{e.event_type || 'UNKNOWN'}</td><td className="symbol">{e.symbol || '—'}</td><td className={e.side==='BUY'?'up':e.side==='SELL'?'down':''}>{e.side || '—'}</td><td>{fmtQty(e.qty)}</td><td>{price(e.price)}</td><td className={num(e.pnl)>=0?'up':'down'}>{e.pnl == null ? '—' : money(e.pnl)}</td><td>{e.status || '—'}</td><td className="mono">{e.execution_id || '—'}</td></tr>)}</tbody></table></div>
    : <div className="lockedText">No Tradetron outbound activity has reached the scanner yet. Scanner signals are accepted separately; once Tradetron posts activity/fills/errors to the webhook above, they will appear here.</div>}
    <div className="micro"><span>Signal records: {signalStats?.total ?? '—'}</span><span>API-accepted sent total: {signalStats?.sent ?? '—'} (not fills)</span><span>Current state · Pending: {signalStats?.pending ?? '—'} · Expired: {signalStats?.expired ?? '—'} · Failed: {signalStats?.failed ?? '—'}</span><span>Activity events: {signalStats?.events ?? '—'}</span><span>Webhook secret: {webhookSecretConfigured ? 'CONFIGURED' : 'MISSING'}</span><span>Live Offline: ACTIVE on Tradetron</span></div>
  </Panel>;
}

function safeDeveloperApiValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const scrub = input => {
      if (Array.isArray(input)) return input.map(scrub);
      if (!input || typeof input !== 'object') return input;
      return Object.fromEntries(Object.entries(input)
        .filter(([key]) => !/(secret|token|password|authorization|api.?key)/i.test(key))
        .map(([key, item]) => [key, scrub(item)]));
    };
    return JSON.stringify(scrub(value));
  } catch {
    return '[unavailable]';
  }
}

function TradetronDeveloperApiPanel({ configured = false, sync = null, deployments = [], privateDataProtected = false, notifications = [], notificationSync = null, pnlHistory = [] }) {
  if (privateDataProtected) {
    return <Panel title="Tradetron Live Mirror · read-only API + event callbacks"><div className="lockedText"><b className="apiStateWarn">PRIVATE ACCOUNT DATA LOCKED</b><p>For privacy, Tradetron deployment and position details are only returned when the correct ENGINE_SECRET is supplied. Enter it in Settings to view these read-only account snapshots.</p></div></Panel>;
  }
  const stale = !!sync?.last_success_at && Date.now() - Date.parse(sync.last_success_at) > 180000;
  const status = sync?.status || (configured ? 'WAITING FOR FIRST SYNC' : 'NOT CONFIGURED');
  const statusClass = status === 'OK' && !stale ? 'apiStateOk' : (status === 'ERROR' || stale ? 'apiStateError' : 'apiStateWarn');
  const mirror = summarizeTradetronSnapshots(deployments);
  const positionRows = (deployments || []).flatMap(deployment =>
    (Array.isArray(deployment.positions) ? deployment.positions : []).map((position, index) => ({
      deployment: deployment.deployment_name || String(deployment.deployment_id),
      index: index + 1,
      position: position && typeof position === 'object' && !Array.isArray(position) ? position : { value: position }
    }))
  );
  const positionKeys = [...new Set(positionRows.flatMap(row =>
    Object.keys(row.position).filter(key => !/(secret|token|password|authorization|api.?key)/i.test(key))
  ))].slice(0, 12);

  return <Panel title="Tradetron Live Mirror · current positions + P&L">
    <div className="lockedText">
      <b className={statusClass}>API sync: {status}{stale ? ' · STALE' : ''}</b><br/>
      <span>API key: {configured ? 'configured on the Railway worker' : 'not configured on the Railway worker'}</span><br/>
      <span>Last successful sync: {sync?.last_success_at ? new Date(sync.last_success_at).toLocaleString('en-IN') : '—'}</span><br/>
      <span>Deployments: {sync?.deployment_count ?? deployments.length} · Raw position rows: {sync?.position_count ?? mirror.totalRows} · Reported open legs: {mirror.openCount}</span>
      {sync?.last_error ? <p className="apiStateError">Last sync warning/error: {sync.last_error}</p> : null}
      {!configured ? <p>Add the read-only TRADETRON_DEVELOPER_API_KEY to the Railway worker, then apply the migration documented in db/migrations/20261012080000_tradetron_developer_api_sync.sql.</p> : null}
      {configured && !sync ? <p>Waiting for the worker's first sync. If this persists, confirm the Supabase migration has been applied.</p> : null}
      <p><b>Source of truth:</b> current open legs and deployment P&amp;L below come from the read-only Tradetron API snapshot. Closed-trade details, exit prices and fees require authenticated Tradetron activity callbacks; they are not inferred from a position snapshot.</p>
    </div>
    <section className="cards">
      <Card label="TT OPEN LEGS" value={configured ? mirror.openCount : '—'} sub={mirror.positionsHidden ? 'some position rows hidden by Tradetron' : 'reported by current API snapshot'} />
      <Card label="TT DEPLOYMENT P&L" value={mirror.reportedPnl === null ? '—' : money(mirror.reportedPnl)} sub="Tradetron-reported snapshot; not scanner ledger P&L" />
      <Card label="TT OPEN P&L" value={mirror.openPnl === null ? '—' : money(mirror.openPnl)} sub="sum of recognized open-row M2M values only" />
      <Card label="TT DEPLOYMENTS" value={mirror.deployments} sub="returned by read-only API" />
    </section>
    {deployments.length ? <div className="tablewrap"><table>
      <thead><tr><th>DEPLOYMENT</th><th>STATUS</th><th>MODE</th><th>BROKER</th><th>OPEN LEGS</th><th>REPORTED P&amp;L</th><th>CURRENCY</th><th>AS OF</th></tr></thead>
      <tbody>{deployments.map(row => <tr key={row.deployment_id}>
        <td>{row.deployment_name || row.deployment_id}<br/><small className="muted">ID {row.deployment_id}</small></td>
        <td>{row.status || '—'}</td><td>{row.deployment_type || '—'}</td><td>{row.broker || '—'}</td>
        <td>{row.positions_hidden ? 'HIDDEN' : (row.open_positions ?? '—') + ' reported'}<br/><small className="muted">{Array.isArray(row.positions) ? row.positions.length : 0} raw row(s)</small></td>
        <td className={num(row.pnl) >= 0 ? 'up' : 'down'}>{row.pnl == null ? '—' : money(row.pnl)}</td><td>{row.currency_code || '—'}</td>
        <td>{row.as_of ? new Date(row.as_of).toLocaleString('en-IN') : (row.last_success_at ? new Date(row.last_success_at).toLocaleString('en-IN') : '—')}</td>
      </tr>)}</tbody>
    </table></div> : <div className="lockedText">No deployment snapshot is available yet. A successful API response with an empty positions array means no visible position rows; it does not create placeholder trades.</div>}
    <div className="panelTitle"><h3>Current Open Positions · Tradetron</h3></div>
    {mirror.openRows.length ? <div className="tablewrap"><table>
      <thead><tr><th>DEPLOYMENT</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>LTP / MARK</th><th>VALUE</th><th>M2M / P&amp;L</th><th>STATUS</th></tr></thead>
      <tbody>{mirror.openRows.map(row => <tr key={row.key}>
        <td>{row.deploymentName}<br/><small className="muted">ID {row.deploymentId ?? '—'}</small></td>
        <td className="symbol" title={row.rawSymbol}>{row.symbol}</td>
        <td className={row.side === 'BUY' ? 'up' : row.side === 'SELL' ? 'down' : 'muted'}>{row.side || '—'}</td>
        <td>{row.quantity === null ? '—' : fmtQty(row.quantity)}</td>
        <td>{row.entryPrice === null ? '—' : price(row.entryPrice)}</td>
        <td>{row.markPrice === null ? '—' : price(row.markPrice)}</td>
        <td>{row.marketValue === null ? '—' : money(row.marketValue)}</td>
        <td className={row.pnl === null ? 'muted' : num(row.pnl) >= 0 ? 'up' : 'down'}>{row.pnl === null ? '—' : money(row.pnl)}</td>
        <td>{row.status}</td>
      </tr>)}</tbody>
    </table></div> : <div className="lockedText">
      {mirror.positionsHidden ? 'Tradetron is hiding position rows for at least one deployment. The reported open-leg count above is retained; the hidden rows are not treated as flat.' :
        mirror.openCount > 0 ? 'Tradetron reports open legs, but no individual row could be safely identified as open from the returned position fields. Expand raw data below to inspect the API field names.' :
          'The latest readable snapshot has no identifiable open position rows. When Tradetron exits a leg, this current-position view should remove it on the next successful snapshot sync.'}
    </div>}
    {positionRows.length ? <details className="rawSnapshot">
      <summary>Raw API rows ({positionRows.length}, including closed/historical rows)</summary>
      <div className="tablewrap"><table>
        <thead><tr><th>DEPLOYMENT</th><th>#</th>{positionKeys.map(key => <th key={key}>{key}</th>)}</tr></thead>
        <tbody>{positionRows.map((row) => <tr key={row.deployment + ':' + row.index}>
          <td>{row.deployment}</td><td>{row.index}</td>
          {positionKeys.map(key => <td key={key}>{safeDeveloperApiValue(row.position[key])}</td>)}
        </tr>)}</tbody>
      </table></div>
    </details> : null}
    <div className="lockedText"><b>Trade history / exit reconciliation:</b> {sync?.status === 'OK' ? 'position snapshot is syncing.' : 'position snapshot is not confirmed fresh.'} Developer API notifications below provide a read-only event timeline, but they are not converted to fill/trade rows. Actual per-trade entry/exit prices, fees and realized P&amp;L still require a verified trade-detail endpoint or authenticated fill data.</div>
    <div className="panelTitle"><h3>Recent Tradetron P&amp;L History · 5-minute snapshots</h3></div>
    <div className="lockedText"><span>Stored separately from closed-trade ledger. Repeated polls update the same five-minute bucket; old snapshots are pruned after 90 days.</span></div>
    {pnlHistory.length ? <div className="tablewrap"><table><thead><tr><th>CAPTURED</th><th>DEPLOYMENT</th><th>REPORTED P&amp;L</th><th>OPEN / TOTAL</th><th>STATUS</th></tr></thead><tbody>{pnlHistory.slice(0, 36).map(row => <tr key={row.snapshot_id}><td>{row.captured_at ? new Date(row.captured_at).toLocaleString('en-IN') : '—'}</td><td>{row.deployment_name || row.deployment_id}<br/><small className="muted">ID {row.deployment_id}</small></td><td className={row.reported_pnl == null ? 'muted' : num(row.reported_pnl) >= 0 ? 'up' : 'down'}>{row.reported_pnl == null ? '—' : row.currency_code === 'USD' || !row.currency_code ? money(row.reported_pnl) : String(row.reported_pnl) + ' ' + row.currency_code}</td><td>{row.open_positions ?? '—'} / {row.total_positions ?? '—'}</td><td>{row.status || '—'}</td></tr>)}</tbody></table></div> : <div className="lockedText">No P&amp;L history snapshots recorded yet. The first bucket is written after the next successful Developer API sync once the new database migration is applied.</div>}
    <div className="panelTitle"><h3>Tradetron Developer API Notifications · read-only timeline</h3></div>
    <div className="lockedText"><b className={notificationSync?.status === 'OK' ? 'apiStateOk' : notificationSync?.status === 'ERROR' ? 'apiStateError' : 'apiStateWarn'}>Notification sync: {notificationSync?.status || (configured ? 'WAITING FOR FIRST SYNC' : 'NOT CONFIGURED')}</b><br/><span>Last successful sync: {notificationSync?.last_success_at ? new Date(notificationSync.last_success_at).toLocaleString('en-IN') : '—'} · Returned notifications: {notificationSync?.notification_count ?? '—'}</span>{notificationSync?.last_error ? <p className="apiStateError">Notification sync warning/error: {notificationSync.last_error}</p> : null}<p>These are Tradetron account/deployment notices polled through the read-only Developer API. They are shown for audit context and are not proof of a fill; the scanner never converts notification text into a position or closed trade.</p></div>
    {notifications.length ? <div className="tablewrap"><table><thead><tr><th>TIME</th><th>DEPLOYMENT</th><th>TYPE</th><th>NOTICE</th></tr></thead><tbody>{notifications.slice(0, 30).map(row => <tr key={row.notification_id}><td>{row.event_at ? new Date(row.event_at).toLocaleString('en-IN') : (row.updated_at ? new Date(row.updated_at).toLocaleString('en-IN') : '—')}</td><td>{row.deployment_id || '—'}</td><td>{row.notification_type || 'NOTICE'}</td><td><b>{row.title || '—'}</b>{row.description ? <div className="muted">{row.description}</div> : null}</td></tr>)}</tbody></table></div> : <div className="lockedText">No notifications returned yet. If Tradetron returns a notification format the API client cannot recognize, the sync status will show an error rather than guessing the payload shape.</div>}
  </Panel>;
}

function Log({ rows }) {
  return <div className="log">{rows.length ? rows.map(x => {
    const diagnostic = getTradetronDiagnosticDetails(x.data);
    return <div key={x.id}>
      <small>{new Date(x.created_at).toLocaleTimeString()}</small>
      <b>{x.level}</b>
      <div className="logBody">
        <span>{x.message}</span>
        {diagnostic ? <div className="logDiagnostic">
          {diagnostic.symbol ? <span><b>Symbol</b> {diagnostic.symbol}</span> : null}
          {diagnostic.side ? <span><b>Side</b> {diagnostic.side}</span> : null}
          {diagnostic.strategy ? <span><b>Strategy</b> {diagnostic.strategy}</span> : null}
          {diagnostic.entryVariableKey ? <span><b>Entry key</b> <code>{diagnostic.entryVariableKey}</code></span> : null}
          {diagnostic.globalTriggerKey ? <span><b>Global trigger</b> <code>{diagnostic.globalTriggerKey}</code></span> : null}
          {diagnostic.payloadVariableCount !== null ? <span><b>Payload vars</b> {diagnostic.payloadVariableCount}</span> : null}
          {diagnostic.payloadVariableKeys.length ? <details><summary>Payload keys ({diagnostic.payloadVariableKeys.length})</summary><code>{diagnostic.payloadVariableKeys.join(' · ')}</code></details> : null}
        </div> : null}
      </div>
    </div>;
  }) : <div className="muted">Open Dashboard state includes the last 200 engine logs when the database is connected.</div>}</div>;
}

createRoot(document.getElementById('root')).render(<App/>);