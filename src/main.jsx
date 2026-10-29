import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { indiaDateKey } from './date-utils.js';
import GridStrategy from './GridStrategy.jsx';
import { DEFAULT_VISIBLE_MARKET_LIMIT, selectOpenPositionSymbols, selectVisibleMarketRows, selectVisibleSignalRows } from './market-view.js';
import { assessDeltaRange, fmtMultiplier, fmtPrice as fmtRawPrice, fmtRsi, safeNum } from './formatters.js';
import { blockersDisplay, gateTooltip } from './gate-result.js';
import { buildRiskGovernorGates, buildNormalizedScoreDiagnostic } from './risk-governor.js';
import { normalizedScoreFromView as normalizedScoreFrom, visibleScoreFrom, passesScoreFilter, normalizedScoreTooltip, showAllPreferenceKey, readShowAllPreference, writeShowAllPreference } from './normalized-score-view.js';
import { resolveDashboardRouteContext } from './dashboard-route-state.js';
import { summarizeRotationLedger } from './rotation-ledger-state.js';
import { formatHealthAge, formatLeaseRemaining, formatRetentionLastRun, getEmergencyStopTooltip, getGlobalPositionCapDisplay, getWorkerStatusDisplay } from './worker-status-display.js';

const tabs = [
  ['dashboard','Dashboard'],['rotation','Profit Rotation'],['momentum','Momentum'],['momentum-history','Mom History'],
  ['scalping','Scalping'],['grid','Grid Strategy'],['scalp-history','Scalp History'],['options','Options'],['positions','Positions'],['delta-testnet-positions','Delta Testnet Positions'],['trade-history','Trade History'],
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
    // Keep unaffordable candidates in signal history, but out of current signal tables.
    if (String(x?.stage || '').trim().toUpperCase() === 'SKIPPED_INSUFFICIENT_CAPITAL') continue;
    const key = x.symbol + ':' + x.strategy;
    if (!m.has(key) || new Date(x.captured_at) > new Date(m.get(key).captured_at)) m.set(key, x);
  }
  return [...m.values()];
};

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[Dashboard] React render error:', error, info?.componentStack || '');
  }

  render() {
    if (this.state.hasError) {
      return <div className="terminal">
        <section className="panel">
          <div className="panelTitle"><h2>Dashboard could not render</h2></div>
          <div className="pad">
            <p>The dashboard caught a rendering error instead of showing a blank screen.</p>
            <pre className="error" role="alert">{String(this.state.error?.message || 'Unknown React rendering error')}</pre>
            <button className="action" type="button" onClick={() => window.location.reload()}>Reload dashboard</button>
          </div>
        </section>
      </div>;
    }
    return this.props.children;
  }
}

function App() {
  const [tab, setTab] = useState('dashboard');
  const [state, setState] = useState(null);
  const [market, setMarket] = useState([]);
  const [testnetProducts, setTestnetProducts] = useState(null);
  const [health, setHealth] = useState(null);
  const [secret, setSecret] = useState('');
  const secretRef = useRef(secret);
  const [error, setError] = useState('');
  const [marketError, setMarketError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [showEstopReleaseConfirmation, setShowEstopReleaseConfirmation] = useState(false);
  const [estopReleaseVerified, setEstopReleaseVerified] = useState(false);
  const [estopReleaseCountdownEndsAt, setEstopReleaseCountdownEndsAt] = useState(0);
  const [estopReleaseToken, setEstopReleaseToken] = useState('');
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

    // This separate catalog is fetched from Delta India TESTNET, not the
    // production market feed. The server caches it and fails closed if
    // pagination is incomplete or the exchange cannot be verified.
    const routeRequest = (async () => {
      try {
        const response = await fetch('/api/market?type=testnet-products&t=' + Date.now(), { cache: 'no-store' });
        const result = await response.json();
        setTestnetProducts(response.ok && result?.success === true
          ? result
          : { ...(result && typeof result === 'object' ? result : {}), success: false, complete: false, result: [] });
      } catch (e) {
        setTestnetProducts({
          success: false,
          environment: 'DELTA_TESTNET',
          complete: false,
          result: [],
          error: String(e?.message || 'Delta Testnet product catalog unavailable')
        });
      }
    })();

    await Promise.allSettled([marketRequest, stateRequest, routeRequest]);
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

  const settings = state?.settings && typeof state.settings === 'object' && !Array.isArray(state.settings) ? state.settings : {};
  const trades = Array.isArray(state?.deltaTestnetTrades) ? state.deltaTestnetTrades : [];
  const positions = Array.isArray(state?.deltaTestnetPositions) ? state.deltaTestnetPositions : [];
  const accountDataProtected = state?.accountDataProtected === true;
  const tradeHistoryComplete = state?.deltaTestnetTradeRowCount != null && Number(state.deltaTestnetTradeRowCount) === trades.length;
  const rotationLedger = Array.isArray(state?.ledger) ? state.ledger : [];
  const rotationLedgerComplete = state?.ledgerRowCount != null && Number(state.ledgerRowCount) === rotationLedger.length;
  const signalRows = Array.isArray(state?.signalCache)
    ? state.signalCache
    : Array.isArray(state?.signals) ? state.signals : [];
  const optionCache = Array.isArray(state?.optionCache) ? state.optionCache : [];
  const deltaTestnetOrders = Array.isArray(state?.deltaTestnetOrders) ? state.deltaTestnetOrders : [];
  const logs = Array.isArray(state?.logs) ? state.logs : [];
  const signals = latestSignals(signalRows);
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
      if (patch.autoTrade !== undefined &&
          (typeof data.persisted?.auto_trade !== 'boolean' || data.persisted.auto_trade !== patch.autoTrade)) {
        throw new Error('Auto Trade save could not be verified against the persisted database value.');
      }
      if (patch.emergencyStop !== undefined &&
          (typeof data.persisted?.emergency_stop !== 'boolean' || data.persisted.emergency_stop !== patch.emergencyStop)) {
        throw new Error('E-STOP save could not be verified against the persisted database value.');
      }
      if (data.persisted && typeof data.persisted === 'object' && !Array.isArray(data.persisted)) {
        setState(current => current && ({
          ...current,
          settings: { ...(current.settings || {}), ...data.persisted }
        }));
      }
      await load();
      if (data.auditLogPersisted === false) {
        setError(data.warning || 'Settings saved, but the audit log could not be persisted.');
      }
      return true;
    } catch (e) {
      setError(e.message || 'Control failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const estopReleaseCountdown = Math.max(
    0,
    Math.ceil((estopReleaseCountdownEndsAt - clock) / 1000)
  );
  const requestEmergencyStopChange = async () => {
    if (settings.emergency_stop === true) {
      setBusy(true);
      setError('');
      try {
        const response = await fetch('/api/engine/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ requestEmergencyStopRelease: true })
        });
        const data = await response.json();
        const availableAt = Number(data.emergencyStopReleaseAvailableAt);
        if (!response.ok || !data.success ||
            typeof data.emergencyStopReleaseToken !== 'string' ||
            !data.emergencyStopReleaseToken ||
            !Number.isFinite(availableAt)) {
          throw new Error(data.error || 'Could not start the E-STOP release safety challenge.');
        }
        setEstopReleaseVerified(false);
        setEstopReleaseToken(data.emergencyStopReleaseToken);
        setEstopReleaseCountdownEndsAt(availableAt);
        setShowEstopReleaseConfirmation(true);
      } catch (e) {
        setError(e.message || 'Could not start the E-STOP release safety challenge.');
      } finally {
        setBusy(false);
      }
      return;
    }
    void mutate({ emergencyStop: true });
  };
  const cancelEmergencyStopRelease = () => {
    setShowEstopReleaseConfirmation(false);
    setEstopReleaseVerified(false);
    setEstopReleaseToken('');
    setEstopReleaseCountdownEndsAt(0);
  };
  const confirmEmergencyStopRelease = async () => {
    if (settings.emergency_stop !== true || estopReleaseCountdown > 0 ||
        !estopReleaseVerified || !estopReleaseToken) return;
    const saved = await mutate({
      emergencyStop: false,
      emergencyStopReleaseVerified: true,
      emergencyStopReleaseToken: estopReleaseToken
    });
    if (saved) {
      cancelEmergencyStopRelease();
    } else {
      // A server-side expiry/replay/validation failure requires a fresh challenge.
      setEstopReleaseToken('');
      setEstopReleaseVerified(false);
      setEstopReleaseCountdownEndsAt(0);
    }
  };

  const selected = useMemo(() => {
    const chosen = inspect || signals[0]?.symbol || '';
    const candidates = signals.filter(x => x.symbol === chosen);
    return candidates.find(x => x.strategy === 'MOMENTUM') || candidates[0] || null;
  }, [inspect, signals]);

  const selectedScalp = selected ? signals.find(x => x.symbol === selected.symbol && x.strategy === 'SCALPING') : null;
  const stale = !health?.tickFresh;
  const executionCoverage = state?.executionCoverage && typeof state.executionCoverage === 'object' && !Array.isArray(state.executionCoverage) ? state.executionCoverage : null;
  const dashboardRouteContext = resolveDashboardRouteContext({
    catalog: testnetProducts,
    executionMode: executionCoverage?.deltaExecutionMode || 'unknown',
    accountDataProtected,
    positions: accountDataProtected ? null : positions,
    openPositionCount: state?.deltaTestnetOpenPositionCount ?? null,
    now: clock
  });
  const routeSafetyBlocked = !dashboardRouteContext.routeDataVerified ||
    dashboardRouteContext.entrySafetyTrusted !== true;
  const routeSafetyReason = !dashboardRouteContext.catalogFresh
    ? 'Delta Testnet product catalog is unverified or stale'
    : !dashboardRouteContext.testnetModeConfirmed
      ? 'Worker execution mode is not confirmed as Testnet'
      : dashboardRouteContext.entrySafetyTrusted !== true
        ? 'Delta Testnet position data is locked or inconsistent'
        : null;
  const openPositionSymbols = selectOpenPositionSymbols(positions);

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
        <button className="action" disabled={busy || !state || accountDataProtected} onClick={() => mutate({ autoTrade: !settings.auto_trade })} aria-pressed={settings.auto_trade === true} title="Save Auto Trade to dd_settings and confirm the persisted value">
          {settings.auto_trade === true ? 'AUTO TRADE ON' : 'AUTO TRADE OFF'}
        </button>
        <button className="estop" disabled={busy || !state || accountDataProtected} onClick={requestEmergencyStopChange}>
          {settings.emergency_stop ? 'RELEASE E-STOP' : 'EMERGENCY STOP'}
        </button>
      </div>
    </header>
    {stale ? <div className="danger">⚠ WORKER HEARTBEAT / MARKET TICK STALE FOR MORE THAN 3 MINUTES. NEW ENTRIES MUST BE TREATED AS BLOCKED.</div> : null}
    {error || marketError ? <div className="error">{error || marketError}</div> : null}
    <nav>{tabs.map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'live' ? ' 🔒' : ''}</button>)}</nav>
    {accountDataProtected ? <div className="danger">🔒 ACCOUNT DATA LOCKED — Enter ENGINE_SECRET in Settings to view private positions, closed trades, P&amp;L, rotation ledger, Grid state, and account-specific logs. Hidden data is not zero.</div> : null}

    {tab === 'dashboard' && <Dashboard market={market} settings={settings} health={health} positions={positions} accountDataProtected={accountDataProtected} signals={signals} activity={state?.activity || null} deltaTestnetOpenPositionCount={state?.deltaTestnetOpenPositionCount ?? null} deltaTestnetOrders={deltaTestnetOrders} deltaTestnetOrderCount={state?.deltaTestnetOrderCount ?? null} deltaTestnetClosedTodayCount={state?.deltaTestnetClosedTodayCount ?? null} deltaTestnetClosedTodayPnl={state?.deltaTestnetClosedTodayPnl ?? null} deltaTestnetClosedTodayPnlComplete={state?.deltaTestnetClosedTodayPnlComplete === true} executionCoverage={executionCoverage} routeContext={dashboardRouteContext} onInspect={setInspect} inspect={selected} logs={logs} />}
    {tab === 'rotation' && <Rotation ledger={rotationLedger} accountDataProtected={accountDataProtected} ledgerComplete={rotationLedgerComplete} ledgerRowCount={state?.ledgerRowCount ?? null} />}
    {tab === 'momentum' && <EngineView engine="MOMENTUM" signals={signals} entrySafetyBlocked={routeSafetyBlocked} entrySafetyReason={routeSafetyReason} openPositionSymbols={openPositionSymbols} />}
    {tab === 'momentum-history' && <TradeHistory trades={trades.filter(t => t.strategy === 'MOMENTUM')} title="Momentum History" strategy="MOMENTUM" accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} />}
    {tab === 'scalping' && <EngineView engine="SCALPING" signals={signals} entrySafetyBlocked={routeSafetyBlocked} entrySafetyReason={routeSafetyReason} openPositionSymbols={openPositionSymbols} />}
    {tab === 'grid' && <GridStrategy settings={settings} market={market} busy={busy} mutate={mutate} accountDataProtected={accountDataProtected} gridEntrySafety={executionCoverage?.gridEntrySafety || null} />}
    {tab === 'options' && <OptionsView signals={signals} settings={settings} optionCache={optionCache} executionCoverage={state?.executionCoverage || null} />}
    {tab === 'scalp-history' && <TradeHistory trades={trades.filter(t => t.strategy === 'SCALPING')} title="Scalping History" strategy="SCALPING" accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} />}
    {tab === 'positions' && <Positions rows={positions} accountDataProtected={accountDataProtected} />}
    {tab === 'delta-testnet-positions' && <DeltaTestnetPositions rows={state?.deltaTestnetPositions || []} accountDataProtected={accountDataProtected} mode={executionCoverage?.deltaExecutionMode || 'disabled'} />}
    {tab === 'trade-history' && <TradeHistory trades={trades} title="Trade History · Delta Testnet Ledger" accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} />}
    {tab === 'pnl' && <PNL trades={trades} settings={settings} accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} />}
    {tab === 'paper' && <Panel title="Paper Trading"><div className="lockedText">Scanner is signal-only. Paper execution is not enabled. Direct orders are restricted to Delta Exchange Testnet.</div></Panel>}
    {tab === 'testnet' && <Testnet settings={settings} health={health} currentOpenPositionCount={state?.deltaTestnetOpenPositionCount ?? null} accountDataProtected={accountDataProtected} />}
    {tab === 'live' && <Panel title="Live Trading"><div className="liveLock">🔒 DIRECT DELTA EXECUTION LOCKED<br/><small>Direct production/live Delta orders are hard-locked. Only Delta Exchange Testnet execution is allowed.</small></div></Panel>}
    {tab === 'analytics' && <Analytics trades={trades} accountDataProtected={accountDataProtected} tradesComplete={tradeHistoryComplete} tradeRowCount={state?.deltaTestnetTradeRowCount ?? null} />}
    {tab === 'settings' && <Settings settings={settings} currentOpenPositions={state?.deltaTestnetOpenPositionCount ?? null} secret={secret} setSecret={v => { secretRef.current = v; setSecret(v); }} busy={busy} mutate={mutate} onUnlock={unlockSession} onLock={lockSession} authenticated={state?.accountDataProtected === false} />}
    <footer>Delta Exchange India · public market feed · direct execution is Testnet-only when enabled · live orders hard-locked</footer>
    {showEstopReleaseConfirmation ? <div className="confirmOverlay">
      <div className="confirmDialog" role="dialog" aria-modal="true" aria-labelledby="estopReleaseTitle">
        <h3 id="estopReleaseTitle">Confirm E-STOP release</h3>
        <p>E-STOP is currently blocking new entries. Releasing it may allow new entries on a future scan cycle. Verify the exchange position state and worker health before continuing.</p>
        <p role="status" aria-live="polite">{estopReleaseCountdown > 0
          ? 'Safety countdown: ' + estopReleaseCountdown + ' second' + (estopReleaseCountdown === 1 ? '' : 's') + ' remaining.'
          : 'Countdown complete. Verify system state before release.'}</p>
        <label className="gridCheck">
          <input
            type="checkbox"
            checked={estopReleaseVerified}
            onChange={event => setEstopReleaseVerified(event.target.checked)}
            disabled={busy}
          />
          I have verified system state
        </label>
        <div className="confirmActions">
          <button className="action" type="button" onClick={cancelEmergencyStopRelease} disabled={busy}>Keep E-STOP Active</button>
          <button className="estop" type="button" onClick={confirmEmergencyStopRelease} disabled={busy || estopReleaseCountdown > 0 || !estopReleaseVerified || !estopReleaseToken}>Release E-STOP</button>
        </div>
      </div>
    </div> : null}
  </div>;
}

function DeltaTestnetPositions({ rows = [], accountDataProtected = false, mode = 'disabled' }) {
  const positions = Array.isArray(rows) ? rows : [];
  const fmtUsd = value => {
    const amount = safeNum(value);
    if (amount === null) return '—';
    const prefix = amount < 0 ? '-USD ' : 'USD ';
    return prefix + Math.abs(amount).toLocaleString('en-US', { maximumFractionDigits: 4 });
  };
  const timestamp = value => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  };
  return <Panel title="Delta Testnet Positions">
    <div className="muted" style={{ marginBottom: 10 }}>
      Private Delta Exchange Testnet position ledger · mode: {String(mode).toUpperCase()}.
    </div>
    {accountDataProtected
      ? <div className="danger">🔒 Testnet account data is locked. Enter ENGINE_SECRET in Settings to view these positions.</div>
      : positions.length === 0
        ? <div className="muted">No Delta Testnet position rows recorded yet.</div>
        : <div className="tablewrap"><table>
          <thead><tr>
            <th>Status</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th>
            <th>Unrealized P&amp;L</th><th>Realized P&amp;L</th><th>Stop Loss</th><th>Take Profit</th>
            <th>Strategy</th><th>Opened (IST)</th><th>Closed (IST)</th><th>Order ID</th>
          </tr></thead>
          <tbody>{positions.map((row, index) => <tr key={String(row.id || row.order_id || row.symbol) + ':' + index}>
            <td><span className={'badge ' + (row.status === 'OPEN' ? 'test' : 'muted')} title={row.status === 'CLOSED_EXTERNALLY' ? 'Position was absent from the authoritative Delta Testnet snapshot. Exit price and realized P&L are not inferred.' : undefined}>{row.status === 'CLOSED_EXTERNALLY' ? 'CLOSED EXTERNALLY' : row.status || 'UNKNOWN'}</span></td>
            <td className="symbol">{row.symbol || '—'}</td>
            <td>{row.side || '—'}</td>
            <td>{safeNum(row.qty) === null ? '—' : safeNum(row.qty)}</td>
            <td>{price(row.entry_price)}</td>
            <td>{price(row.current_price)}</td>
            <td className={num(row.unrealized_pnl) > 0 ? 'up' : num(row.unrealized_pnl) < 0 ? 'down' : ''}>{fmtUsd(row.unrealized_pnl)}</td>
            <td className={num(row.realized_pnl) > 0 ? 'up' : num(row.realized_pnl) < 0 ? 'down' : ''}>{fmtUsd(row.realized_pnl)}</td>
            <td>{price(row.sl_price)}</td>
            <td>{price(row.tp_price)}</td>
            <td>{row.strategy || '—'}</td>
            <td>{timestamp(row.opened_at)}</td>
            <td>{timestamp(row.closed_at)}</td>
            <td className="mono">{row.order_id || '—'}</td>
          </tr>)}</tbody>
        </table></div>}
  </Panel>;
}

function Panel({ title, children }) {
  return <section className="panel"><div className="panelTitle"><h2>{title}</h2></div><div className="pad">{children}</div></section>;
}
function Card({ label, value, sub, title, tone = '' }) {
  const toneClass = tone === 'critical' ? ' card-critical' : tone === 'warning' ? ' card-warning' : '';
  return <div className={'card' + toneClass} title={title}><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>;
}
function activityTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: true
      })
    : '—';
}
function Dashboard({ market, settings, health, positions, accountDataProtected = false, signals, activity = null, deltaTestnetOpenPositionCount = null, deltaTestnetOrders = [], deltaTestnetOrderCount = null, deltaTestnetClosedTodayCount = null, deltaTestnetClosedTodayPnl = null, deltaTestnetClosedTodayPnlComplete = false, executionCoverage = null, routeContext = null, onInspect, inspect, logs }) {
  const deltaMode = String(executionCoverage?.deltaExecutionMode || '').trim().toLowerCase();
  const deltaModeEnabled = deltaMode === 'testnet';
  const deltaModeUnknown = !['testnet', 'disabled'].includes(deltaMode);
  const unavailableLabel = deltaModeUnknown ? 'WORKER MODE UNKNOWN' : 'NOT TESTNET';
  const modeSubtitle = deltaModeUnknown ? 'Waiting for a valid execution-mode heartbeat from the worker in Supabase' : 'Delta Testnet mode is not enabled in the latest worker heartbeat';
  const usd = value => { const n=safeNum(value); return n===null?'NO DATA':(n<0?'-':'')+'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  const terminal = new Set(['FILLED','CLOSED','CANCELLED','CANCELED','REJECTED','EXPIRED','FAILED','EXITED']);
  const orders = Array.isArray(deltaTestnetOrders)?deltaTestnetOrders:[];
  const orderCountKnown = deltaTestnetOrderCount!==null && deltaTestnetOrderCount!==undefined && Number(deltaTestnetOrderCount)===orders.length;
  const openOrders = orders.filter(o=>!terminal.has(String(o?.state||'').toUpperCase())).length;
  const positionCount = deltaTestnetOpenPositionCount===null||deltaTestnetOpenPositionCount===undefined?null:safeNum(deltaTestnetOpenPositionCount);
  const equityText = accountDataProtected?'LOCKED':!deltaModeEnabled?unavailableLabel:usd(settings.equity);
  const positionText = accountDataProtected?'LOCKED':!deltaModeEnabled?unavailableLabel:positionCount===null?'NO DATA':String(positionCount);
  const orderText = accountDataProtected?'LOCKED':!deltaModeEnabled?unavailableLabel:deltaTestnetOrderCount==null?'NO DATA':!orderCountKnown?'INCOMPLETE DATA':String(openOrders);
  const pnlText = accountDataProtected?'LOCKED':!deltaModeEnabled?unavailableLabel:deltaTestnetClosedTodayPnlComplete?usd(deltaTestnetClosedTodayPnl):deltaTestnetClosedTodayCount==null?'NO DATA':'INCOMPLETE DATA';
  const equitySub = accountDataProtected?'Unlock private dashboard data in Settings to view account balance':!deltaModeEnabled?modeSubtitle:'Available margin: '+usd(settings.available_balance)+' · authenticated worker account snapshot'+(settings.last_tick_at?' · updated '+new Date(settings.last_tick_at).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'}):' · waiting for first worker account snapshot');
  const posSub = accountDataProtected?'Unlock Settings to view positions':!deltaModeEnabled?modeSubtitle:'Delta Testnet exchange open-position count';
  const orderSub = accountDataProtected?'Unlock Settings to view orders':!deltaModeEnabled?modeSubtitle:!orderCountKnown?'Delta Testnet order ledger is incomplete':'Non-terminal Delta Testnet order ledger rows';
  const pnlSub = accountDataProtected?'Unlock Settings to view P&L':!deltaModeEnabled?modeSubtitle:deltaTestnetClosedTodayCount===0?'No Delta Testnet positions recorded as closed today (IST)':deltaTestnetClosedTodayPnlComplete?'Recorded realized P&L across '+deltaTestnetClosedTodayCount+' Delta Testnet position(s) closed today (IST)':'Some realized-P&L rows are missing or the result is partial';
  const blocked = {};
  for(const s of signals||[]) for(const reason of String(s.blocked_reasons||'').split(' · ').filter(Boolean)) blocked[reason]=(blocked[reason]||0)+1;
  const top=Object.entries(blocked).sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>x[0]+' ('+x[1]+')').join(', ');
  const visibleSignals=selectVisibleSignalRows(market,signals,DEFAULT_VISIBLE_MARKET_LIMIT);
  const visibleCoinCount=new Set(visibleSignals.map(s=>s.symbol)).size;
  const openSymbols=selectOpenPositionSymbols(positions);
  const dashboardReadiness = new Map(visibleSignals.map(signal => {
    const gateRows = buildRiskGovernorGates({
      selected: signal,
      health,
      positions: accountDataProtected ? null : positions,
      routedSymbols: routeContext?.routedSymbols || [],
      routeDataVerified: routeContext?.routeDataVerified === true,
      entrySafetyTrusted: routeContext?.entrySafetyTrusted === true
    });
    const failedGates = gateRows.filter(gate => gate.result !== 'PASS');
    return [signal.symbol + ':' + signal.strategy, {
      ready: gateRows.length > 0 && failedGates.length === 0,
      failedGates
    }];
  }));
  return <>
    <section className="cards"><Card label="DELTA TESTNET EQUITY" value={equityText} sub={equitySub}/><Card label="DELTA OPEN POSITIONS" value={positionText} sub={posSub}/><Card label="DELTA OPEN ORDERS" value={orderText} sub={orderSub}/><Card label="TODAY'S P&L (DELTA)" value={pnlText} sub={pnlSub}/></section>
    <Panel title="Last Signal · System Activity">
      <section className="cards">
        <Card label="LAST CONFIRMED SIGNAL" value={activity?.lastConfirmedSignalAvailable === false || !activity ? 'NO DATA' : activity.lastConfirmedSignalAt ? activityTimestamp(activity.lastConfirmedSignalAt) : 'None in last 24h'} sub="CONFIRMED + READY + normalized score ≥ 80 · IST"/>
        <Card label="LAST EXECUTED TRADE" value={accountDataProtected ? 'LOCKED' : activity?.lastExecutedTradeAvailable === true ? (activity.lastExecutedTradeAt ? activityTimestamp(activity.lastExecutedTradeAt) : 'None recorded') : 'NO DATA'} sub={accountDataProtected ? 'Unlock ENGINE_SECRET to view trade timestamps' : 'Most recent executed position opened_at · IST'}/>
        <Card label="TRADES TODAY · EXECUTED" value={accountDataProtected ? 'LOCKED' : activity?.executedTradesTodayCount == null ? 'NO DATA' : Number(activity.executedTradesTodayCount).toLocaleString('en-IN')} sub={accountDataProtected ? 'Unlock ENGINE_SECRET to view private trade counts' : 'Positions opened today (IST), including still-open trades'}/>
        <Card label="SIGNALS TODAY · GENERATED" value={activity?.signalsTodayCount == null ? 'NO DATA' : Number(activity.signalsTodayCount).toLocaleString('en-IN')} sub="Persisted dd_signals observations; history sampling/retention applies"/>
      </section>
      <div className="muted">Visibility only. The signal total is the exact count of stored history observations, not every repeated scan calculation; unchanged observations may be sampled and writes can pause under database storage safeguards.</div>
    </Panel>
    <Panel title={'Full Delta Market Scanner · '+(market?.length||0)+' live perpetuals · Signal Only'}><MarketTable market={market} signals={signals} openPositionSymbols={openSymbols}/></Panel>
    <section className="grid2"><RiskGovernor signals={signals} health={health} positions={accountDataProtected?null:positions} onInspect={onInspect} inspect={inspect} routedSymbols={routeContext?.routedSymbols || []} routeDataVerified={routeContext?.routeDataVerified === true} entrySafetyTrusted={routeContext?.entrySafetyTrusted === true}/>
      <Panel title={'Signal Stages · '+visibleCoinCount+' coins · WATCH → SETUP → CONFIRMED'}><div className="marketCount">Momentum and Scalping status for the same top {visibleCoinCount} coins shown in the market table.</div>
        <div className="tablewrap"><table><thead><tr><th>COIN</th><th>ENG</th><th>STAGE</th><th>SIDE</th><th>SCORE</th><th>QTY</th><th>NOTIONAL</th><th>RISK</th><th>READY</th><th>WHY BLOCKED</th></tr></thead><tbody>
        {visibleSignals.map(s => {
          const positionOpen = openSymbols.has(String(s.symbol || '').toUpperCase());
          const governor = dashboardReadiness.get(s.symbol + ':' + s.strategy);
          const ready = s.ready === true && governor?.ready === true && !positionOpen;
          const governorReasons = (governor?.failedGates || []).map(gate =>
            gate.gate + ': ' + (gate.blockReason || gate.result)
          );
          const existingReasons = Array.isArray(s.gate_results)
            ? blockersDisplay(s.gate_results)
            : fmtReasons(s.blocked_reasons);
          const whyBlocked = s.snapshot_missing
            ? 'No signal snapshot available'
            : positionOpen
              ? 'Open Delta Testnet position detected; duplicate entry blocked'
              : [...new Set([...governorReasons, existingReasons === '—' ? '' : existingReasons].filter(Boolean))].join(' · ') || '—';
          return <tr key={s.symbol + ':' + s.strategy}>
            <td className="symbol">{s.symbol}</td>
            <td>{s.strategy === 'MOMENTUM' ? 'MOM' : 'SCALP'}</td>
            <td>{s.snapshot_missing ? 'WATCH · NO DATA' : s.stage}</td>
            <td className={s.side === 'BUY' ? 'up' : s.side === 'SELL' ? 'down' : 'muted'}>{s.side || '—'}</td>
            <td><b>{s.snapshot_missing ? '—' : safeNum(s.score) === null ? 'NO DATA' : safeNum(s.score).toFixed(0) + '/100'}</b></td>
            <td>{s.snapshot_missing ? '—' : fmtQty(s.qty_contracts)}</td>
            <td>{s.snapshot_missing ? '—' : money(s.notional)}</td>
            <td>{s.snapshot_missing ? '—' : money(s.risk_usd)}</td>
            <td className={s.snapshot_missing ? 'muted' : ready ? 'up' : 'down'}>{s.snapshot_missing ? '—' : ready ? 'YES' : 'NO'}</td>
            <td className="blocker" title={governorReasons.join('\n') || (Array.isArray(s.gate_results) ? s.gate_results.map(gateTooltip).join('\n') : 'Dashboard readiness requires every Risk Governor gate to PASS.')}>{whyBlocked}</td>
          </tr>;
        })}
        </tbody></table></div>
      </Panel>
    </section>
    <Panel title="Signal Mode"><div className="idle">SCANNER → DELTA EXCHANGE (TESTNET) <span>Direct orders are restricted to Delta India Testnet when TESTNET mode is enabled; production/live Delta orders remain hard-locked.</span></div></Panel>
    <Panel title="Idle Reason"><div className="idle">{idleFromSignals(signals)} <span>Top blocks: {top||'none recorded'}</span></div></Panel>
    <Panel title="Engine Log · last 200 lines">{accountDataProtected?<div className="lockedText">Private engine logs are hidden. Enter ENGINE_SECRET in Settings to view them.</div>:<Log rows={logs||[]}/>}</Panel>
    <div className="micro"><span className={health?.workerLeaseActive?'up':'down'}>Worker {health?.workerLeaseActive?'ONLINE':'OFFLINE'}</span><span>Last tick {settings.last_tick_at?new Date(settings.last_tick_at).toLocaleTimeString('en-IN'):'—'}</span><span>Time drift {health?.timeDriftMs==null?'—':Math.round(health.timeDriftMs)+' ms'}</span><span>Auto {settings.auto_trade?'ON':'OFF'}</span><span>Continuous {settings.continuous_mode?'ON':'OFF'}</span></div>
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

function MarketTable({ market, signals, openPositionSymbols = new Set() }) {
  const visibleMarket = selectVisibleMarketRows(market, DEFAULT_VISIBLE_MARKET_LIMIT);
  const map = new Map();
  for (const signal of Array.isArray(signals) ? signals : []) {
    if (!signal?.symbol) continue;
    if (!map.has(signal.symbol)) map.set(signal.symbol, {});
    map.get(signal.symbol)[signal.strategy] = signal;
  }
  const marketRows = Array.isArray(market) ? market : [];
  return <><div className="marketCount">Showing {visibleMarket.length} of {marketRows.length} instruments · sorted by 24h turnover · full background scanner remains active.</div><div className="tablewrap"><table><thead><tr><th>#</th><th>COIN</th><th>PRICE</th><th>24H %</th><th>TURNOVER</th><th>VOL SPIKE</th><th>MOM</th><th>SCALP</th><th>TREND</th><th>SUPPORT</th><th>RESIST.</th><th>SIGNAL</th><th>POSITION</th></tr></thead><tbody>{visibleMarket.map((marketRow,i) => {
    const x = map.get(marketRow.symbol) || {};
    const best = [x.MOMENTUM,x.SCALPING].filter(Boolean).sort((a,b) => num(b.score)-num(a.score))[0];
    const hasOpenPosition = openPositionSymbols instanceof Set && openPositionSymbols.has(String(marketRow.symbol || '').toUpperCase());
    return <tr key={marketRow.symbol}><td>{i+1}</td><td className="symbol">{marketRow.symbol}</td><td>{price(marketRow.mark_price || marketRow.close)}</td><td className={safeNum(marketRow.ltp_change_24h) === null ? 'muted' : safeNum(marketRow.ltp_change_24h) >= 0 ? 'up' : 'down'}>{pct(marketRow.ltp_change_24h)}</td><td>{money(marketRow.turnover_usd)}</td><td>{fmtMultiplier(best?.volume_spike)}</td><td><span className={x.MOMENTUM?.side==='BUY'?'up':x.MOMENTUM?.side==='SELL'?'down':''}>{x.MOMENTUM ? (safeNum(x.MOMENTUM.score) === null ? 'NO DATA' : safeNum(x.MOMENTUM.score).toFixed(0)) + ' ' + (x.MOMENTUM.side || '') : '—'}</span></td><td><span className={x.SCALPING?.side==='BUY'?'up':x.SCALPING?.side==='SELL'?'down':''}>{x.SCALPING ? (safeNum(x.SCALPING.score) === null ? 'NO DATA' : safeNum(x.SCALPING.score).toFixed(0)) + ' ' + (x.SCALPING.side || '') : '—'}</span></td><td>{best?.trend || '—'} / {best?.confirm_trend || '—'}</td><td>{price(best?.support)}</td><td>{price(best?.resistance)}</td><td><b className={best?.stage==='CONFIRMED'?'up':best?.stage==='SETUP'?'warn':'muted'}>{best?.stage || 'WATCH'}</b></td><td><span className={hasOpenPosition?'warn':'muted'} title={hasOpenPosition?'An open Delta Testnet position exists for this symbol.':'No open Delta Testnet position detected.'}>{hasOpenPosition?'OPEN':'—'}</span></td></tr>;
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
  const normalizedDiagnostic = buildNormalizedScoreDiagnostic(selected);
  const formatScore = value => value === null ? '—' : value.toFixed(2);
  return <Panel title="Risk Governor · Evidence-Based Status">
    <div className="inspectRow"><label>Inspect coin<select value={selected.symbol} onChange={e => onInspect(e.target.value)}>{[...new Set(signals.map(x=>x.symbol))].slice(0,50).map(x => <option key={x}>{x}</option>)}</select></label><span>{selected.strategy} · {selected.side || 'NO SIDE'} · {safeNum(selected.score) === null ? 'NO SCORE DATA' : safeNum(selected.score).toFixed(0) + '/100'}</span></div>
    <div className="lockedText">PASS means the required observation is available and meets the displayed test. UNKNOWN means this view lacks enough evidence; UNKNOWN must not be treated as a pass.</div>
    <div className="gates">{gates.map(gate => <div key={gate.gate}>
      <b className={gate.result === 'PASS' ? 'pass' : gate.result === 'BLOCK' ? 'block' : 'unknown'}>{gate.result}</b>
      <span>{gate.gate}</span>
      <em title={gateTooltip(gate)}>{gateTooltip(gate).replace(gate.gate + ': ', '')}</em>
    </div>)}
      <div>
        <b className={normalizedDiagnostic.status === 'PASS' ? 'pass' : normalizedDiagnostic.status === 'BLOCK' ? 'block' : normalizedDiagnostic.status === 'WARN' ? 'warn' : 'unknown'}>{normalizedDiagnostic.status}</b>
        <span>Normalized Score</span>
        <em title={normalizedDiagnostic.reason}>Original: {formatScore(normalizedDiagnostic.originalScore)} · Normalized: {formatScore(normalizedDiagnostic.normalizedScore)} · {normalizedDiagnostic.reason}</em>
      </div>
    </div>
    <div className="lockedText">Diagnostic only — does not gate live orders.</div>
  </Panel>;
}

function EngineView({ engine, signals, entrySafetyBlocked = false, entrySafetyReason = null, openPositionSymbols = new Set() }) {
  const preferenceKey = showAllPreferenceKey(engine);
  const [showAllSignals, setShowAllSignals] = useState(() => {
    try {
      return readShowAllPreference(window.localStorage, preferenceKey);
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      writeShowAllPreference(window.localStorage, preferenceKey, showAllSignals);
    } catch {
      // Private browsing/storage restrictions must not break the signal table.
    }
  }, [preferenceKey, showAllSignals]);

  const rows = signals
    .filter(x => x.strategy === engine && passesScoreFilter(x, showAllSignals, 80))
    .sort((a, b) => (visibleScoreFrom(b) ?? -Infinity) - (visibleScoreFrom(a) ?? -Infinity));
  return <Panel title={engine + ' · Closed-Candle Signal Engine'}>{entrySafetyBlocked ? <div className="danger">NEW ENTRIES BLOCKED — {entrySafetyReason || 'Delta Testnet position snapshot is not verified'}.</div> : null}<div className="marketCount">Showing {showAllSignals ? 'all signals' : 'signals with normalized score ≥80'}. Rows without a normalized score are excluded unless Show all is enabled. Original score is diagnostic only; hover to compare both.<label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '12px', cursor: 'pointer' }}><input type="checkbox" checked={showAllSignals} onChange={event => setShowAllSignals(event.target.checked)} /> Show all signals</label></div><div className="tablewrap"><table><thead><tr><th>COIN</th><th>STAGE</th><th>SIDE</th><th>SCORE</th><th>RSI</th><th>VOL</th><th>EMA21</th><th>ATR</th><th>SL</th><th>TP1</th><th>TP</th><th>QTY</th><th>RISK</th><th>BLOCKED / GATES</th></tr></thead><tbody>{rows.map(x => {
    const hasGateResults = Array.isArray(x.gate_results);
    const positionOpen = openPositionSymbols.has(String(x.symbol || '').toUpperCase());
    const safetyReason = entrySafetyBlocked ? 'Delta Testnet entry safety blocked: ' + (entrySafetyReason || 'snapshot not verified') : positionOpen ? 'Open position detected; duplicate entry blocked' : '';
    const rowReasons = [hasGateResults ? blockersDisplay(x.gate_results) : fmtReasons(x.blocked_reasons), safetyReason].filter(value => value && value !== '—').join(' · ') || '—';
    const normalizedScore = normalizedScoreFrom(x);
    const shownScore = visibleScoreFrom(x);
    const scoreTooltip = normalizedScoreTooltip(x);
    return <tr key={x.symbol}>
      <td className="symbol">{x.symbol}</td>
      <td>{x.stage || '—'}</td>
      <td className={x.side==='BUY'?'up':x.side==='SELL'?'down':''}>{x.side || '—'}</td>
      <td title={scoreTooltip}><b>{shownScore === null ? 'NO DATA' : shownScore.toFixed(2)}</b>{shownScore === null ? '' : '/100'}</td>
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
  })}{!rows.length ? <tr><td colSpan={14}>{showAllSignals ? 'No signal rows are available for this engine.' : 'No signals have a normalized score or original-score fallback ≥80. Signals without either score cannot pass this filter.'}</td></tr> : null}</tbody></table></div></Panel>;
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

function Positions({ rows = [], accountDataProtected = false }) {
  if(accountDataProtected) return <Panel title="Delta Testnet Positions · Protected"><div className="lockedText">Private Delta Testnet position data is locked. Enter ENGINE_SECRET in Settings. Hidden data is not zero.</div></Panel>;
  const list=Array.isArray(rows)?rows:[];
  return <Panel title="Delta Testnet Positions"><div className="lockedText">Exchange-synced Delta Testnet position ledger. Only rows returned by the Testnet worker are displayed.</div>
    <div className="tablewrap"><table><thead><tr><th>STATUS</th><th>COIN</th><th>STRATEGY</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>MARK</th><th>UNREALIZED P&amp;L</th><th>REALIZED P&amp;L</th><th>SL</th><th>TP</th><th>ORIGIN</th></tr></thead><tbody>
      {list.map((p,i)=><tr key={p.id||p.execution_id||p.symbol+':'+i}><td>{p.status||'UNKNOWN'}</td><td className="symbol">{p.symbol||'—'}</td><td>{p.strategy||'DELTA TESTNET'}</td><td className={p.side==='BUY'?'up':p.side==='SELL'?'down':'muted'}>{p.side||'—'}</td><td>{safeNum(p.qty)===null?'—':fmtQty(p.qty)}</td><td>{p.entry_price==null?'—':price(p.entry_price)}</td><td>{p.current_price==null?'—':price(p.current_price)}</td><td>{p.unrealized_pnl==null?'—':money(p.unrealized_pnl)}</td><td>{p.realized_pnl==null?'—':money(p.realized_pnl)}</td><td>{p.sl_price==null?'—':price(p.sl_price)}</td><td>{p.tp_price==null?'—':price(p.tp_price)}</td><td>{p.origin||'DELTA TESTNET'}</td></tr>)}
      {!list.length?<tr><td colSpan={12}>No Delta Testnet position rows are available.</td></tr>:null}
    </tbody></table></div></Panel>;
}
function HistoryEmptyState({ engine }) {
 return <div className="lockedText"><b>NO VERIFIED CLOSED TRADE RECORDS — {String(engine||'TRADE').toUpperCase()}</b><p>Data source: verified Delta Testnet close records returned by the Testnet worker.</p><p>Status: Waiting for a verified Delta Testnet close record.</p><p className="muted">No estimated or fabricated trades are shown when close history is unavailable.</p></div>;
}
function TradeHistory({ trades = [], title, strategy = undefined, accountDataProtected = false, tradesComplete = false }) {
 if(accountDataProtected) return <Panel title={title}><div className="lockedText">Closed-trade records are private and currently locked. Enter ENGINE_SECRET in Settings to view history.</div></Panel>;
 const engine=String(title||'Trade History').split('·')[0].replace(/history/i,'').trim()||'Trade';
 const list=(Array.isArray(trades)?trades:[]).filter(row=>!strategy||String(row?.strategy||'').toUpperCase()===String(strategy).toUpperCase());
 return <Panel title={title}>{!tradesComplete?<div className="lockedText">Delta Testnet closed-trade history is unavailable or incomplete. Aggregate totals may therefore be incomplete.</div>:null}
 <div className="tablewrap"><table><thead><tr><th>TIME</th><th>COIN</th><th>MODE</th><th>STRATEGY</th><th>SIDE</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>FEES</th><th>GROSS</th><th>NET</th><th>PNL%</th><th>R</th><th>EXIT REASON</th><th>RESULT</th></tr></thead><tbody>
 {list.map(t=><tr key={t.execution_id}><td>{t.closed_at?new Date(t.closed_at).toLocaleString('en-IN'):'—'}</td><td className="symbol">{t.symbol||'—'}</td><td>DELTA TESTNET</td><td>{t.strategy||'—'}</td><td className={t.side==='BUY'?'up':t.side==='SELL'?'down':'muted'}>{t.side||'—'}</td><td>{t.entry_price==null?'—':price(t.entry_price)}</td><td>{t.exit_price==null?'—':price(t.exit_price)}</td><td>{t.qty==null?'—':fmtQty(t.qty)}</td><td>{t.fees==null?'—':money(t.fees)}</td><td>{t.gross_pnl==null?'—':money(t.gross_pnl)}</td><td className={safeNum(t.net_pnl)===null?'muted':safeNum(t.net_pnl)>=0?'up':'down'}>{t.net_pnl==null?'—':money(t.net_pnl)}</td><td>{t.pnl_pct==null?'—':pct(t.pnl_pct)}</td><td>{safeNum(t.r_multiple)===null?'—':safeNum(t.r_multiple).toFixed(2)}</td><td>{t.exit_reason||'—'}</td><td>{t.status === 'CLOSED_EXTERNALLY' ? <span className="badge muted" title="Reconciled against Delta Testnet REST. Exit price, fees, and realized P&L are not inferred.">CLOSED EXTERNALLY · P&amp;L NOT VERIFIED</span> : t.result || '—'}</td></tr>)}
 {!list.length?<tr><td colSpan={15}><HistoryEmptyState engine={engine}/></td></tr>:null}
 </tbody></table></div></Panel>;
}
function PNL({ trades = [], settings = {}, accountDataProtected = false, tradesComplete = false }) {
 if(accountDataProtected) return <Panel title="PNL · Protected"><div className="lockedText">Private Delta Testnet P&amp;L and account values are hidden. Enter ENGINE_SECRET in Settings to inspect them.</div></Panel>;
 const closed=Array.isArray(trades)?trades:[], nets=closed.map(t=>safeNum(t.net_pnl)), feesRaw=closed.map(t=>safeNum(t.fees));
 const netComplete=closed.length>0&&tradesComplete&&nets.every(v=>v!==null), feesComplete=closed.length>0&&tradesComplete&&feesRaw.every(v=>v!==null);
 const net=netComplete?nets.reduce((s,v)=>s+v,0):null, fees=feesComplete?feesRaw.reduce((s,v)=>s+v,0):null;
 return <><section className="cards"><Card label="REALIZED NET (DELTA)" value={!closed.length?'NO DATA':netComplete?money(net):'INCOMPLETE DATA'} sub={!closed.length?'No verified Delta Testnet closed-trade rows are available':!tradesComplete?'Testnet close history is incomplete':netComplete?'Sum of verified Delta Testnet net P&L values':'One or more net P&L values are missing'}/><Card label="FEES (DELTA)" value={feesComplete?money(fees):'UNAVAILABLE'} sub={feesComplete?'Sum of recorded Delta Testnet fees':'Fees require verified Testnet fill records'}/><Card label="DELTA TESTNET EQUITY" value={settings.equity==null?'—':money(settings.equity)} sub="Latest Testnet account snapshot"/><Card label="DELTA TESTNET UNREALIZED" value={settings.unrealized_pnl==null?'—':money(settings.unrealized_pnl)} sub="Latest Testnet account snapshot"/></section>
 {!closed.length?<div className="lockedText">No verified Delta Testnet closed-trade records are available. Missing realized P&amp;L or fees are not assumed to be zero.</div>:null}</>;
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
      <div><strong>⚠️ Profit Rotation requires verified closed trades.</strong> Current setup receives no authenticated fills from Delta Testnet. This ledger will remain empty until:
        <br/>(a) Delta Testnet outbound webhooks are configured, OR
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
 if(accountDataProtected) return <Panel title="Analytics · Protected"><div className="lockedText">Delta Testnet trade analytics are private. Enter ENGINE_SECRET in Settings to view them.</div></Panel>;
 const engines=['MOMENTUM','SCALPING'].map(engine=>{
  const rows=trades.filter(t=>t.strategy===engine), pnl=rows.filter(t=>safeNum(t.net_pnl)!==null), wins=pnl.filter(t=>safeNum(t.net_pnl)>0), losses=pnl.filter(t=>safeNum(t.net_pnl)<0);
  const avgWin=wins.length?wins.reduce((s,t)=>s+safeNum(t.net_pnl),0)/wins.length:null, avgLoss=losses.length?losses.reduce((s,t)=>s+safeNum(t.net_pnl),0)/losses.length:null;
  const rs=rows.map(t=>safeNum(t.r_multiple)), avgR=rows.length&&rs.every(v=>v!==null)?rs.reduce((s,v)=>s+v,0)/rows.length:null;
  const net=tradesComplete&&rows.length&&pnl.length===rows.length?pnl.reduce((s,t)=>s+safeNum(t.net_pnl),0):null;
  return {engine,rows,pnl,wins,avgWin,avgLoss,avgR,net};
 });
 const known=tradesComplete&&trades.length>0&&trades.every(t=>safeNum(t.net_pnl)!==null);
 const sorted=known?[...trades].sort((a,b)=>safeNum(b.net_pnl)-safeNum(a.net_pnl)):[];
 const exTop=known?trades.reduce((s,t)=>s+safeNum(t.net_pnl),0)-sorted.slice(0,5).reduce((s,t)=>s+safeNum(t.net_pnl),0):null;
 const byReason={}; for(const t of trades){const key=t.exit_reason||'UNKNOWN';byReason[key]=(byReason[key]||0)+1;}
 return <><section className="panel"><div className="panelTitle"><h2>Delta Testnet per-engine statistics</h2></div><div className="engineStats">{engines.map(e=><div key={e.engine}><h3>{e.engine}</h3><b>{!e.pnl.length?'NO P&L DATA':(!tradesComplete?'SAMPLE · ':'')+(e.wins.length/e.pnl.length*100).toFixed(1)+'% win rate'}</b><span>{e.rows.length} loaded rows · {e.pnl.length} with P&amp;L · avg win {e.avgWin===null?'—':money(e.avgWin)} · avg loss {e.avgLoss===null?'—':money(e.avgLoss)} · avg R {e.avgR===null?'—':e.avgR.toFixed(2)} · net {e.net===null?'INCOMPLETE DATA':money(e.net)}</span></div>)}</div></section>
 <section className="cards"><Card label="NET EXCLUDING TOP 5 WINNERS" value={exTop===null?(trades.length?'INCOMPLETE DATA':'—'):money(exTop)} sub={tradesComplete?'Available only when every recorded trade has net P&L':'Partial data — loaded records only (history incomplete)'}/><Card label="EXIT REASONS" value={Object.keys(byReason).length} sub={tradesComplete?'Recorded exit reason labels':'Partial data — loaded records only (history incomplete)'}/><Card label="TOTAL DELTA TESTNET TRADES" value={tradesComplete?trades.length:trades.length?'PARTIAL':'—'} sub={tradesComplete?'All stored Delta Testnet closed-trade rows':'Loaded '+trades.length+' of '+(tradeRowCount??'an unknown number')+' stored rows'}/></section>
 {!tradesComplete?<div className="lockedText">Partial data — loaded records only (history incomplete).</div>:null}
 <Panel title="Exits by reason"><div className="chips">{Object.entries(byReason).map(([reason,count])=><span key={reason}>{reason}: {count}</span>)}</div></Panel>
 <Panel title="Equity Curve"><div className="curve">{known?equityPoints(trades).map((p,i)=><span key={i} style={{height:Math.max(4,Math.min(150,70+p.delta))}} title={p.label}></span>):<div className="muted">{trades.length?'Equity curve hidden because P&L values are missing.':'No verified Delta Testnet closed-trade P&L records yet.'}</div>}</div></Panel></>;
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
function Testnet({settings,health,currentOpenPositionCount=null,accountDataProtected=false}) {
 const count=safeNum(currentOpenPositionCount);
 const status=getWorkerStatusDisplay({autoTrade:settings.auto_trade===true,continuousMode:settings.continuous_mode===true,emergencyStop:settings.emergency_stop===true,currentOpenPositions:count,maxOpenPositions:settings.max_open_positions??null});
 const online=health?.workerLeaseActive===true&&health?.heartbeatFresh===true, tone=settings.emergency_stop===true?'critical':status.capReached&&settings.auto_trade===true?'warning':'';
 const ages='Tick: '+formatHealthAge(health?.tickAgeMs)+' · Heartbeat: '+formatHealthAge(health?.heartbeatAgeMs)+' · Lease: '+formatLeaseRemaining(health?.leaseRemainingMs);
 const r=health?.retention||{}, deleted=Number.isSafeInteger(Number(r.rowsDeleted))&&Number(r.rowsDeleted)>=0?Number(r.rowsDeleted):0, days=Number.isSafeInteger(Number(r.configDays))&&Number(r.configDays)>=1?Number(r.configDays):1, fail=Number.isSafeInteger(Number(r.consecutiveFailures))&&Number(r.consecutiveFailures)>=0?Number(r.consecutiveFailures):0;
 const successMs=r.lastSuccess?Date.parse(r.lastSuccess):NaN, success=Number.isFinite(successMs)?new Date(successMs).toLocaleString('en-IN'):'NO DATA';
 return <><section className="cards"><Card label="ENVIRONMENT" value="DELTA TESTNET" sub="Testnet-only execution environment"/><Card label="AUTO TRADE" value={settings.auto_trade===true?'ON':'OFF'} sub={status.autoTradeSubtitle} tone={tone}/><Card label="CONTINUOUS MODE" value={status.continuousValue} sub={status.continuousSubtitle}/><Card label="DELTA OPEN POSITIONS" value={accountDataProtected?'LOCKED':count===null?'NO DATA':count} sub={accountDataProtected?'Unlock Settings to view positions':count===null?'Delta Testnet count unavailable':'Exchange-confirmed Delta Testnet open-position count'}/></section>
 <Panel title="Worker Status · Delta Testnet"><div className="lockedText">Direct order execution is restricted to Delta Exchange Testnet. Production/live Delta orders remain hard-locked.</div><div className="statusLine"><span>Worker {online?'ONLINE':'OFFLINE'}</span>{' · '}<span>Lease {health?.workerLeaseActive?'ACTIVE':'INACTIVE'}</span>{' · '}<span>Heartbeat {health?.heartbeatFresh?'FRESH':'STALE'}</span>{' · '}<span>Tick {health?.tickFresh?'FRESH':'STALE'}</span>{' · '}<span>Worker health {health?.exchangeHealthy?'HEALTHY':'DEGRADED'}</span>{' · '}<span>Emergency stop {settings.emergency_stop===true?'ACTIVE':'RELEASED'}</span></div><div className="healthAges">{ages}</div><div className="healthAges" title={'Last successful run: '+(Number.isFinite(successMs)?success:'NO DATA')+' · consecutive failures: '+fail}>Retention: last run {formatRetentionLastRun(r.lastRun)} · deleted {deleted.toLocaleString('en-IN')} rows · config: {days} day{days===1?'':'s'}</div><p className="muted">Testnet entries require a valid signal, fresh market data, acceptable risk/margin, same-symbol duplicate protection, and global position-cap allowance ({status.hasCapData?status.capLabel+' used':'NO DATA'}). Production/live Delta orders remain hard-locked.</p></Panel></>;
}
function Settings({ settings, currentOpenPositions = null, secret, setSecret, busy, mutate, onUnlock, onLock, authenticated = false }) {
  const capStatus = getGlobalPositionCapDisplay({
    maxOpenPositions: settings.max_open_positions,
    currentOpenPositions,
    trusted: safeNum(currentOpenPositions) !== null
  });
  const serverValues = useMemo(() => ({
    riskPct: settings.risk_pct ?? 1,
    momentumRr: settings.momentum_rr ?? 2.5,
    scalpingRr: settings.scalping_rr ?? 2.5,
    tp1Pct: settings.tp1_pct ?? 33,
    maxHoldMinutes: settings.max_hold_minutes ?? 240
  }), [settings.risk_pct, settings.momentum_rr, settings.scalping_rr, settings.tp1_pct, settings.max_hold_minutes]);
  const [draft, setDraft] = useState(serverValues);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [saveState, setSaveState] = useState('');
  const [showSaveConfirmation, setShowSaveConfirmation] = useState(false);
  const [pendingSettingsPatch, setPendingSettingsPatch] = useState(null);

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
  const saveSettings = event => {
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
    setPendingSettingsPatch(patch);
    setShowSaveConfirmation(true);
  };

  const cancelSaveSettings = () => {
    setShowSaveConfirmation(false);
    setPendingSettingsPatch(null);
  };

  const confirmSaveSettings = async () => {
    const patch = pendingSettingsPatch;
    if (!patch) {
      setShowSaveConfirmation(false);
      return;
    }
    setShowSaveConfirmation(false);
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
    setPendingSettingsPatch(null);
  };

  const statusClass = dirty ? 'pending' : saveState === 'Settings saved to server.' ? 'saved' : '';
  return <><Panel title="Server Controls"><div className="padSettings"><form className="settingsForm" onSubmit={saveSettings}>
    <div className="settings">
      <label>ENGINE_SECRET<input type="password" value={secret} onChange={e=>setSecret(e.target.value)} placeholder={authenticated ? "Session active — enter again only if needed" : "Enter once to unlock private data"} autoComplete="current-password"/><small className="settingHint">The secret is sent once to establish a signed HttpOnly session cookie. It is not kept in localStorage or sessionStorage. The 7-day session renews while the dashboard is actively used and expires after 7 days of inactivity.</small></label>
      <label>Risk % per trade<input type="number" min="0.1" max="5" step="0.1" value={draft.riskPct} onChange={e=>changeDraft('riskPct',e.target.value)} disabled={busy} required/></label>
      <div className={`lockedText capStatus ${capStatus.className}`} role="status" aria-live="polite">
        {capStatus.state === 'ACTIVE' ? <>
          <b>Global position cap: ACTIVE</b>
          <span>Current: {capStatus.currentOpenPositions}/{capStatus.maxOpenPositions}</span>
          <small>Worker enforces at limit. Fails closed if snapshot unavailable.</small>
        </> : capStatus.state === 'REACHED' ? <>
          <b>⚠️ Global position cap: REACHED</b>
          <span>Current: {capStatus.currentOpenPositions}/{capStatus.maxOpenPositions}</span>
          <small>New signals blocked until positions close.</small>
        </> : <>
          <b>⚠️ Global position cap: STATUS UNKNOWN</b>
          <small>Trusted position snapshot unavailable. Worker fails closed — no new entries will be sent.</small>
        </>}
      </div>
      <label>Momentum RR<input type="number" min="1" max="5" step="0.1" value={draft.momentumRr} onChange={e=>changeDraft('momentumRr',e.target.value)} disabled={busy} required/></label>
      <label>Scalping RR<input type="number" min="1" max="5" step="0.1" value={draft.scalpingRr} onChange={e=>changeDraft('scalpingRr',e.target.value)} disabled={busy} required/></label>
      <label>TP1 %<input type="number" min="1" max="99" step="1" value={draft.tp1Pct} onChange={e=>changeDraft('tp1Pct',e.target.value)} disabled={busy} required/></label>
      <label>Max hold minutes<input type="number" min="1" max="1440" step="1" value={draft.maxHoldMinutes} onChange={e=>changeDraft('maxHoldMinutes',e.target.value)} disabled={busy} required/></label>
    </div>
    <div className="settingsActions">
      <span className={`saveStatus ${statusClass}`} aria-live="polite">{saveState || 'Save the current values to the server. Changes are kept only after a successful save.'}</span>
      <div className="settingsButtons"><button className="action" type="button" onClick={onUnlock} disabled={busy || !secret}>{authenticated ? 'Refresh Session' : 'Unlock Private Data'}</button>{authenticated ? <button className="action" type="button" onClick={onLock} disabled={busy}>Lock Session</button> : null}<button className="action" type="button" onClick={discardChanges} disabled={busy || !dirty}>Discard</button><button className="saveSettings" type="submit" disabled={busy} title="Persist these settings to the server">{busy ? 'Saving…' : 'Save Settings'}</button></div>
    </div>
  </form></div></Panel><Panel title="Strategy / Safety Defaults"><div className="ruleGrid"><span>Momentum: EMA9/21/50 + RSI BUY 45–80 / SELL 20–55 + adaptive volume gate + ATR stop ≥0.95%</span><span>Scalping: 1m EMA entry + 5m/15m trend + RSI + VWAP + adaptive volume gate + stop ≥0.75%</span><span>Confirmed score: ≥80 (hard floor)</span><span>Volume qualification: momentum default 0.75x with controlled sparse-volume fallback; scalping default 1.25x</span><span>Entry candle-range gate: Momentum ≤4.00x ATR; Scalping ≤3.00x ATR</span><span>Price-to-EMA21 distance: Momentum ≤3.50x ATR; Scalping ≤2.50x ATR</span><span>BTC regime: FLAT/mixed is neutral; only fully opposing BTC 5m+15m blocks; extreme opposing regimes can use the strong-local override</span><span>Fee + spread budget: 20% of 1R Momentum / 25% Scalping</span><span>Risk sizing: configurable per-trade equity risk (database default 1%), whole contracts, max 3x configurable notional cap</span><span>BTC override still respects spread, cost, stop, margin and duplicate-symbol prevention; scanner daily loss / trade-count quotas are disabled</span><span>Exits: Verify Delta Testnet exit orders and close events in the Delta Testnet Positions tab. Missing close prices or fees are not estimated.</span><span>⚠️ Trailing stop: Do not assume trailing protection unless it is confirmed by the Delta Testnet execution configuration.</span></div></Panel><p className="settingHint strategyAccuracyNote">ℹ️ These defaults describe scanner signal logic. Confirm active order protections and exit handling in the Delta Testnet execution view.</p><Panel title="Environment Lock"><div className="liveLock">DELTA TESTNET ONLY. Production/live Delta order APIs remain hard-locked.</div></Panel>
    {showSaveConfirmation ? <div className="confirmOverlay">
      <div className="confirmDialog" role="dialog" aria-modal="true" aria-labelledby="saveConfirmTitle">
        <h3 id="saveConfirmTitle">Save settings to server?</h3>
        <p>Changes to risk %, RR, TP1%, max hold, and other settings will take effect on the next scan cycle.</p>
        <div className="confirmActions">
          <button className="action" type="button" onClick={cancelSaveSettings} disabled={busy}>Cancel</button>
          <button className="saveSettings" type="button" onClick={confirmSaveSettings} disabled={busy}>Save</button>
        </div>
      </div>
    </div> : null}</>;
}
function Log({rows=[]}) {
 return <div className="log">{rows.length?rows.map(row=><div key={row.id}><small>{new Date(row.created_at).toLocaleTimeString()}</small><b>{row.level}</b><div className="logBody"><span>{row.message}</span></div></div>):<div className="muted">The dashboard includes the last 200 engine logs when the database is connected.</div>}</div>;
}

createRoot(document.getElementById('root')).render(<AppErrorBoundary><App /></AppErrorBoundary>);