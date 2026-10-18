import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { indiaDateKey } from './date-utils.js';
import GridStrategy from './GridStrategy.jsx';
import { routeStatusForSymbol } from './market-route-status.js';
import { getTradetronDiagnosticDetails } from './tradetron-diagnostics.js';
import { summarizeCurrentPositionCount, summarizeTradetronSnapshots } from './tradetron-position-sync.js';
import { buildTradetronPositionReconciliation } from './tradetron-reconciliation.js';
import { formatLastNonZeroPnlContext } from './tradetron-pnl-context.js';
import { DEFAULT_VISIBLE_MARKET_LIMIT, selectVisibleMarketRows, selectVisibleSignalRows } from './market-view.js';
import { assessDeltaRange, fmtMultiplier, fmtPrice as fmtRawPrice, fmtRsi, safeNum } from './formatters.js';
import { blockersDisplay, gateTooltip } from './gate-result.js';
import { buildRiskGovernorGates } from './risk-governor.js';
import { buildPnlHistoryInsights } from './pnl-history-insights.js';
import { contractValueForSymbol, stockTokenPnlTooltip, stockTokenOpenPnlTooltip } from './stock-token-pnl.js';
import { summarizeRotationLedger } from './rotation-ledger-state.js';
import { formatHealthAge, formatLeaseRemaining, getWorkerStatusDisplay } from './worker-status-display.js';

const loggedPnlAnomalies = new Set();

function hasRawPnlAnomaly(row) {
  const qty = safeNum(row?.quantity ?? row?.qty);
  const ltp = safeNum(row?.markPrice ?? row?.ltp);
  const pnl = safeNum(row?.pnl ?? row?.raw_pnl);
  if (qty === null || ltp === null || pnl === null) return false;
  const notional = Math.abs(qty * ltp);
  if (!(notional > 0) || Math.abs(pnl) <= notional * 0.5) return false;
  const symbol = String(row?.symbol || row?.rawSymbol || 'UNKNOWN').toUpperCase();
  const fingerprint = [symbol,qty,ltp,pnl].join(':');
  if (!loggedPnlAnomalies.has(fingerprint)) {
    loggedPnlAnomalies.add(fingerprint);
    console.warn('[Tradetron P&L anomaly]', {
      symbol, quantity: qty, ltp, rawPnl: pnl, absoluteNotional: notional,
      rule: 'abs(pnl) > abs(quantity * ltp) * 0.5',
      note: 'Raw API data is preserved; contract units/multiplier and P&L semantics are unverified.'
    });
  }
  return true;
}

const tabs = [
  ['dashboard','Dashboard'],['rotation','Profit Rotation'],['momentum','Momentum'],['momentum-history','Mom History'],
  ['scalping','Scalping'],['grid','Grid Strategy'],['scalp-history','Scalp History'],['options','Options'],['positions','Positions'],['trade-history','Trade History'],
  ['pnl','PNL'],
  // Paper Trading: placeholder only, not implemented.
  // Hidden until a real simulation engine exists.
  // If resurrecting: need dd_paper_trades table, paper engine,
  // and explicit "simulated" labeling distinct from live trades.
  ['testnet','Worker Status'],['live','Live Trading'],['analytics','Analytics'],['settings','Settings']
];
const num = v => Number.isFinite(+v) ? +v : 0;
const pct = v => { const n = safeNum(v); return n === null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; };
const USD_INR_RATE = Math.max(1, Number(import.meta.env.VITE_USD_INR_RATE || 96.83));
const money = v => { const n = safeNum(v); return n === null ? '—' : '₹' + (n * USD_INR_RATE).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
const price = v => { const n = safeNum(v); return n === null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 8 }); };
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
  const [secret, setSecret] = useState('');
  const secretRef = useRef(secret);
  const [error, setError] = useState('');
  const [marketError, setMarketError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [inspect, setInspect] = useState('');

  const load = useCallback(async () => {
    const cacheBust = '?t=' + Date.now();
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
        fetch('/api/engine/state' + cacheBust, { cache: 'no-store', credentials: 'same-origin' }).then(r => r.json())
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
  }, []);
  const unlockSession = async () => {
    const candidate = secretRef.current;
    if (!candidate) {
      setError('Enter ENGINE_SECRET once to unlock private dashboard data.');
      return false;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/engine/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ secret: candidate })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Session authentication failed');
      secretRef.current = '';
      setSecret('');
      setError('');
      await load();
      return true;
    } catch (e) {
      setError(e.message || 'Session authentication failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const lockSession = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/engine/session', {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not lock session');
      secretRef.current = '';
      setSecret('');
      setError('');
      await load();
    } catch (e) {
      setError(e.message || 'Could not lock session');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void load(); const id = setInterval(() => { void load(); }, 10000); return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(id); }, []);

  const settings = state?.settings || {};
  const trades = state?.trades || [];
  const positions = state?.positions || [];
  const accountDataProtected = state?.accountDataProtected === true;
  const tradeHistoryComplete = state?.tradeRowCount != null && Number(state.tradeRowCount) === trades.length;
  const rotationLedger = state?.ledger || [];
  const rotationLedgerComplete = state?.ledgerRowCount != null && Number(state.ledgerRowCount) === rotationLedger.length;
  const signals = latestSignals(state?.signalCache || state?.signals || []);
  const today = indiaDateKey(new Date());
  const todayTrades = trades.filter(t => indiaDateKey(t.closed_at) === today);
  const wins = todayTrades.filter(t => num(t.net_pnl) > 0).length;
  const losses = todayTrades.filter(t => num(t.net_pnl) < 0).length;

  const mutate = async patch => {
    if (!state || state.accountDataProtected === true) { setTab('settings'); setError('Unlock the private dashboard session in Settings before using controls.'); return false; }
    setBusy(true);
    try {
      const res = await fetch('/api/engine/toggle', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        credentials: 'same-origin',
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
  const workerEntrySafety = workerRoutingLog?.data?.tradetronEntrySafety || null;
  const workerGridEntrySafety = workerRoutingLog?.data?.gridEntrySafety || null;
  const normalizeSymbols = value => Array.isArray(value)
    ? [...new Set(value.map(symbol => String(symbol || '').trim().toUpperCase()).filter(Boolean))]
    : [];
  const workerSupportedSymbols = normalizeSymbols(workerRouting?.supportedSymbols);
  const workerConfiguredSymbols = normalizeSymbols(workerRouting?.configuredSymbols);
  const configuredRouteSymbols = workerConfiguredSymbols.length ? workerConfiguredSymbols : workerSupportedSymbols;
  const unavailableMarketSymbols = Array.isArray(workerRouting?.unavailableMarketSymbols)
    ? normalizeSymbols(workerRouting.unavailableMarketSymbols)
    : configuredRouteSymbols.filter(symbol => !workerSupportedSymbols.includes(symbol));

  // A fresh snapshot can still be over the configured cap. Trust means the
  // count is usable; it does not mean another entry is safe.
  const configuredMaxOpenPositions = safeNum(settings.max_open_positions);
  const currentTradetronOpenPositionCount = safeNum(workerEntrySafety?.openPositionCount);
  const globalPositionCapReached = configuredMaxOpenPositions !== null &&
    configuredMaxOpenPositions >= 1 &&
    currentTradetronOpenPositionCount !== null &&
    currentTradetronOpenPositionCount >= configuredMaxOpenPositions;
  const globalPositionCapReason = globalPositionCapReached
    ? 'Global open-position limit reached (' + currentTradetronOpenPositionCount + '/' +
      configuredMaxOpenPositions + '); new entries blocked'
    : null;
  const effectiveEntrySafety = workerEntrySafety ? {
    ...workerEntrySafety,
    maxOpenPositions: configuredMaxOpenPositions,
    capReached: globalPositionCapReached,
    blocked: workerEntrySafety.trusted !== true || globalPositionCapReached,
    reason: workerEntrySafety.trusted !== true
      ? (workerEntrySafety.reason || 'POSITION_SNAPSHOT_UNTRUSTED')
      : globalPositionCapReason
  } : null;
  const effectiveGridEntrySafety = workerGridEntrySafety ? {
    ...workerGridEntrySafety,
    blocked: workerGridEntrySafety.blocked === true ||
      workerEntrySafety?.trusted !== true ||
      globalPositionCapReached,
    reason: workerGridEntrySafety.blocked === true
      ? (workerGridEntrySafety.reason || 'GRID_POSITION_SAFETY_BLOCKED')
      : workerEntrySafety?.trusted !== true
        ? (workerEntrySafety?.reason || 'POSITION_SNAPSHOT_UNTRUSTED')
        : globalPositionCapReason
  } : null;

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
    routingObservedAt: workerRoutingLog?.created_at || null,
    tradetronEntrySafety: effectiveEntrySafety,
    gridEntrySafety: effectiveGridEntrySafety
  } : (state?.executionCoverage || null);

  // These values are consumed by the Momentum and Scalping routes, so keep
  // them in App scope rather than inside Dashboard.
  const routeSafetyRequired = Number(executionCoverage?.configuredFuturesRoutes || 0) > 0;
  const routeSafetyBlocked = routeSafetyRequired && (executionCoverage?.tradetronEntrySafety?.trusted !== true || executionCoverage?.tradetronEntrySafety?.blocked === true || executionCoverage?.tradetronEntrySafety?.capReached === true);
  const routeSafetyReason = executionCoverage?.tradetronEntrySafety?.reason ||
    (executionCoverage?.tradetronEntrySafety?.configured === true ? 'SNAPSHOT_NOT_VERIFIED' : 'DEVELOPER_API_NOT_CONFIGURED');
  const appTradetronSnapshots = state?.tradetronDeveloperDataProtected === true
    ? []
    : (state?.tradetronDeveloperSnapshots || []);
  const appTradetronMirror = summarizeTradetronSnapshots(appTradetronSnapshots);
  const eventPositionSymbols = (Array.isArray(positions) ? positions : [])
    .filter(position => Math.abs(Number(position?.qty) || 0) > 0)
    .map(position => String(position?.symbol || '').toUpperCase());
  const openPositionSymbols = new Set([
    ...eventPositionSymbols,
    ...appTradetronMirror.openRows.map(position => String(position.symbol || '').toUpperCase())
  ].filter(Boolean));

  return <div className="terminal">
    <header className="topbar">
      <div>
        <div className="brand">D <span>DEALDOST</span></div>
        <div className="sub">DELTA INDIA · PERPETUAL FUTURES COMMAND CENTER</div>
      </div>
      <div className="headerRight">
        <span>BUILD v2.0.20261015.01</span>
        <span>UTC {new Date(clock).toISOString().slice(11,19)}</span>
        <span>LOCAL {new Date(clock).toLocaleTimeString('en-IN')}</span>
        <b className="badge test">LIVE MARKET · SIGNAL ONLY</b>
        <b className="badge lock">LIVE LOCKED</b>
        <button className="estop" disabled={busy || !state || accountDataProtected} onClick={() => mutate({ emergencyStop: !settings.emergency_stop })}>
          {settings.emergency_stop ? 'RELEASE E-STOP' : 'EMERGENCY STOP'}
        </button>
      </div>
    </header>
    {stale ? <div className="danger">⚠ WORKER HEARTBEAT / MARKET TICK STALE FOR MORE THAN 3 MINUTES. NEW ENTRIES MUST BE TREATED AS BLOCKED.</div> : null}
    {error || marketError ? <div className="error">{error || marketError}</div> : null}
    <nav>{tabs.map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'live' ? ' 🔒' : ''}</button>)}</nav>
    {accountDataProtected ? <div className="danger">🔒 ACCOUNT DATA LOCKED — Enter ENGINE_SECRET in Settings to view private positions, closed trades, P&amp;L, rotation ledger, Grid state, and account-specific logs. Hidden data is not zero.</div> : null}

    {tab === 'dashboard' && <Dashboard market={market} settings={settings} health={health} trades={trades} positions={positions} accountDataProtected={accountDataProtected} signals={signals} signalOrderStats={state?.signalOrderStats || null} tradesComplete={tradeHistoryComplete} tradeRowCount={state?.tradeRowCount ?? null} tradetronEvents={state?.tradetronEvents || []} executionCoverage={executionCoverage} developerSync={state?.tradetronDeveloperSync || null} developerSnapshots={state?.tradetronDeveloperSnapshots || []} developerApiConfigured={executionCoverage?.tradetronDeveloperApiConfigured === true} developerDataProtected={state?.tradetronDeveloperDataProtected === true} developerNotifications={state?.tradetronDeveloperNotifications || []} developerNotificationSync={state?.tradetronDeveloperNotificationSync || null} developerPnlHistory={state?.tradetronDeveloperPnlHistory || []} onInspect={setInspect} inspect={selected} logs={state?.logs || []} />}
    {tab === 'rotation' && <Rotation ledger={rotationLedger} accountDataProtected={accountDataProtected} ledgerComplete={rotationLedgerComplete} ledgerRowCount={state?.ledgerRowCount ?? null} />}
    {tab === 'momentum' && <EngineView engine="MOMENTUM" signals={signals} entrySafetyBlocked={routeSafetyBlocked} entrySafetyReason={routeSafetyReason} openPositionSymbols={openPositionSymbols} />}
    {tab === 'momentum-history' && <TradeHistory trades={trades.filter(t => t.strategy === 'MOMENTUM')} title="Momentum History" strategy="MOMENTUM" apiDerivedTrades={state?.apiDerivedTrades || []} accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} />}
    {tab === 'scalping' && <EngineView engine="SCALPING" signals={signals} entrySafetyBlocked={routeSafetyBlocked} entrySafetyReason={routeSafetyReason} openPositionSymbols={openPositionSymbols} />}
    {tab === 'grid' && <GridStrategy settings={settings} market={market} busy={busy} mutate={mutate} accountDataProtected={accountDataProtected} gridEntrySafety={executionCoverage?.gridEntrySafety || null} />}
    {tab === 'options' && <OptionsView signals={signals} settings={settings} optionCache={state?.optionCache || []} executionCoverage={state?.executionCoverage || null} />}
    {tab === 'scalp-history' && <TradeHistory trades={trades.filter(t => t.strategy === 'SCALPING')} title="Scalping History" strategy="SCALPING" apiDerivedTrades={state?.apiDerivedTrades || []} accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} />}
    {tab === 'positions' && <><Positions rows={positions} tradetronDeployments={state?.tradetronDeveloperDataProtected ? [] : (state?.tradetronDeveloperSnapshots || [])} marketCache={state?.marketCache || []} snapshotsLocked={state?.tradetronDeveloperDataProtected === true} accountDataProtected={accountDataProtected} /><TradetronPositionReconciliationPanel deployments={state?.tradetronDeveloperDataProtected ? [] : (state?.tradetronDeveloperSnapshots || [])} enginePositions={positions} syncState={state?.tradetronDeveloperSync || null} privateDataProtected={accountDataProtected || state?.tradetronDeveloperDataProtected === true} /><TradetronDeveloperApiPanel configured={executionCoverage?.tradetronDeveloperApiConfigured === true} sync={state?.tradetronDeveloperSync || null} deployments={state?.tradetronDeveloperSnapshots || []} privateDataProtected={state?.tradetronDeveloperDataProtected === true} notifications={state?.tradetronDeveloperNotifications || []} notificationSync={state?.tradetronDeveloperNotificationSync || null} pnlHistory={state?.tradetronDeveloperPnlHistory || []} marketCache={state?.marketCache || []} /></>}
    {tab === 'trade-history' && <><TradeHistory trades={trades} title="Trade History · Webhook-Synced Tradetron Records" apiDerivedTrades={state?.apiDerivedTrades || []} accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} /><TradetronActivity events={state?.tradetronEvents || []} signalStats={state?.signalOrderStats || null} webhookSecretConfigured={executionCoverage?.webhookSecretConfigured === true} accountDataProtected={accountDataProtected} /></>}
    {tab === 'pnl' && <><PNL trades={trades} settings={settings} accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} tradeRowCount={state?.tradeRowCount ?? null} apiDerivedTrades={state?.apiDerivedTrades || []} apiDerivedTradeCount={state?.apiDerivedTradeCount ?? null} developerSnapshots={state?.tradetronDeveloperSnapshots || []} developerDataProtected={state?.tradetronDeveloperDataProtected === true} developerApiConfigured={executionCoverage?.tradetronDeveloperApiConfigured === true} marketCache={state?.marketCache || []} /><TradetronDeveloperApiPanel configured={executionCoverage?.tradetronDeveloperApiConfigured === true} sync={state?.tradetronDeveloperSync || null} deployments={state?.tradetronDeveloperSnapshots || []} privateDataProtected={state?.tradetronDeveloperDataProtected === true} notifications={state?.tradetronDeveloperNotifications || []} notificationSync={state?.tradetronDeveloperNotificationSync || null} pnlHistory={state?.tradetronDeveloperPnlHistory || []} marketCache={state?.marketCache || []} /></>}
    {tab === 'paper' && <Panel title="Paper Trading"><div className="lockedText">Scanner is signal-only. No Delta order is placed here; Tradetron Live Offline runs the simulated execution.</div></Panel>}
    {tab === 'testnet' && <Testnet settings={settings} health={health} busy={busy} mutate={mutate} positions={positions} tradetronDeployments={state?.tradetronDeveloperDataProtected ? [] : (state?.tradetronDeveloperSnapshots || [])} developerSync={state?.tradetronDeveloperSync || null} developerApiConfigured={executionCoverage?.tradetronDeveloperApiConfigured === true} entrySafety={executionCoverage?.tradetronEntrySafety || null} accountDataProtected={accountDataProtected} />}
    {tab === 'live' && <Panel title="Live Trading"><div className="liveLock">🔒 DIRECT DELTA EXECUTION LOCKED<br/><small>The scanner never sends production orders. Future live execution must be enabled manually in Tradetron.</small></div></Panel>}
    {tab === 'analytics' && <Analytics trades={trades} accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} tradeRowCount={state?.tradeRowCount ?? null} />}
    {tab === 'settings' && <Settings settings={settings} secret={secret} setSecret={v => { secretRef.current = v; setSecret(v); }} busy={busy} mutate={mutate} onUnlock={unlockSession} onLock={lockSession} authenticated={state?.accountDataProtected === false} />}
    <footer>Delta Exchange India · production market feed · Tradetron signal-only · no direct orders · no guaranteed win rate</footer>
  </div>;
}

function Panel({ title, children }) {
  return <section className="panel"><div className="panelTitle"><h2>{title}</h2></div><div className="pad">{children}</div></section>;
}
function Card({ label, value, sub, title, tone = '' }) {
  const toneClass = tone === 'critical' ? ' card-critical' : tone === 'warning' ? ' card-warning' : '';
  return <div className={'card' + toneClass} title={title}><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>;
}
function Dashboard({ market, settings, health, trades, positions, accountDataProtected = false, signals, signalOrderStats = null, tradesComplete = false, tradeRowCount = null, tradetronEvents = [], executionCoverage = null, developerSync = null, developerSnapshots = [], developerApiConfigured = false, developerDataProtected = false, developerNotifications = [], developerNotificationSync = null, developerPnlHistory = [], onInspect, inspect, logs }) {
  const today = indiaDateKey(new Date());
  const currentPositionSummary = summarizeCurrentPositionCount({ eventPositions: positions, deployments: developerSnapshots, syncState: developerSync, configured: developerApiConfigured });
  const configuredRouteSymbols = new Set(executionCoverage?.routedSymbols || []);
  const activeRoutedCount = configuredRouteSymbols.size
    ? (market || []).filter(row => configuredRouteSymbols.has(String(row.symbol || '').toUpperCase())).length
    : Math.min(executionCoverage?.routedFuturesSymbols || 0, market?.length || 0);
  const unroutedCount = Math.max(0, (market?.length || 0) - activeRoutedCount);
  const developerSnapshotRowCount = (developerSnapshots || []).reduce(
    (count, deployment) => count + (Array.isArray(deployment?.positions) ? deployment.positions.length : 0), 0
  );
  const tradetronMirror = summarizeTradetronSnapshots(developerSnapshots);
  const lastNonZeroPnlContext = formatLastNonZeroPnlContext(developerPnlHistory);
  const routeSafetyRequired = Number(executionCoverage?.configuredFuturesRoutes || 0) > 0;
  const routeSafetyBlocked = routeSafetyRequired && (executionCoverage?.tradetronEntrySafety?.trusted !== true || executionCoverage?.tradetronEntrySafety?.blocked === true || executionCoverage?.tradetronEntrySafety?.capReached === true);
  const routeSafetyReason = executionCoverage?.tradetronEntrySafety?.reason ||
    (executionCoverage?.tradetronEntrySafety?.configured === true ? 'SNAPSHOT_NOT_VERIFIED' : 'DEVELOPER_API_NOT_CONFIGURED');
  const eventPositionSymbols = (positions || []).filter(position => Math.abs(Number(position?.qty) || 0) > 0).map(position => String(position?.symbol || '').toUpperCase());
  const openPositionSymbols = new Set([...eventPositionSymbols, ...tradetronMirror.openRows.map(position => String(position.symbol || '').toUpperCase())].filter(Boolean));
  const snapshotPositionRows = tradetronMirror.openRows.map(position => ({
    symbol: position.symbol, side: position.side, qty: Math.abs(Number(position.quantity) || 0),
    strategy: 'TT_API_SNAPSHOT', origin: 'TRADETRON_API_SNAPSHOT', snapshot_only: true
  }));
  const riskGovernorPositions = [...(positions || []), ...snapshotPositionRows.filter(snapshot => !eventPositionSymbols.includes(snapshot.symbol))];
  const unavailableMarketSymbols = executionCoverage?.unavailableMarketSymbols || [];
  const polReplacementAvailable = unavailableMarketSymbols.includes('MATICUSD') &&
    (market || []).some(row => String(row.symbol || '').toUpperCase() === 'POLUSD') &&
    !(executionCoverage?.configuredRouteSymbols || []).includes('POLUSD');
  const todayTrades = trades.filter(t => indiaDateKey(t.closed_at) === today);
  const closedPnlValues = trades.map(trade => safeNum(trade.net_pnl));
  const closedPnlComplete = trades.length > 0 && tradesComplete && closedPnlValues.every(value => value !== null);
  const realizedPnl = closedPnlComplete ? closedPnlValues.reduce((sum, value) => sum + value, 0) : null;
  const measuredTodayTrades = todayTrades.filter(trade => safeNum(trade.net_pnl) !== null);
  const wins = measuredTodayTrades.filter(t => safeNum(t.net_pnl) > 0).length;
  const loss = measuredTodayTrades.filter(t => safeNum(t.net_pnl) < 0).length;
  const unrealizedPnl = safeNum(settings.unrealized_pnl);
  const openPnlComplete = positions.length === 0 || unrealizedPnl !== null;
  // A configured Tradetron account must also have a fresh, complete zero-open
  // snapshot before scanner-ledger P&L can be presented as a complete account
  // total. Raw deployment P&L is intentionally not merged without verified
  // semantics, currency, and mark-to-market meaning.
  const apiPositionCoverageComplete = !developerApiConfigured ||
    (currentPositionSummary.status === 'FRESH' && currentPositionSummary.count === 0 && positions.length === 0);
  const totalPnlComplete = closedPnlComplete && openPnlComplete && apiPositionCoverageComplete;
  const totalPnl = totalPnlComplete
    ? (closedPnlComplete ? realizedPnl : 0) + (positions.length > 0 ? unrealizedPnl : 0)
    : null;
  const todayFeesComplete = tradesComplete && todayTrades.length > 0 && todayTrades.every(trade => safeNum(trade.fees) !== null);
  const todayFees = todayFeesComplete
    ? todayTrades.reduce((sum, trade) => sum + safeNum(trade.fees), 0)
    : null;
  const reasons = {};
  for (const s of signals) for (const r of (String(s.blocked_reasons || '').split(' · ').filter(Boolean))) reasons[r] = (reasons[r] || 0) + 1;
  const top = Object.entries(reasons).sort((a,b) => b[1]-a[1]).slice(0,3).map(x => x[0] + ' (' + x[1] + ')').join(', ');
  const visibleSignalStages = selectVisibleSignalRows(market, signals, DEFAULT_VISIBLE_MARKET_LIMIT);
  const visibleStageCoinCount = new Set(visibleSignalStages.map(s => s.symbol)).size;
  return <>
    <section className="cards">
      <Card label="EQUITY" value={accountDataProtected ? 'LOCKED' : money(settings.equity)} sub={accountDataProtected ? 'enter ENGINE_SECRET to view balance' : 'USD ledger converted at approx ₹' + USD_INR_RATE.toFixed(2) + '/USD'}/>
      <Card label="AVAILABLE" value={accountDataProtected ? 'LOCKED' : money(settings.available_balance)} sub={accountDataProtected ? 'account-specific sizing is hidden' : 'signal sizing reference'}/>
      <Card label="REALIZED PNL" value={accountDataProtected ? 'LOCKED' : !tradesComplete ? 'INCOMPLETE DATA' : !trades.length ? '—' : closedPnlComplete ? money(realizedPnl) : 'INCOMPLETE DATA'} sub={accountDataProtected ? 'enter ENGINE_SECRET to view verified closed-trade P&L' : !tradesComplete ? 'loaded ' + trades.length + ' of ' + (tradeRowCount ?? 'an unknown number of') + ' stored rows; total P&L not complete' : !trades.length ? 'no authenticated closed trades recorded' : closedPnlComplete ? 'all stored closed-trade P&L values present' : 'one or more closed-trade P&L values are missing'}/>
      <Card label="UNREALIZED PNL" value={accountDataProtected ? 'LOCKED' : positions.length ? (unrealizedPnl === null ? 'NO DATA' : money(unrealizedPnl)) : developerApiConfigured && (currentPositionSummary.status !== 'FRESH' || currentPositionSummary.count > 0) ? 'NO DATA' : '—'} sub={accountDataProtected ? 'enter ENGINE_SECRET to view position-ledger M2M' : positions.length ? (unrealizedPnl === null ? 'open positions exist; verified mark-to-market is unavailable' : 'engine/webhook position ledger') : developerApiConfigured && currentPositionSummary.status !== 'FRESH' ? 'Tradetron position state is ' + currentPositionSummary.status + '; no webhook rows does not prove flat' : developerApiConfigured && currentPositionSummary.count > 0 ? 'Tradetron reports open positions; verified mark-to-market and units are unavailable' : developerApiConfigured ? 'fresh Tradetron snapshot reports no open positions; scanner M2M remains separate' : 'no webhook-confirmed open positions'}/>
      <Card label="TOTAL PNL" value={accountDataProtected ? 'LOCKED' : !tradesComplete ? 'INCOMPLETE DATA' : totalPnlComplete ? money(totalPnl) : (trades.length || positions.length || developerApiConfigured ? 'INCOMPLETE DATA' : '—')} sub={accountDataProtected ? 'account ledger is private' : developerApiConfigured && !apiPositionCoverageComplete ? 'Tradetron position coverage is not reconciled into confirmed scanner P&L; raw deployment P&L remains separate' : !tradesComplete ? 'full closed-trade history is not loaded' : 'only shown when each included ledger component is available'}/>
      <Card label="FEES TODAY" value={accountDataProtected ? 'LOCKED' : !tradesComplete ? 'INCOMPLETE DATA' : !todayTrades.length ? '—' : todayFeesComplete ? money(todayFees) : 'NO DATA'} sub={accountDataProtected ? 'enter ENGINE_SECRET to view verified trade fees' : !tradesComplete ? 'full trade-history coverage is not confirmed' : !todayTrades.length ? 'no authenticated closed-trade rows today' : todayFeesComplete ? 'sum of recorded today-trade fees' : 'one or more today-trade fee values are missing'}/>
      <Card label="OPEN POSITIONS" value={accountDataProtected ? 'LOCKED' : currentPositionSummary.count === null ? currentPositionSummary.status : currentPositionSummary.count} sub={accountDataProtected ? 'hidden data is not zero' : currentPositionSummary.detail}/>
      <Card label="WEBHOOK POSITION LEDGER" value={accountDataProtected ? 'LOCKED' : positions.length} sub={accountDataProtected ? 'private event ledger' : 'positions confirmed by authenticated callback processing; distinct from current API snapshots'}/>
      <Card label="TT OPEN LEGS" value={developerDataProtected ? 'LOCKED' : developerApiConfigured ? (tradetronMirror.openCount === null ? 'UNKNOWN' : tradetronMirror.openCount) : '—'} sub={developerDataProtected ? 'private account snapshot' : tradetronMirror.openCount === null ? 'no verified count; do not interpret as zero' : 'current Tradetron Developer API snapshot'}/>
      <Card label="TRADETRON SNAPSHOT P&L" value={developerDataProtected ? 'LOCKED' : (developerApiConfigured && tradetronMirror.reportedPnl !== null ? fmtRawPrice(tradetronMirror.reportedPnl, 2) : 'NO DATA')} title="Raw deployment-level value from API. Actual realized P&L requires authenticated trade-detail data." sub={"Raw deployment P&L; " + (tradetronMirror.reportedPnlCurrencyCode ? "API reports " + tradetronMirror.reportedPnlCurrencyCode + " currency; " : "currency not identified by API; ") + "P&L meaning is not independently verified; separate from scanner ledger" + (lastNonZeroPnlContext ? " · " + lastNonZeroPnlContext : "")}/>
      <Card label="TT SNAPSHOT ROWS" value={developerDataProtected ? 'LOCKED' : developerApiConfigured ? developerSnapshotRowCount : '—'} sub="raw API rows, including closed rows"/>
      <Card label="TT SIGNAL RECORDS" value={accountDataProtected ? 'LOCKED' : signalOrderStats?.total ?? '—'} sub={accountDataProtected ? 'private signal history' : 'all states including expired; not fills'}/>
      <Card label="TT SENT" value={accountDataProtected ? 'LOCKED' : signalOrderStats?.sent ?? '—'} sub={accountDataProtected ? 'private signal submission history' : 'API accepted historically; may now be expired; not fills'}/>
      <Card label="TT EVENTS" value={accountDataProtected ? 'LOCKED' : signalOrderStats?.events ?? '—'} sub={accountDataProtected ? 'private activity history' : 'authenticated activity events received'}/>
      <Card label="TODAY CLOSED TRADES" value={accountDataProtected ? 'LOCKED' : tradesComplete ? todayTrades.length : 'INCOMPLETE DATA'} sub={accountDataProtected ? 'enter ENGINE_SECRET to view closed-trade counts' : !tradesComplete ? 'trade row count incomplete; today count may be incomplete' : measuredTodayTrades.length ? (wins + ' wins / ' + loss + ' losses · ' + (wins/measuredTodayTrades.length*100).toFixed(1) + '% WR on ' + measuredTodayTrades.length + ' rows with recorded P&L') : (todayTrades.length ? 'WIN RATE NO DATA — trade P&L missing' : 'no authenticated closed trades today')}/>
    </section>
    <Panel title="Tradetron Execution Coverage">
      <section className="cards">
        <Card label="LIVE FUTURES SCANNED" value={market?.length || 0} sub="Delta India perpetual tickers" />
        <Card label="ENTRY SAFETY" value={routeSafetyBlocked ? "BLOCKED" : routeSafetyRequired && executionCoverage?.tradetronEntrySafety?.trusted === true ? "VERIFIED" : "NO FUTURES ROUTE"} sub={routeSafetyBlocked ? "New scanner entries stopped: " + routeSafetyReason : routeSafetyRequired ? "Fresh complete TT snapshot is trusted for duplicate checks only" : "No active futures bridge route reported"}/>
        <Card label="FUTURES SYMBOLS ROUTED" value={activeRoutedCount + ' / ' + (market?.length || 0)} sub={(executionCoverage?.configuredFuturesRoutes ?? 0) + ' worker-confirmed bridge(s); ' + (executionCoverage?.routingStatusSource === 'worker-heartbeat' ? 'live worker telemetry' : 'API config fallback')} />
        <Card label="PENDING SIGNAL RESERVATIONS" value={accountDataProtected ? 'LOCKED' : executionCoverage?.reservedSignals ?? '—'} sub={accountDataProtected ? 'private signal state' : 'unconfirmed signals within ' + (executionCoverage?.signalReservationTtlMinutes || 15) + 'm; not open positions'} />
        <Card label="SCAN-ONLY SYMBOLS" value={unroutedCount} sub="No Tradetron entry can be routed for these symbols" />
        <Card label="OPTIONS UNDERLYINGS" value="BTC · ETH · GOLD" sub="Gold contract symbol: XAUT" />
        <Card label="OPTIONS EXECUTION" value="LOCKED" sub={executionCoverage?.optionsRouteConfigured ? 'Route is configured, but Options entry signals remain hard-locked pending verification' : 'Dedicated route not configured; Options remain analysis-only'}/>
      </section>
      {routeSafetyBlocked ? <div className="danger">NEW ENTRIES BLOCKED — Tradetron's read-only position snapshot is stale or incomplete ({routeSafetyReason}). The scanner will not submit new futures/Options signals until position coverage is verified. Existing Tradetron positions are not treated as fills or auto-closed by this snapshot.</div> : null}
      <div className="lockedText"><b>Worker-confirmed futures basket:</b> {(executionCoverage?.routedSymbols || []).join(', ') || 'No worker-confirmed symbols yet'}<br/><small>Routing source: {executionCoverage?.routingStatusSource || 'API config fallback'}{executionCoverage?.routingObservedAt ? ' · heartbeat ' + new Date(executionCoverage.routingObservedAt).toLocaleTimeString('en-IN') : ''}. Unsupported symbols remain scan-only; direct Delta orders stay locked.</small></div>
      {unavailableMarketSymbols.length ? <div className="lockedText"><b>Configured but absent from the current live Delta market:</b> {unavailableMarketSymbols.join(', ')}.<br/><small>These are not worker-confirmed routes and must stay scan-only until the exchange exposes a matching live contract. {polReplacementAvailable ? 'POLUSD is present in the live market feed but is not configured for this Tradetron basket; add matching POLUSD_el / POLUSD_es variables and entry conditions in the linked Tradetron strategy before adding POLUSD to the worker allowlist.' : 'Any replacement symbol must first be configured in the linked Tradetron strategy variables and entry conditions; do not force-route a stale symbol.'}</small></div> : null}
    </Panel>
    <Panel title={'Full Delta Market Scanner · ' + (market?.length || 0) + ' live perpetuals · Signal Only'}>
      <MarketTable market={market} signals={signals} routedSymbols={executionCoverage?.routedSymbols || []} entrySafetyBlocked={routeSafetyBlocked} entrySafetyReason={routeSafetyReason} openPositionSymbols={openPositionSymbols}/>
    </Panel>
    <section className="grid2">
      <RiskGovernor signals={signals} health={health} positions={accountDataProtected || routeSafetyBlocked ? null : riskGovernorPositions} onInspect={onInspect} inspect={inspect} routedSymbols={executionCoverage?.routedSymbols || []} routeDataVerified={executionCoverage?.routingStatusSource === 'worker-heartbeat'} entrySafetyTrusted={executionCoverage?.tradetronEntrySafety?.configured === true ? executionCoverage.tradetronEntrySafety.trusted === true : null}/>
      <Panel title={'Signal Stages · ' + visibleStageCoinCount + ' coins · WATCH → SETUP → CONFIRMED'}>
        <div className="marketCount">Momentum and Scalping status for the same top {visibleStageCoinCount} coins shown in the market table. Missing snapshots are marked NO DATA; the full background scanner remains active.</div>
        <div className="tablewrap"><table><thead><tr><th>COIN</th><th>ENG</th><th>STAGE</th><th>SIDE</th><th>SCORE</th><th>QTY</th><th>NOTIONAL</th><th>RISK</th><th>READY</th><th>WHY BLOCKED</th></tr></thead><tbody>{visibleSignalStages.map(s => <tr key={s.symbol + ':' + s.strategy}><td className="symbol">{s.symbol}</td><td>{s.strategy === 'MOMENTUM' ? 'MOM' : 'SCALP'}</td><td>{s.snapshot_missing ? 'WATCH · NO DATA' : s.stage}</td><td className={s.side === 'BUY' ? 'up' : s.side === 'SELL' ? 'down' : 'muted'}>{s.side || '—'}</td><td><b>{s.snapshot_missing ? '—' : (safeNum(s.score) === null ? 'NO DATA' : safeNum(s.score).toFixed(0) + '/100')}</b></td><td>{s.snapshot_missing ? '—' : fmtQty(s.qty_contracts)}</td><td>{s.snapshot_missing ? '—' : money(s.notional)}</td><td>{s.snapshot_missing ? '—' : money(s.risk_usd)}</td><td className={s.snapshot_missing ? 'muted' : s.ready && !routeSafetyBlocked && !openPositionSymbols.has(String(s.symbol || '').toUpperCase()) ? 'up' : 'down'}>{s.snapshot_missing ? '—' : s.ready && !routeSafetyBlocked && !openPositionSymbols.has(String(s.symbol || '').toUpperCase()) ? 'YES' : 'NO'}</td><td className="blocker" title={Array.isArray(s.gate_results) ? s.gate_results.map(gateTooltip).join('\n') : 'Structured gate results are not supplied by the current worker; existing block reasons shown.'}>{s.snapshot_missing ? 'No signal snapshot available' : routeSafetyBlocked ? 'Tradetron entry safety blocked: ' + routeSafetyReason : openPositionSymbols.has(String(s.symbol || '').toUpperCase()) ? 'Open Tradetron position detected; duplicate entry blocked' : (Array.isArray(s.gate_results) ? blockersDisplay(s.gate_results) : fmtReasons(s.blocked_reasons))}</td></tr>)}</tbody></table></div>
      </Panel>
    </section>
    <Panel title="Signal Mode"><div className="idle">SCANNER → TRADETRON → LIVE OFFLINE <span>No orders are sent by the scanner. Tradetron owns Live Offline execution and position management.</span></div></Panel>
    <TradetronActivity events={tradetronEvents} signalStats={signalOrderStats} webhookSecretConfigured={executionCoverage?.webhookSecretConfigured === true} accountDataProtected={accountDataProtected} />
    <TradetronDeveloperApiPanel configured={developerApiConfigured} sync={developerSync} deployments={developerSnapshots} privateDataProtected={developerDataProtected} notifications={developerNotifications} notificationSync={developerNotificationSync} pnlHistory={developerPnlHistory} />
    <Panel title="Idle Reason"><div className="idle">{idleFromSignals(signals)} <span>Top blocks: {top || 'none recorded'}</span></div></Panel>
    <Panel title="Engine Log · last 200 lines">{accountDataProtected ? <div className="lockedText">Private engine logs are hidden. Enter ENGINE_SECRET in Settings to view them.</div> : <Log rows={logs || []}/>}</Panel>
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

function MarketTable({ market, signals, routedSymbols = [], entrySafetyBlocked = false, entrySafetyReason = null, openPositionSymbols = new Set() }) {
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
    const hasOpenPosition = openPositionSymbols.has(String(m.symbol || '').toUpperCase());
    const routeLabel = entrySafetyBlocked ? 'SAFETY LOCK' : hasOpenPosition ? 'POSITION OPEN' : routeInfo.label;
    const routeTone = entrySafetyBlocked || hasOpenPosition ? 'warn' : routeInfo.tone;
    const routeTitle = entrySafetyBlocked ? 'New signal entries are blocked because the current Tradetron position snapshot is not trusted: ' + (entrySafetyReason || 'unknown reason') : hasOpenPosition ? 'A current engine/event or Tradetron API snapshot already has this symbol open; duplicate entry is blocked.' : routeInfo.title;
    return <tr key={m.symbol}><td>{i+1}</td><td className="symbol">{m.symbol}</td><td>{price(m.mark_price || m.close)}</td><td className={safeNum(m.ltp_change_24h) === null ? 'muted' : safeNum(m.ltp_change_24h) >= 0 ? 'up' : 'down'}>{pct(m.ltp_change_24h)}</td><td>{money(m.turnover_usd)}</td><td>{fmtMultiplier(best?.volume_spike)}</td><td><span className={x.MOMENTUM?.side==='BUY'?'up':x.MOMENTUM?.side==='SELL'?'down':''}>{x.MOMENTUM ? (safeNum(x.MOMENTUM.score) === null ? 'NO DATA' : safeNum(x.MOMENTUM.score).toFixed(0)) + ' ' + (x.MOMENTUM.side || '') : '—'}</span></td><td><span className={x.SCALPING?.side==='BUY'?'up':x.SCALPING?.side==='SELL'?'down':''}>{x.SCALPING ? (safeNum(x.SCALPING.score) === null ? 'NO DATA' : safeNum(x.SCALPING.score).toFixed(0)) + ' ' + (x.SCALPING.side || '') : '—'}</span></td><td>{best?.trend || '—'} / {best?.confirm_trend || '—'}</td><td>{price(best?.support)}</td><td>{price(best?.resistance)}</td><td><b className={best?.stage==='CONFIRMED'?'up':best?.stage==='SETUP'?'warn':'muted'}>{best?.stage || 'WATCH'}</b></td><td><button className={`tiny ${routeTone}`} disabled title={routeTitle}>{routeLabel}</button></td></tr>;
  })}</tbody></table></div></>;
}

function RiskGovernor({ signals, health, positions, onInspect, inspect, scoreMin = 80, routedSymbols = [], routeDataVerified = false, entrySafetyTrusted = null }) {
  const selected = inspect;
  if (!selected) return <Panel title="Risk Governor"><div className="lockedText">No signal selected yet.</div></Panel>;
  const gates = buildRiskGovernorGates({
    selected,
    health,
    positions,
    routedSymbols,
    routeDataVerified,
    entrySafetyTrusted,
    scoreMin
  });
  return <Panel title="Risk Governor · Evidence-Based Status">
    <div className="inspectRow"><label>Inspect coin<select value={selected.symbol} onChange={e => onInspect(e.target.value)}>{[...new Set(signals.map(x=>x.symbol))].slice(0,50).map(x => <option key={x}>{x}</option>)}</select></label><span>{selected.strategy} · {selected.side || 'NO SIDE'} · {safeNum(selected.score) === null ? 'NO SCORE DATA' : safeNum(selected.score).toFixed(0) + '/100'}</span></div>
    <div className="lockedText">PASS means the required observation is available and meets the displayed test. UNKNOWN means this view lacks enough evidence; UNKNOWN must not be treated as a pass.</div>
    <div className="gates">{gates.map(gate => <div key={gate.gate}>
      <b className={gate.result === 'PASS' ? 'pass' : gate.result === 'BLOCK' ? 'block' : 'unknown'}>{gate.result}</b>
      <span>{gate.gate}</span>
      <em title={gateTooltip(gate)}>{gateTooltip(gate).replace(gate.gate + ': ', '')}</em>
    </div>)}</div>
  </Panel>;
}

function EngineView({ engine, signals, entrySafetyBlocked = false, entrySafetyReason = null, openPositionSymbols = new Set() }) {
  const rows = signals.filter(x => x.strategy === engine).sort((a,b) => num(b.score)-num(a.score));
  return <Panel title={engine + ' · Closed-Candle Signal Engine'}>{entrySafetyBlocked ? <div className="danger">NEW ENTRIES BLOCKED — {entrySafetyReason || 'Tradetron position snapshot is not verified'}.</div> : null}<div className="tablewrap"><table><thead><tr><th>COIN</th><th>STAGE</th><th>SIDE</th><th>SCORE</th><th>RSI</th><th>VOL</th><th>EMA21</th><th>ATR</th><th>SL</th><th>TP1</th><th>TP</th><th>QTY</th><th>RISK</th><th>BLOCKED / GATES</th></tr></thead><tbody>{rows.map(x => {
    const hasGateResults = Array.isArray(x.gate_results);
    const positionOpen = openPositionSymbols.has(String(x.symbol || '').toUpperCase());
    const safetyReason = entrySafetyBlocked ? 'Tradetron entry safety blocked: ' + (entrySafetyReason || 'snapshot not verified') : positionOpen ? 'Open position detected; duplicate entry blocked' : '';
    const rowReasons = [hasGateResults ? blockersDisplay(x.gate_results) : fmtReasons(x.blocked_reasons), safetyReason].filter(value => value && value !== '—').join(' · ') || '—';
    return <tr key={x.symbol}>
      <td className="symbol">{x.symbol}</td>
      <td>{x.stage || '—'}</td>
      <td className={x.side==='BUY'?'up':x.side==='SELL'?'down':''}>{x.side || '—'}</td>
      <td><b>{safeNum(x.score) === null ? '—' : safeNum(x.score).toFixed(0)}</b></td>
      <td>{fmtRsi(x.rsi)}</td>
      <td>{fmtMultiplier(x.volume_spike)}</td>
      <td>{fmtRawPrice(x.ema21)}</td>
      <td>{fmtRawPrice(x.atr_5m)}</td>
      <td>{fmtRawPrice(x.stop_price)}</td>
      <td>{fmtRawPrice(x.tp1_price)}</td>
      <td>{fmtRawPrice(x.tp_price)}</td>
      <td>{fmtQty(x.qty_contracts)}</td>
      <td>{safeNum(x.risk_usd) === null ? '—' : money(x.risk_usd)}</td>
      <td className={safetyReason ? 'blocker' : 'muted'} title={(hasGateResults ? x.gate_results.map(gateTooltip).join('\n') : 'Structured gate results are not supplied by the current worker; showing existing block reasons.') + (safetyReason ? '\n' + safetyReason : '')}>{rowReasons}</td>
    </tr>;
  })}</tbody></table></div></Panel>;
}

function OptionsView({ signals, settings, optionCache = [], executionCoverage = null }) {
  const rows = (optionCache.length ? optionCache : signals.filter(x => x.strategy === 'OPTIONS_BUY' || x.strategy === 'OPTIONS_SELL'))
    .sort((a,b) => num(b.score) - num(a.score));
  const buys = rows.filter(x => x.strategy === 'OPTIONS_BUY');
  const sells = rows.filter(x => x.strategy === 'OPTIONS_SELL');
  const buyMinDelta = safeNum(settings.options_buy_min_delta) || 0.45;
  const buyMaxDelta = safeNum(settings.options_buy_max_delta) || 0.65;
  const sellMinDelta = safeNum(settings.options_sell_min_delta) || 0.20;
  const sellMaxDelta = safeNum(settings.options_sell_max_delta) || 0.35;
  return <>
    <section className="cards">
      <Card label="OPTIONS ENGINE" value={settings.options_enabled === false ? 'OFF' : 'ON'} sub="BTC / ETH / GOLD (XAUT) only · analysis data"/>
      <Card label="BUY CANDIDATES" value={buys.length} sub={'Delta target ' + buyMinDelta.toFixed(2) + '–' + buyMaxDelta.toFixed(2)}/>
      <Card label="SELL CANDIDATES" value={sells.length} sub={'Delta target ' + sellMinDelta.toFixed(2) + '–' + sellMaxDelta.toFixed(2) + ' · spread only'}/>
      <Card label="OPTIONS ROUTE CONFIG" value={executionCoverage?.optionsRouteConfigured === true ? 'CONFIGURED' : 'NOT CONFIGURED'} sub="Route configuration does not unlock Options execution"/>
    </section>
    <div className="lockedText">
      <b className="warn">⚠ OPTIONS EXECUTION LOCKED — ANALYSIS ONLY</b>
      <p>Entries remain hard-locked until spread legs, defined maximum loss, dedicated credentials, and contract mappings are independently verified. A configured route is not execution authorization.</p>
      <p className="muted">No Options entry signal should be sent from this scanner while the safety lock is active.</p>
    </div>
    <Panel title="Options BUY · Analysis Only">
      <OptionTable rows={buys} type="BUY" deltaMin={buyMinDelta} deltaMax={buyMaxDelta} />
    </Panel>
    <Panel title="Options SELL · Defined-Risk Review Only">
      <OptionTable rows={sells} type="SELL" deltaMin={sellMinDelta} deltaMax={sellMaxDelta} />
    </Panel>
  </>;
}

function OptionTable({ rows, type, deltaMin, deltaMax }) {
  const hasSellRiskColumns = type === 'SELL';
  // Never render a stale cached candidate as executable while the backend hard lock is active.
  const optionsExecutionLocked = true;
  const columnCount = hasSellRiskColumns ? 18 : 16;
  return <div className="tablewrap"><table><thead><tr>
    <th>TIME</th><th>UNDERLYING</th><th>CONTRACT</th><th>TYPE</th><th>STRIKE</th><th>DTE</th><th>Δ</th><th>DELTA RANGE CHECK</th><th>BID</th><th>ASK</th><th>SPREAD</th><th>OI</th><th>VOL</th><th>SCORE</th><th>STAGE</th>{hasSellRiskColumns ? <><th>PROTECTIVE LEG</th><th>MAX LOSS / SPREAD (RAW)</th></> : null}<th>STATUS</th>
  </tr></thead><tbody>{rows.slice(0,30).map(s => {
    let d = s.details || {};
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
    const deltaValue = safeNum(d.delta);
    const deltaMissing = d.delta === null || d.delta === undefined || (typeof d.delta === 'string' && d.delta.trim() === '');
    const deltaAssessment = assessDeltaRange(d.delta, deltaMin, deltaMax);
    const hedgeStrike = safeNum(d.hedgeStrike);
    const hedgeDelta = safeNum(d.hedgeDelta);
    const protectiveLegConfirmed = Boolean(
      typeof d.hedgeSymbol === 'string' && d.hedgeSymbol.trim() &&
      hedgeStrike !== null && hedgeDelta !== null && hedgeDelta !== 0
    );
    const rawMaxLoss = safeNum(d.maxRiskPerSpread);
    const maxLossAvailable = protectiveLegConfirmed && rawMaxLoss !== null && rawMaxLoss > 0;
    const reasonText = fmtReasons(s.blocked_reasons);
    const statusLocked = String(reasonText).toLowerCase().includes('execution') ||
      String(reasonText).toLowerCase().includes('route unavailable') ||
      String(reasonText).toLowerCase().includes('defined-risk hedge unavailable');
    return <tr key={s.id || s.symbol + s.strategy + s.captured_at}>
      <td>{s.cached_at ? new Date(s.cached_at).toLocaleTimeString('en-IN') : (s.captured_at ? new Date(s.captured_at).toLocaleTimeString('en-IN') : '—')}</td>
      <td className="symbol">{formatUnderlying(d.underlyingSymbol || s.underlying)}</td>
      <td className="symbol">{s.symbol || '—'}</td>
      <td>{d.optionType || '—'} / {type}</td>
      <td>{safeNum(d.strike) === null ? '—' : safeNum(d.strike).toLocaleString('en-IN',{maximumFractionDigits:2})}</td>
      <td>{safeNum(d.dte) === null ? '—' : safeNum(d.dte).toFixed(1)}</td>
      <td>{deltaMissing ? 'NO DATA' : deltaValue === null ? 'INVALID' : deltaValue.toFixed(2)}</td>
      <td className={deltaAssessment.status === 'IN_RANGE' ? 'up' : 'warn'} title={deltaAssessment.label}>{deltaAssessment.label}</td>
      <td>{fmtRawPrice(d.bid)}</td>
      <td>{fmtRawPrice(d.ask)}</td>
      <td>{safeNum(s.spread_pct) === null ? '—' : safeNum(s.spread_pct).toFixed(2) + '%'}</td>
      <td>{safeNum(d.openInterest) === null ? '—' : safeNum(d.openInterest).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
      <td>{safeNum(d.volume) === null ? '—' : safeNum(d.volume).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
      <td><b>{safeNum(s.score) === null ? '—' : safeNum(s.score).toFixed(0)}</b>/100</td>
      <td>{s.stage || '—'}</td>
      {hasSellRiskColumns ? <>
        <td className="warn">{protectiveLegConfirmed ? 'SPREAD LEG: ' + d.hedgeSymbol + ' · STRIKE ' + hedgeStrike : 'PROTECTIVE LEG: NOT CONFIRMED'}</td>
        <td>{maxLossAvailable ? fmtRawPrice(rawMaxLoss, 2) : 'MAX LOSS: NOT AVAILABLE — SPREAD NOT CONFIRMED'}</td>
      </> : null}
      <td className={optionsExecutionLocked || statusLocked ? 'warn' : s.ready ? 'up' : 'muted'}>{optionsExecutionLocked || statusLocked ? 'LOCKED' : s.ready ? 'READY' : 'WAIT'}</td>
    </tr>;
  })}{!rows.length ? <tr><td colSpan={columnCount}>No option candidates returned for the current market snapshot. No missing values are substituted with zero.</td></tr> : null}</tbody></table></div>;
}

function Positions({ rows = [], tradetronDeployments = [], marketCache = [], snapshotsLocked = false, accountDataProtected = false }) {
  if (accountDataProtected) return <Panel title="Positions · Protected"><div className="lockedText">Private engine positions and Tradetron snapshots are hidden. Enter ENGINE_SECRET in Settings. An empty protected response must not be interpreted as zero open positions.</div></Panel>;
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
    snapshot_pnl_source: position.pnlSource,
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
      snapshot_pnl_source: snapshot?.snapshot_pnl_source ?? null,
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
      <thead><tr><th>TIME / SNAPSHOT</th><th>COIN</th><th>STRATEGY / SOURCE</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>MARK</th><th>API VALUE RAW (UNIT UNVERIFIED)</th><th>API P&amp;L FIELD (RAW; source shown)</th><th>SL</th><th>TP1</th><th>TP</th><th>PROTECTION</th><th>ORIGIN</th></tr></thead>
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
          <td>{p.snapshot_value == null ? '—' : fmtRawPrice(p.snapshot_value, 2)}</td>
          <td title={stockTokenPnlTooltip(p.symbol, p.snapshot_pnl, contractValueForSymbol(marketCache, p.symbol)) || (p.snapshot_pnl_source ? "Raw Developer API field: " + p.snapshot_pnl_source + ". Generic pnl is not verified M2M." : "No P&L source field was identified.")}><div>{p.snapshot_pnl == null ? '—' : fmtRawPrice(p.snapshot_pnl, 2)}</div><small className="muted">{p.snapshot_pnl_source ? "API field: " + p.snapshot_pnl_source + (["m2m","mtm","unrealized_pnl","unrealizedPnl","open_pnl","openPnl","mark_to_market","markToMarket"].includes(p.snapshot_pnl_source) ? " · M2M-named" : " · semantics unverified") : "source unavailable"}</small></td>
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
function HistoryEmptyState({ engine }) {
  return <div className="lockedText">
    <b>NO VERIFIED CLOSED TRADE RECORDS — {String(engine || 'TRADE').toUpperCase()}</b>
    <p>Data source: authenticated closed-trade/fill records processed into the scanner ledger.</p>
    <p>Status: Awaiting verified entry and exit records.</p>
    <p className="warn">Tradetron Developer API snapshots and notification history do not by themselves prove individual fills or exits. The account's outbound close-callback path is not assumed to be available.</p>
    <p className="muted">This table is intentionally empty. No estimated, synthetic, or fabricated trade records are shown.</p>
  </div>;
}

function TradeHistory({ trades = [], title, strategy = undefined, apiDerivedTrades = [], accountDataProtected = false, tradesComplete = false }) {
  if (accountDataProtected) return <Panel title={title}><div className="lockedText">Closed-trade records are private and currently locked. Enter ENGINE_SECRET in Settings to view history. No trades are being inferred from snapshots.</div></Panel>;
  const engine = String(title || 'Trade History').split('·')[0].replace(/history/i, '').trim() || 'Trade';
  const derivedRows = (Array.isArray(apiDerivedTrades) ? apiDerivedTrades : [])
    .filter(row => !strategy || String(row?.strategy || '').toUpperCase() === String(strategy).toUpperCase());
  return <Panel title={title}>
    {!tradesComplete ? <div className="lockedText">Showing loaded trade rows only; the full trade-history ledger is not confirmed. Aggregate totals may therefore be incomplete.</div> : null}
    <div className="tablewrap"><table><thead><tr><th>TIME</th><th>COIN</th><th>MODE</th><th>STRATEGY</th><th>SIDE</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>FEES</th><th>GROSS</th><th>NET</th><th>PNL%</th><th>R</th><th>EXIT REASON</th><th>RESULT</th></tr></thead><tbody>
      {trades.map(t => <tr key={t.execution_id}>
        <td>{t.closed_at ? new Date(t.closed_at).toLocaleString('en-IN') : '—'}</td>
        <td className="symbol">{t.symbol || '—'}</td>
        <td>TRADETRON OFFLINE</td>
        <td>{t.strategy || '—'}</td>
        <td className={t.side==='BUY'?'up':t.side==='SELL'?'down':'muted'}>{t.side || '—'}</td>
        <td>{t.entry_price == null ? '—' : price(t.entry_price)}</td>
        <td>{t.exit_price == null ? '—' : price(t.exit_price)}</td>
        <td>{t.qty == null ? '—' : fmtQty(t.qty)}</td>
        <td>{t.fees == null ? '—' : money(t.fees)}</td>
        <td>{t.gross_pnl == null ? '—' : money(t.gross_pnl)}</td>
        <td className={safeNum(t.net_pnl) === null ? 'muted' : safeNum(t.net_pnl) >= 0 ? 'up' : 'down'}>{t.net_pnl == null ? '—' : money(t.net_pnl)}</td>
        <td>{t.pnl_pct == null ? '—' : pct(t.pnl_pct)}</td>
        <td>{safeNum(t.r_multiple) === null ? '—' : safeNum(t.r_multiple).toFixed(2)}</td>
        <td>{t.exit_reason || '—'}</td>
        <td>{t.result || '—'}</td>
      </tr>)}
      {!trades.length ? <tr><td colSpan={15}><HistoryEmptyState engine={engine}/></td></tr> : null}
    </tbody></table></div>
    <div className="panelTitle"><h3>API-Derived History · Unverified</h3></div>
    <div className="lockedText apiStateWarn">
      <b>⚠️ Derived from API snapshots. Not verified fills.</b>
      <div>Strategy labels are best-effort matches to signal-cache rows when the API snapshot has no strategy field. These observations are display-only; they are not authenticated fills or verified closes.</div>
    </div>
    {derivedRows.length ? <div className="tablewrap"><table>
      <thead><tr><th>TIME</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>EXIT</th><th>RAW P&amp;L</th><th>SOURCE</th><th>VERIFIED</th></tr></thead>
      <tbody>{derivedRows.map(row => {
        const displayTime = row.closed_at_estimated || row.closed_at || row.detected_at;
        return <tr key={row.id || row.source_fingerprint || String(row.detected_at) + ':' + String(row.symbol)}>
          <td title={row.detected_at ? 'Detected at ' + new Date(row.detected_at).toLocaleString('en-IN') : 'Detection time unavailable'}>{displayTime ? new Date(displayTime).toLocaleString('en-IN') : 'Unknown'}</td>
          <td className="symbol">{row.symbol || 'Unknown'}</td>
          <td>{row.side || 'Unknown'}</td>
          <td>{safeNum(row.qty_closed) === null ? 'Unknown' : fmtQty(row.qty_closed)}</td>
          <td>{safeNum(row.entry_price) === null ? 'Unknown' : price(row.entry_price)}</td>
          <td>{safeNum(row.exit_price) === null ? 'Unknown' : price(row.exit_price)}</td>
          <td className={safeNum(row.raw_pnl) === null ? 'muted' : 'mono'}>{safeNum(row.raw_pnl) === null ? 'Unknown' : fmtRawPrice(row.raw_pnl,4) + ' RAW'}</td>
          <td>{row.derived_from || 'Unknown'}</td>
          <td className="warn" title="This record is inferred from API snapshots, not authenticated fill events.">UNVERIFIED</td>
        </tr>;
      })}</tbody>
    </table></div> : <div className="lockedText">No closes detected yet. Monitoring active.</div>}
  </Panel>;
}
function PNL({
  trades = [], settings = {}, accountDataProtected = false, tradesComplete = false,
  tradeRowCount = null, apiDerivedTrades = [], apiDerivedTradeCount = null,
  developerSnapshots = [], developerDataProtected = false, developerApiConfigured = false, marketCache = []
}) {
  if (accountDataProtected) return <Panel title="PNL · Protected"><div className="lockedText">Private realized P&amp;L, fees and scanner equity are hidden. Enter ENGINE_SECRET in Settings to inspect them. Tradetron snapshots remain a separate read-only source.</div></Panel>;
  const hasClosedTrades = trades.length > 0;
  const netValues = trades.map(trade => safeNum(trade.net_pnl));
  const feeValues = trades.map(trade => safeNum(trade.fees));
  const netComplete = hasClosedTrades && tradesComplete && netValues.every(value => value !== null);
  const feesComplete = hasClosedTrades && tradesComplete && feeValues.every(value => value !== null);
  const net = netComplete ? netValues.reduce((sum, value) => sum + value, 0) : null;
  const fees = feesComplete ? feeValues.reduce((sum, value) => sum + value, 0) : null;
  const derivedRows = Array.isArray(apiDerivedTrades) ? apiDerivedTrades : [];
  const exactDerivedCount = apiDerivedTradeCount == null ? null : Number(apiDerivedTradeCount);
  const derivedRowsComplete = exactDerivedCount !== null && exactDerivedCount === derivedRows.length;
  const knownDerivedPnl = derivedRows.map(row => safeNum(row?.raw_pnl)).filter(value => value !== null);
  const derivedRawSum = knownDerivedPnl.length
    ? knownDerivedPnl.reduce((sum, value) => sum + value, 0) : null;
  const derivedCountLabel = exactDerivedCount === null ? derivedRows.length + ' loaded row(s); total count unavailable'
    : exactDerivedCount + ' trades detected (API-derived, unverified fills)' +
      (!derivedRowsComplete ? ' · showing latest ' + derivedRows.length : '');
  const rawExposure = summarizeTradetronSnapshots(developerSnapshots);
  const openRows = rawExposure.openRows || [];
  const openPnlValues = openRows.map(row => safeNum(row?.pnl));
  const knownOpenPnl = openPnlValues.filter(value => value !== null);
  const openRawPnlSum = knownOpenPnl.length ? knownOpenPnl.reduce((sum,value) => sum + value,0) : null;
  const openPnlComplete = openRows.length > 0 && openPnlValues.every(value => value !== null);
  return <>
    <section className="cards">
      <Card label="REALIZED NET" value={!hasClosedTrades ? 'UNAVAILABLE' : netComplete ? money(net) : 'INCOMPLETE DATA'} sub={!hasClosedTrades ? 'waiting for authenticated closed-trade records' : !tradesComplete ? 'loaded ' + trades.length + ' of ' + (tradeRowCount ?? 'an unknown number of') + ' stored rows; not a complete total' : netComplete ? 'all stored closed-trade P&L values present' : 'one or more closed-trade P&L values are missing'}/>
      <div className="card" title="Why? A position snapshot or generic P&amp;L field does not contain authenticated per-fill commission/fee records. No zero fee is assumed."><small>FEES · <span title="Why? Fees need authenticated per-fill commission records.">Why?</span></small><strong>{feesComplete ? money(fees) : 'UNAVAILABLE'}</strong><span>{feesComplete ? 'sum of recorded authenticated trade fees' : 'Fees cannot be computed without authenticated fills.'}</span></div>
      <Card label="EQUITY" value={settings.equity == null ? '—' : money(settings.equity)} sub="configured scanner ledger balance"/>
      <Card label="UNREALIZED" value={settings.unrealized_pnl == null ? '—' : money(settings.unrealized_pnl)} sub="webhook/engine ledger only; Tradetron raw exposure is shown separately"/>
    </section>
    {!hasClosedTrades ? <div className="lockedText">Realized P&amp;L and fees are not confirmed as zero; the scanner has no authenticated closed-trade rows yet. Tradetron deployment snapshots are displayed separately and are not merged into this ledger.</div> : null}

    <Panel title="API-Derived Realized P&L · UNVERIFIED">
      {developerDataProtected ? <div className="lockedText">Private API-derived data is locked. Enter ENGINE_SECRET in Settings to view it.</div> : <>
        <section className="cards">
          <Card label="RAW P&L SUM" value={derivedRawSum === null ? (derivedRows.length ? 'UNKNOWN' : 'NO RECORDS') : fmtRawPrice(derivedRawSum,2) + ' RAW'} sub={derivedRows.length ? ('Sum of ' + knownDerivedPnl.length + ' known row-level raw_pnl value(s); currency and realized-P&L meaning are unverified.' + (!derivedRowsComplete ? ' Loaded-row sum only.' : '')) : 'No API-derived rows stored yet.'} title="Raw API/CSV fields only. This figure is not authenticated realized net P&L and is never used by risk logic."/>
          <Card label="API-DERIVED RECORDS" value={exactDerivedCount ?? derivedRows.length} sub={derivedCountLabel}/>
          <Card label="DATA QUALITY" value={derivedRows.length ? (derivedRows.filter(row=>row.data_quality==='FULL').length + ' FULL · ' + derivedRows.filter(row=>row.data_quality==='PARTIAL').length + ' PARTIAL · ' + derivedRows.filter(row=>row.data_quality==='MINIMAL').length + ' MINIMAL') : 'UNKNOWN'} sub="FULL means entry + exit fields present only; every row remains unverified"/>
        </section>
        <div className="lockedText">These are raw API-derived observations, not authenticated historical fills. Rows labelled snapshot_closed may reflect a currently visible closed snapshot rather than a newly detected close. Missing quantities, side, entry/exit prices and timestamps remain Unknown.</div>
        {!derivedRows.length ? <div className="lockedText">{developerApiConfigured ? 'Monitoring active. Historical closes not tracked (would require fills). New closes will appear here.' : 'Tradetron Developer API is not configured; API-derived monitoring is inactive.'}</div> : null}
        {derivedRows.length ? <div className="tablewrap"><table>
          <thead><tr><th>DETECTED</th><th>SYMBOL</th><th>SIDE</th><th>QTY CLOSED</th><th>ENTRY</th><th>EXIT</th><th>LAST LTP RAW</th><th>RAW P&L</th><th>QUALITY / SOURCE</th><th>CLOSE TIME</th></tr></thead>
          <tbody>{derivedRows.map(row=><tr key={row.id}>
            <td>{row.detected_at ? new Date(row.detected_at).toLocaleString('en-IN') : 'Unknown'}</td>
            <td className="symbol">{row.symbol || 'Unknown'}</td>
            <td>{row.side || 'Unknown'}</td>
            <td>{safeNum(row.qty_closed) === null ? 'Unknown' : fmtQty(row.qty_closed)}</td>
            <td>{safeNum(row.entry_price) === null ? 'Unknown' : price(row.entry_price)}</td>
            <td>{safeNum(row.exit_price) === null ? 'Unknown' : price(row.exit_price)}</td>
            <td>{safeNum(row.last_known_ltp) === null ? 'Unknown' : fmtRawPrice(row.last_known_ltp,4) + ' RAW'}</td>
            <td className={safeNum(row.raw_pnl) === null ? 'muted' : 'mono'} title={stockTokenPnlTooltip(row.symbol, row.raw_pnl, contractValueForSymbol(marketCache, row.symbol)) || 'API-derived raw P&L field; not an authenticated realized P&L value.'}>{safeNum(row.raw_pnl) === null ? 'Unknown' : fmtRawPrice(row.raw_pnl,4) + ' RAW'}</td>
            <td>{row.data_quality || 'Unknown'}<div className="muted">{row.derived_from || 'Unknown'} · Unverified</div></td>
            <td>{row.closed_at_estimated || row.closed_at ? new Date(row.closed_at_estimated || row.closed_at).toLocaleString('en-IN') : 'Unknown'}</td>
          </tr>)}</tbody>
        </table></div> : null}
      </>}
    </Panel>

    <Panel title="Current Open Exposure · Raw Tradetron API Fields">
      {developerDataProtected ? <div className="lockedText">Private Tradetron snapshot data is locked. Enter ENGINE_SECRET in Settings to view raw exposure.</div> : <>
        <section className="cards">
          <Card label="OPEN RAW P&L SUM" value={!openRows.length ? 'NO IDENTIFIED ROWS' : openRawPnlSum === null ? 'UNKNOWN' : fmtRawPrice(openRawPnlSum,2) + ' RAW'} sub={'Raw sum of API row-level pnl fields (semantics unverified). ' + knownOpenPnl.length + '/' + openRows.length + ' open row(s) have numeric raw P&L.'} title={stockTokenOpenPnlTooltip(openRows, marketCache, openRawPnlSum)} />
          <Card label="IDENTIFIED OPEN ROWS" value={openRows.length || (developerApiConfigured ? 'NONE IDENTIFIED' : '—')} sub="Only rows from the current readable snapshot; not authenticated exposure or unrealized P&L"/>
        </section>
        {openRows.length ? <div className="tablewrap"><table>
          <thead><tr><th>SYMBOL</th><th>SIDE</th><th>QTY RAW</th><th>LTP RAW</th><th>ROW P&L RAW</th><th>CHECK</th></tr></thead>
          <tbody>{openRows.map(row=>{
            const anomaly = hasRawPnlAnomaly(row);
            return <tr key={row.key}>
              <td className="symbol">{row.symbol || 'Unknown'}</td>
              <td>{row.side || 'Unknown'}</td>
              <td>{safeNum(row.quantity) === null ? 'Unknown' : fmtQty(row.quantity)}</td>
              <td>{safeNum(row.markPrice) === null ? 'Unknown' : fmtRawPrice(row.markPrice,4)}</td>
              <td title={stockTokenPnlTooltip(row.symbol, row.pnl, contractValueForSymbol(marketCache, row.symbol)) || 'Raw API field; semantics are unverified.'}>{safeNum(row.pnl) === null ? 'Unknown' : fmtRawPrice(row.pnl,4) + ' RAW'}</td>
              <td>{anomaly ? <b className="apiStateWarn">⚠ PnL anomaly</b> : <span className="muted">No threshold flag</span>}</td>
            </tr>;
          })}</tbody>
        </table></div> : <div className="lockedText">{developerApiConfigured ? 'No current open row could be identified in the latest readable snapshot. This does not prove a verified flat account if positions are hidden or the snapshot is stale.' : 'Tradetron Developer API is not configured.'}</div>}
      </>}
    </Panel>
  </>;
}

function Rotation({ ledger = [], accountDataProtected = false, ledgerComplete = false, ledgerRowCount = null }) {
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  if (accountDataProtected) return <Panel title="Profit Rotation V3 Ledger · Protected"><div className="lockedText">Rotation ledger rows and amounts are private. Enter ENGINE_SECRET in Settings to view them.</div></Panel>;
  const nowDay = indiaDateKey(new Date());
  const todayLedger = ledger.filter(row => indiaDateKey(row.created_at) === nowDay);
  // TODO: When verified fills are available, correlate dd_trades to
  // dd_rotation_ledger with a proper trade_id foreign key.
  const summary = summarizeRotationLedger(todayLedger, ledgerComplete);
  const { hasEvents, releasedComplete, retainedComplete, released, retained } = summary;
  const emptyTodayMessage = ledgerRowCount != null && Number(ledgerRowCount) === 0
    ? 'No rotation events recorded yet. Feature activates when a verified trade closes in profit.'
    : 'No rotation events recorded today.';
  const showDeliveryNotice = ledgerRowCount != null && Number(ledgerRowCount) === 0 && !noticeDismissed;
  const releasedValue = !ledgerComplete
    ? 'INCOMPLETE DATA'
    : !hasEvents
      ? '0.00'
      : releasedComplete
        ? money(released)
        : 'INCOMPLETE DATA';
  const retainedValue = !ledgerComplete
    ? 'INCOMPLETE DATA'
    : !hasEvents
      ? '0.00'
      : retainedComplete
        ? money(retained)
        : 'INCOMPLETE DATA';
  return <>
    {showDeliveryNotice ? <div className="rotationNotice" role="status">
      <div><strong>⚠️ Profit Rotation requires verified closed trades.</strong> Current setup receives no authenticated fills from Tradetron. This ledger will remain empty until:
        <br/>(a) Tradetron outbound webhooks are configured, OR
        <br/>(b) A relay supplies verified close events.
        <br/>Read-only API snapshots cannot generate rotation events.
      </div>
      <button type="button" className="rotationNoticeDismiss" onClick={() => setNoticeDismissed(true)} aria-label="Dismiss Profit Rotation status notice">Dismiss</button>
    </div> : null}
    <section className="cards">
      <Card label="EVENTS TODAY" value={ledgerComplete ? todayLedger.length : 'INCOMPLETE DATA'} sub={!ledgerComplete ? 'full rotation-ledger row count is not confirmed' : !hasEvents ? emptyTodayMessage : 'recorded profit-rotation ledger rows'}/>
      <Card label="RELEASED 90%" value={releasedValue} sub={!ledgerComplete ? 'full rotation ledger not loaded' : !hasEvents ? emptyTodayMessage : releasedComplete ? 'sum of recorded release values' : 'missing release amount in one or more rows'}/>
      <Card label="ALLOCATED" value={releasedValue} sub={!ledgerComplete ? 'full rotation ledger not loaded' : !hasEvents ? 'No data yet' : releasedComplete ? 'matches the recorded released amount' : 'missing release amount in one or more rows'}/>
      <Card label="RETAINED 10%" value={retainedValue} sub={!ledgerComplete ? 'full rotation ledger not loaded' : !hasEvents ? emptyTodayMessage : retainedComplete ? 'sum of recorded retained values' : 'missing retained amount in one or more rows'}/>
    </section>
    <Panel title="Profit Rotation V3 Ledger">{!ledgerComplete ? <div className="lockedText">Showing {ledger.length} of {ledgerRowCount ?? 'an unknown number of'} stored ledger rows. This table may be partial.</div> : null}<div className="tablewrap"><table><thead><tr><th>TIME</th><th>EXECUTION ID</th><th>PROFIT</th><th>RELEASED</th><th>RETAINED</th><th>ROTATION ID</th></tr></thead><tbody>{ledger.length ? ledger.map(row=><tr key={row.execution_id}>
      <td>{row.created_at ? new Date(row.created_at).toLocaleString('en-IN') : '—'}</td>
      <td className="mono">{row.execution_id || '—'}</td>
      <td className="up">{money(row.profit)}</td><td>{money(row.released)}</td><td>{money(row.retained)}</td><td>{row.rotation_id || '—'}</td>
    </tr>) : <tr><td colSpan={6} className="rotationEmpty">{ledgerComplete ? 'No rotation ledger rows recorded yet.' : 'No rows are currently loaded; the ledger may be partial.'}</td></tr>}</tbody></table></div></Panel>
  </>;
}
function Analytics({ trades = [], accountDataProtected = false, tradesComplete = false, tradeRowCount = null }) {
  if (accountDataProtected) return <Panel title="Analytics · Protected"><div className="lockedText">Closed-trade analytics, equity curve and P&amp;L statistics are private. Enter ENGINE_SECRET in Settings to view them.</div></Panel>;
  const engines = ['MOMENTUM','SCALPING'].map(engine => {
    const rows = trades.filter(trade => trade.strategy === engine);
    const pnlRows = rows.filter(trade => safeNum(trade.net_pnl) !== null);
    const wins = pnlRows.filter(trade => safeNum(trade.net_pnl) > 0);
    const losses = pnlRows.filter(trade => safeNum(trade.net_pnl) < 0);
    const avgWin = wins.length ? wins.reduce((sum, trade) => sum + safeNum(trade.net_pnl), 0) / wins.length : null;
    const avgLoss = losses.length ? losses.reduce((sum, trade) => sum + safeNum(trade.net_pnl), 0) / losses.length : null;
    const rValues = rows.map(trade => safeNum(trade.r_multiple));
    const avgR = rows.length && rValues.every(value => value !== null)
      ? rValues.reduce((sum, value) => sum + value, 0) / rows.length
      : null;
    const net = tradesComplete && rows.length && pnlRows.length === rows.length
      ? pnlRows.reduce((sum, trade) => sum + safeNum(trade.net_pnl), 0)
      : null;
    return {
      engine,
      rows,
      wins,
      losses,
      pnlCount: pnlRows.length,
      winRate: pnlRows.length ? wins.length / pnlRows.length * 100 : null,
      avgWin,
      avgLoss,
      avgR,
      net
    };
  });
  const allPnlKnown = tradesComplete && trades.length > 0 && trades.every(trade => safeNum(trade.net_pnl) !== null);
  const sortedKnown = allPnlKnown
    ? [...trades].sort((a,b) => safeNum(b.net_pnl) - safeNum(a.net_pnl))
    : [];
  const excludedTopWinnersNet = allPnlKnown
    ? trades.reduce((sum, trade) => sum + safeNum(trade.net_pnl), 0) -
      sortedKnown.slice(0,5).reduce((sum, trade) => sum + safeNum(trade.net_pnl), 0)
    : null;
  const byReason = {};
  for (const trade of trades) {
    const reason = trade.exit_reason || 'UNKNOWN';
    byReason[reason] = (byReason[reason] || 0) + 1;
  }
  return <>
    <section className="panel">
      <div className="panelTitle"><h2>Per-engine statistics</h2></div>
      <div className="engineStats">{engines.map(engine => <div key={engine.engine}>
        <h3>{engine.engine}</h3>
        <b>{engine.winRate === null ? 'NO P&L DATA' : (!tradesComplete ? 'SAMPLE · ' : '') + engine.winRate.toFixed(1) + '% win rate'}</b>
        <span>{engine.rows.length} loaded rows · {engine.pnlCount} with P&amp;L · avg win {engine.avgWin === null ? '—' : money(engine.avgWin)} · avg loss {engine.avgLoss === null ? '—' : money(engine.avgLoss)} · avg R {engine.avgR === null ? '—' : engine.avgR.toFixed(2)} · net {engine.net === null ? 'INCOMPLETE DATA' : money(engine.net)}</span>
      </div>)}</div>
    </section>
    <section className="cards">
      <Card label="NET EXCLUDING TOP 5 WINNERS" value={excludedTopWinnersNet === null ? (trades.length ? 'INCOMPLETE DATA' : '—') : money(excludedTopWinnersNet)} sub="available only when every recorded trade has net P&L"/>
      <Card label="EXIT REASONS" value={Object.keys(byReason).length} sub="recorded exit reason labels"/>
      <Card label="TOTAL TRADES" value={tradesComplete ? trades.length : trades.length ? 'PARTIAL' : '—'} sub={tradesComplete ? 'all stored closed-trade rows' : `loaded ${trades.length} of ${tradeRowCount ?? 'an unknown number of'} stored rows`}/>
    </section>
    <Panel title="Exits by reason"><div className="chips">{Object.entries(byReason).map(([reason,count])=><span key={reason}>{reason}: {count}</span>)}</div></Panel>
    <Panel title="Equity Curve"><div className="curve">{allPnlKnown
      ? equityPoints(trades).map((point,index)=><span key={index} style={{height:Math.max(4,Math.min(150,70+point.delta))}} title={point.label}></span>)
      : <div className="muted">{trades.length ? 'Equity curve hidden because one or more trade P&L values are missing.' : 'No verified closed-trade P&L records yet.'}</div>}</div></Panel>
  </>;
}
function equityPoints(trades) {
  let total=0;
  return trades.slice().reverse().flatMap(trade => {
    const pnl = safeNum(trade.net_pnl);
    if (pnl === null) return [];
    total += pnl;
    return [{delta:total,label:money(total)}];
  });
}
function TradetronPositionReconciliationPanel({ deployments = [], enginePositions = [], syncState = null, privateDataProtected = false }) {
  if (privateDataProtected) {
    return <Panel title="Tradetron Position Reconciliation"><div className="lockedText">Private position data is locked. Unlock the dashboard session to compare the read-only Tradetron snapshot with the authenticated engine ledger.</div></Panel>;
  }

  let report = null;
  let comparisonError = '';
  try {
    report = buildTradetronPositionReconciliation({
      deployments,
      enginePositions,
      syncState
    });
  } catch (error) {
    comparisonError = String(error?.message || error || 'Unknown reconciliation error').slice(0, 500);
  }

  const syncAgeMs = Date.parse(syncState?.last_success_at || '');
  const syncAgeLabel = Number.isFinite(syncAgeMs)
    ? Math.max(0, (Date.now() - syncAgeMs) / 1000).toFixed(0) + 's ago'
    : 'time unavailable';

  return <Panel title="Tradetron Position Reconciliation">
    <div className="lockedText">
      <b>Snapshot sync:</b> {syncState?.status || 'NO DATA'} · last success {syncState?.last_success_at ? new Date(syncState.last_success_at).toLocaleString('en-IN') : 'not available'} ({syncAgeLabel})<br/>
      <b>Engine ledger:</b> {Array.isArray(enginePositions) ? enginePositions.filter(row => Math.abs(Number(row?.qty ?? row?.quantity) || 0) > 0).length : 'no data'} open row(s)
      {report?.snapshotReason ? <><br/><b>Snapshot validation:</b> {report.snapshotReason}</> : null}
      {report && !report.snapshotAvailable ? <p>No data: a visible Tradetron position snapshot is not available.</p> : null}
      {report?.snapshotAvailable && report.snapshotTrusted !== true ? <p className="apiStateWarn">Snapshot is not trusted. Comparison rows are shown as UNVERIFIED; no match is inferred from stale or incomplete data.</p> : null}
      {report?.snapshotAvailable && report.snapshotTrusted === true ? <p>Read-only snapshot versus authenticated engine ledger. A row-level match is diagnostic, not proof of fill or trade history.</p> : null}
    </div>
    {comparisonError
      ? <div className="danger">Position reconciliation error: {comparisonError}</div>
      : report?.rows?.length
        ? <div className="tablewrap"><table>
          <thead><tr><th>SYMBOL</th><th>TRADETRON</th><th>ENGINE LEDGER</th><th>STATUS</th></tr></thead>
          <tbody>{report.rows.map(row => <tr key={row.symbol}>
            <td className="symbol">{row.symbol}</td>
            <td>{row.tradetronLabel}</td>
            <td>{row.engineLedgerLabel}</td>
            <td className={row.comparisonStatus === 'MATCHED' || row.comparisonStatus === 'CLOSED (dust)' ? 'up' : row.comparisonStatus === 'MISMATCH' ? 'down' : 'muted'}>{row.comparisonStatus}</td>
          </tr>)}</tbody>
        </table></div>
        : <div className="lockedText">{report?.snapshotAvailable && report.snapshotTrusted
          ? 'No open positions, dust rows, or engine-ledger-only symbols to reconcile.'
          : 'No comparison rows available yet. The panel will show no data until snapshot and ledger rows are returned.'}</div>}
    {report ? <div className="micro">
      <span>Snapshot open legs: {report.openPositionCount ?? 'no data'}</span>
      <span>Visible normalized open rows: {report.visibleOpenRowCount}</span>
      <span>Engine ledger open symbols: {report.engineLedgerOpenCount}</span>
      <span>Matched: {report.matchedCount} · Mismatch: {report.mismatchCount} · Unverified: {report.unverifiedCount} · Closed dust: {report.closedDustCount}</span>
    </div> : null}
  </Panel>;
}

function Testnet({ settings, health, busy, mutate, positions, tradetronDeployments = [], developerSync = null, developerApiConfigured = false, entrySafety = null, accountDataProtected = false }) {
  const currentPositionSummary = summarizeCurrentPositionCount({ eventPositions: positions, deployments: tradetronDeployments, syncState: developerSync, configured: developerApiConfigured });
  const status = getWorkerStatusDisplay({
    autoTrade: settings.auto_trade === true,
    continuousMode: settings.continuous_mode === true,
    emergencyStop: settings.emergency_stop === true,
    currentOpenPositions: entrySafety?.trusted === true ? (entrySafety?.openPositionCount ?? null) : null,
    maxOpenPositions: entrySafety?.maxOpenPositions ?? settings.max_open_positions ?? null
  });
  const workerOnline = health?.workerLeaseActive === true && health?.heartbeatFresh === true;
  const autoTradeTone = settings.emergency_stop === true ? 'critical' : status.capReached && settings.auto_trade === true ? 'warning' : '';
  const healthAges = 'Tick: ' + formatHealthAge(health?.tickAgeMs) +
    ' · Heartbeat: ' + formatHealthAge(health?.heartbeatAgeMs) +
    ' · Lease: ' + formatLeaseRemaining(health?.leaseRemainingMs);
  return <>
    <section className="cards">
      <Card label="ENVIRONMENT" value="SIGNAL ONLY" sub="production market feed"/>
      <Card label="AUTO TRADE" value={settings.auto_trade === true ? 'ON' : 'OFF'} sub={status.autoTradeSubtitle} tone={autoTradeTone}/>
      <Card label="CONTINUOUS MODE" value={status.continuousValue} sub={status.continuousSubtitle} tone={settings.emergency_stop === true && settings.auto_trade === true ? 'critical' : status.capReached && settings.auto_trade === true && settings.continuous_mode === true ? 'warning' : ''}/>
      <Card label="CURRENT OPEN POSITIONS" value={accountDataProtected ? 'LOCKED' : currentPositionSummary.count === null ? currentPositionSummary.status : currentPositionSummary.count} sub={accountDataProtected ? 'enter ENGINE_SECRET to load position records' : currentPositionSummary.detail}/>
    </section>
    <Panel title="Worker Status · Signal Only">
      <div className="lockedText">Direct Delta execution is disabled. Tradetron Live Offline is the simulation layer; only verified callbacks create the scanner's event-ledger positions and closed trades.</div>
      <div className="statusLine">
        <span title="Worker lease is active AND heartbeat is fresh (heartbeat age under 3 minutes); both are required for ONLINE.">Worker {workerOnline ? 'ONLINE' : 'OFFLINE'}</span>
        {' · '}
        <span title="A current worker lease has not expired.">Lease {health?.workerLeaseActive ? 'ACTIVE' : 'INACTIVE'}</span>
        {' · '}
        <span title="Worker heartbeat received within last 3 minutes.">Heartbeat {health?.heartbeatFresh ? 'FRESH' : 'STALE'}</span>
        {' · '}
        <span title="Last market tick is less than 3 minutes old.">Tick {health?.tickFresh ? 'FRESH' : 'STALE'}</span>
        {' · '}
        <span title="Market tick and worker heartbeat are fresh, and the worker lease is active. This endpoint does not independently test Delta or Tradetron API availability.">Exchange {health?.exchangeHealthy ? 'HEALTHY' : 'DOWN'}</span>
        {' · '}
        <span title="No emergency halt active.">Emergency stop {settings.emergency_stop === true ? 'ACTIVE' : 'RELEASED'}</span>
      </div>
      <div className="healthAges">{healthAges}</div>
      <p className="muted">Entries require a valid signal, configured Tradetron route, trusted position snapshot when the Developer API is configured, fresh market data, acceptable risk/margin, same-symbol duplicate protection, AND global position cap allowance ({status.hasCapData ? status.capLabel + ' used' : 'NO DATA'}). This panel is status-only; direct Delta orders cannot be enabled here.</p>
    </Panel>
  </>;
}
function Settings({ settings, secret, setSecret, busy, mutate, onUnlock, onLock, authenticated = false }) {
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
      <label>ENGINE_SECRET<input type="password" value={secret} onChange={e=>setSecret(e.target.value)} placeholder={authenticated ? "Session active — enter again only if needed" : "Enter once to unlock private data"} autoComplete="current-password"/><small className="settingHint">The secret is sent once to establish a signed HttpOnly session cookie. It is not kept in localStorage or sessionStorage. The 7-day session renews while the dashboard is actively used and expires after 7 days of inactivity.</small></label>
      <label>Risk % per trade<input type="number" min="0.1" max="5" step="0.1" value={draft.riskPct} onChange={e=>changeDraft('riskPct',e.target.value)} disabled={busy} required/></label>
      <div className="lockedText"><b>Global scanner position cap: DISABLED.</b> Entries still require a valid signal, an available Tradetron route, acceptable margin and duplicate-symbol checks.</div>
      <label>Momentum RR<input type="number" min="1" max="5" step="0.1" value={draft.momentumRr} onChange={e=>changeDraft('momentumRr',e.target.value)} disabled={busy} required/></label>
      <label>Scalping RR<input type="number" min="1" max="5" step="0.1" value={draft.scalpingRr} onChange={e=>changeDraft('scalpingRr',e.target.value)} disabled={busy} required/></label>
      <label>TP1 %<input type="number" min="1" max="99" step="1" value={draft.tp1Pct} onChange={e=>changeDraft('tp1Pct',e.target.value)} disabled={busy} required/></label>
      <label>Max hold minutes<input type="number" min="1" max="1440" step="1" value={draft.maxHoldMinutes} onChange={e=>changeDraft('maxHoldMinutes',e.target.value)} disabled={busy} required/></label>
    </div>
    <div className="settingsActions">
      <span className={`saveStatus ${statusClass}`} aria-live="polite">{saveState || 'Save the current values to the server. Changes are kept only after a successful save.'}</span>
      <div className="settingsButtons"><button className="action" type="button" onClick={onUnlock} disabled={busy || !secret}>{authenticated ? 'Refresh Session' : 'Unlock Private Data'}</button>{authenticated ? <button className="action" type="button" onClick={onLock} disabled={busy}>Lock Session</button> : null}<button className="action" type="button" onClick={discardChanges} disabled={busy || !dirty}>Discard</button><button className="saveSettings" type="submit" disabled={busy} title="Persist these settings to the server">{busy ? 'Saving…' : 'Save Settings'}</button></div>
    </div>
  </form></div></Panel><Panel title="Strategy / Safety Defaults"><div className="ruleGrid"><span>Momentum: EMA9/21/50 + RSI 54–68 / 32–46 + adaptive volume gate + ATR stop ≥0.95%</span><span>Scalping: 1m/5m EMA + RSI + VWAP + adaptive volume gate + stop ≥0.75%</span><span>Confirmed score: ≥80 (hard floor)</span><span>Volume qualification: momentum default 0.75x with controlled sparse-volume fallback; scalping default 1.25x</span><span>Entry candle-range gate: Momentum ≤4.00x ATR; Scalping ≤3.00x ATR</span><span>Price-to-EMA21 distance: Momentum ≤3.50x ATR; Scalping ≤2.50x ATR</span><span>BTC regime: FLAT/mixed is neutral; only fully opposing BTC 5m+15m blocks; extreme opposing regimes can use the strong-local override</span><span>Fee + spread budget: 20% of 1R Momentum / 25% Scalping</span><span>Risk sizing: configurable per-trade equity risk (database default 1%), whole contracts, max 3x configurable notional cap</span><span>BTC override still respects spread, cost, stop, margin and duplicate-symbol prevention; scanner daily loss / trade-count quotas are disabled</span><span>Exits: TP1 33% at 1R, BE+fees, trail 1R, final TP default 2.5R</span></div></Panel><Panel title="Environment Lock"><div className="liveLock">PRODUCTION MARKET · SIGNAL ONLY. The scanner reads Delta India production market data and sends signals only; direct Delta order APIs are hard-locked.</div></Panel></>;
}
function TradetronActivity({ events, signalStats = null, webhookSecretConfigured = false, accountDataProtected = false }) {
  if (accountDataProtected) return <Panel title="Tradetron Offline Activity · Protected"><div className="lockedText">Private event rows and signal counts are hidden. Enter ENGINE_SECRET in Settings. This does not change the integration status: authenticated callbacks still require a supported sender or relay.</div></Panel>;
  const rows = (events || []).slice(0, 30);
  const webhookUrl = typeof window !== 'undefined'
    ? window.location.origin + '/api/tradetron/webhook'
    : '/api/tradetron/webhook';
  return <Panel title="Tradetron Offline Activity · actual events received">
    <div className="lockedText"><b>Inbound callback endpoint:</b> <span className="mono">{webhookUrl}</span><br/><small>{webhookSecretConfigured ? 'Receiver secret is configured in Vercel, but this URL only receives callbacks—it does not enable delivery from Tradetron. Support has indicated direct outbound webhooks are unavailable for this account. TT EVENTS stays at zero until a separately verified relay sends authenticated fill/position/exit callbacks. Read-only Developer API snapshots and notifications are not fills.' : 'WEBHOOK SECRET MISSING in Vercel. Add TRADETRON_WEBHOOK_SECRET as a sensitive Production variable and redeploy. This URL only receives callbacks; a supported sender or relay must send the same secret in the Authorization: Bearer or X-Tradetron-Webhook-Secret header.'}</small></div>
    {rows.length ? <div className="tablewrap"><table><thead><tr><th>TIME</th><th>EVENT</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>PNL</th><th>STATUS</th><th>EXECUTION</th></tr></thead><tbody>{rows.map(e => <tr key={e.event_id}><td>{e.event_at ? new Date(e.event_at).toLocaleTimeString('en-IN') : new Date(e.created_at).toLocaleTimeString('en-IN')}</td><td>{e.event_type || 'UNKNOWN'}</td><td className="symbol">{e.symbol || '—'}</td><td className={e.side==='BUY'?'up':e.side==='SELL'?'down':''}>{e.side || '—'}</td><td>{fmtQty(e.qty)}</td><td>{price(e.price)}</td><td className={num(e.pnl)>=0?'up':'down'}>{e.pnl == null ? '—' : money(e.pnl)}</td><td>{e.status || '—'}</td><td className="mono">{e.execution_id || '—'}</td></tr>)}</tbody></table></div>
    : <div className="lockedText">No authenticated callback events have reached this receiver. This is expected until a supported sender or relay is available for this account. Read-only Developer API positions and notifications are shown separately and are never treated as fills or closed trades.</div>}
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

function TradetronDeveloperApiPanel({ configured = false, sync = null, deployments = [], privateDataProtected = false, notifications = [], notificationSync = null, pnlHistory = [], marketCache = [] }) {
  if (privateDataProtected) {
    return <Panel title="Tradetron Live Mirror · read-only API + event callbacks"><div className="lockedText"><b className="apiStateWarn">PRIVATE ACCOUNT DATA LOCKED</b><p>For privacy, Tradetron deployment and position details are only returned when the correct ENGINE_SECRET is supplied. Enter it in Settings to view these read-only account snapshots.</p></div></Panel>;
  }
  const stale = !!sync?.last_success_at && Date.now() - Date.parse(sync.last_success_at) > 180000;
  const status = sync?.status || (configured ? 'WAITING FOR FIRST SYNC' : 'NOT CONFIGURED');
  const statusClass = status === 'OK' && !stale ? 'apiStateOk' : (status === 'ERROR' || stale ? 'apiStateError' : 'apiStateWarn');
  const mirror = summarizeTradetronSnapshots(deployments);
  const openPnlTooltip = stockTokenOpenPnlTooltip(mirror.openRows, marketCache, mirror.openPnl);
  const pnlHistoryInsights = buildPnlHistoryInsights(pnlHistory);
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
      <span>Deployments: {sync?.deployment_count ?? deployments.length} · Raw position rows: {sync?.position_count ?? mirror.totalRows} · Reported open legs: {mirror.openCount === null ? 'UNKNOWN' : mirror.openCount}</span>
      {sync?.last_error ? <p className="apiStateError">Last sync warning/error: {sync.last_error}</p> : null}
      {!configured ? <p>Add the read-only TRADETRON_DEVELOPER_API_KEY to the Railway worker, then apply the migration documented in db/migrations/20261012080000_tradetron_developer_api_sync.sql.</p> : null}
      {configured && !sync ? <p>Waiting for the worker's first sync. If this persists, confirm the Supabase migration has been applied.</p> : null}
      <p><b>Source of truth:</b> current open legs and deployment P&amp;L below come from the read-only Tradetron API snapshot. Closed-trade details, exit prices and fees require authenticated Tradetron activity callbacks; they are not inferred from a position snapshot.</p>
    </div>
    <section className="cards">
      <Card label="TT OPEN LEGS" value={configured ? (mirror.openCount === null ? 'UNKNOWN' : mirror.openCount) : '—'} sub={mirror.openCount === null ? (mirror.positionsHidden ? 'position rows hidden; count unavailable' : 'no verified open-leg count') : mirror.positionsHidden ? 'some position rows hidden by Tradetron' : 'reported by current API snapshot'} />
      <Card label="TT DEPLOYMENT P&L RAW" value={mirror.reportedPnl === null ? '—' : fmtRawPrice(mirror.reportedPnl, 2)} sub={"Raw deployment value; " + (mirror.reportedPnlCurrencyCode ? "API currency " + mirror.reportedPnlCurrencyCode + "; " : "currency not identified; ") + "P&L semantics not independently verified; not scanner ledger P&L"} />
      <Card label="TT OPEN P&L RAW" value={mirror.openPnl === null ? '—' : fmtRawPrice(mirror.openPnl, 2)} sub="Raw sum of explicitly named M2M fields; currency/unit still unverified" title={openPnlTooltip} />
      <Card label="TT DEPLOYMENTS" value={mirror.deployments} sub="returned by read-only API" />
    </section>
    {mirror.openPnl !== null && mirror.reportedPnl !== null && Math.abs(mirror.openPnl - mirror.reportedPnl) > Math.max(1, Math.abs(mirror.reportedPnl) * 0.1) ? <div className="lockedText apiStateWarn"><b>P&amp;L reconciliation warning:</b> verified open/M2M rows and deployment aggregate differ materially. Both are preserved as separate read-only API figures; neither is merged into the scanner's realized-trade ledger.</div> : null}
    {deployments.length ? <div className="tablewrap"><table>
      <thead><tr><th>DEPLOYMENT</th><th>STATUS</th><th>MODE</th><th>BROKER</th><th>OPEN LEGS</th><th>REPORTED P&amp;L</th><th>CURRENCY</th><th>AS OF</th></tr></thead>
      <tbody>{deployments.map(row => <tr key={row.deployment_id}>
        <td>{row.deployment_name || row.deployment_id}<br/><small className="muted">ID {row.deployment_id}</small></td>
        <td>{row.status || '—'}</td><td>{row.deployment_type || '—'}</td><td>{row.broker || '—'}</td>
        <td>{row.positions_hidden ? 'HIDDEN' : (row.open_positions ?? '—') + ' reported'}<br/><small className="muted">{Array.isArray(row.positions) ? row.positions.length : 0} raw row(s)</small></td>
        <td className={safeNum(row.pnl) === null ? 'muted' : safeNum(row.pnl) >= 0 ? 'up' : 'down'}>{row.pnl == null || safeNum(row.pnl) === null ? '—' : fmtRawPrice(row.pnl, 2)}</td><td>{row.currency_code || 'UNIT UNVERIFIED'}</td>
        <td>{row.as_of ? new Date(row.as_of).toLocaleString('en-IN') : (row.last_success_at ? new Date(row.last_success_at).toLocaleString('en-IN') : '—')}</td>
      </tr>)}</tbody>
    </table></div> : <div className="lockedText">No deployment snapshot is available yet. A successful API response with an empty positions array means no visible position rows; it does not create placeholder trades.</div>}
    <div className="panelTitle"><h3>Current Open Positions · Tradetron</h3></div>
    {mirror.openRows.length ? <div className="tablewrap"><table>
      <thead><tr><th>DEPLOYMENT</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>LTP / MARK</th><th>VALUE RAW (UNIT UNVERIFIED)</th><th>API P&amp;L RAW (UNIT UNVERIFIED)</th><th>STATUS</th></tr></thead>
      <tbody>{mirror.openRows.map(row => <tr key={row.key}>
        <td>{row.deploymentName}<br/><small className="muted">ID {row.deploymentId ?? '—'}</small></td>
        <td className="symbol" title={row.rawSymbol}>{row.symbol}</td>
        <td className={row.side === 'BUY' ? 'up' : row.side === 'SELL' ? 'down' : 'muted'}>{row.side || '—'}</td>
        <td>{row.quantity === null ? '—' : fmtQty(row.quantity)}</td>
        <td>{row.entryPrice === null ? '—' : price(row.entryPrice)}</td>
        <td>{row.markPrice === null ? '—' : price(row.markPrice)}</td>
        <td>{fmtRawPrice(row.marketValue, 2)}</td>
        <td className={safeNum(row.pnl) === null ? 'muted' : 'mono'} title={stockTokenPnlTooltip(row.symbol, row.pnl, contractValueForSymbol(marketCache, row.symbol)) || (row.pnlSource ? "Raw Developer API field: " + row.pnlSource + ". A generic pnl field is not verified M2M and is not included in open P&L." : "No P&L source field was identified in this API row.")}><div>{fmtRawPrice(row.pnl, 2)}</div><small className="muted">{row.pnlSource ? "API field: " + row.pnlSource + (["m2m","mtm","unrealized_pnl","unrealizedPnl","open_pnl","openPnl","mark_to_market","markToMarket"].includes(row.pnlSource) ? " · M2M-named" : " · semantics unverified") : "source unavailable"}</small>{hasRawPnlAnomaly(row) ? <div><b className="apiStateWarn">⚠ PnL anomaly</b></div> : null}</td>
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
    <div className="lockedText"><b>Trade history / exit reconciliation:</b> {sync?.status === 'OK' ? 'latest read-only position snapshot sync is healthy.' : 'position snapshot is not confirmed fresh.'} Developer API notifications below provide a read-only event timeline, but they are not converted to fill/trade rows. Actual per-trade entry/exit prices, fees and realized P&amp;L still require a verified trade-detail endpoint or authenticated fill data. Generic row-level “pnl” fields are displayed raw with no currency conversion and are not summed as open P&amp;L unless the API identifies them as M2M/unrealized P&amp;L.</div>
    <div className="panelTitle"><h3>Recent Tradetron P&amp;L History · 5-minute snapshots</h3></div>
    <div className="lockedText"><span>Deployment-level only. Not per-trade. Repeated polls update the same five-minute bucket; snapshots older than 90 days are pruned. Day Change compares a matching time from yesterday when available; otherwise it falls back to the previous nonzero sample.</span></div>
    {pnlHistory.length ? <div className="tablewrap"><table>
      <thead><tr><th>TIME</th><th>DEPLOYMENT</th><th>REPORTED P&amp;L RAW</th><th>OPEN LEGS</th><th>DAY CHANGE</th><th>TREND</th><th>STATUS</th></tr></thead>
      <tbody>{pnlHistory.slice(0, 36).map(row=>{
        const insight = pnlHistoryInsights.get(String(row.snapshot_id)) || {};
        const pnlValue = safeNum(row.reported_pnl);
        const currency = row.currency_code || 'UNIT UNVERIFIED';
        const dayValue = insight.dayChange;
        const trendLabel = insight.trend === 'DOWN' ? '↓ Falling'
          : insight.trend === 'UP' ? '↑ Recovering'
            : insight.trend === 'FLAT' ? '→ Flat' : 'Unknown';
        const trendClass = insight.trend === 'DOWN' ? 'down'
          : insight.trend === 'UP' ? 'up' : 'muted';
        return <tr key={row.snapshot_id}>
          <td>{row.captured_at ? new Date(row.captured_at).toLocaleString('en-IN') : 'Unknown'}</td>
          <td>{row.deployment_name || row.deployment_id}<br/><small className="muted">ID {row.deployment_id}</small></td>
          <td className={pnlValue === null ? 'muted' : pnlValue >= 0 ? 'up' : 'down'}>{pnlValue === null ? 'Unknown' : currency + ' ' + fmtRawPrice(pnlValue,2)}</td>
          <td>{row.open_positions ?? 'Unknown'}</td>
          <td title={insight.dayChangeBasis || 'Not enough history'} className={dayValue === null ? 'muted' : dayValue >= 0 ? 'up' : 'down'}>{dayValue === null ? 'Unknown' : (row.currency_code || 'RAW') + ' ' + fmtRawPrice(dayValue,2)}<br/><small className="muted">{insight.dayChangeBasis || 'Not enough history'}</small></td>
          <td className={trendClass} title={insight.trendDelta === null || insight.trendDelta === undefined ? 'Not enough prior nonzero P&L history' : 'Change versus the previous nonzero P&L sample: ' + fmtRawPrice(insight.trendDelta,2)}>{trendLabel}</td>
          <td>{row.status || 'Unknown'}</td>
        </tr>;
      })}</tbody>
    </table></div> : <div className="lockedText">No P&amp;L history snapshots recorded yet. The first bucket is written after the next successful Developer API sync once the new database migration is applied.</div>}
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