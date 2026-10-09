import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const tabs = [
  ['dashboard','Dashboard'],['rotation','Profit Rotation'],['momentum','Momentum'],['momentum-history','Mom History'],
  ['scalping','Scalping'],['scalp-history','Scalp History'],['options','Options'],['positions','Positions'],['trade-history','Trade History'],
  ['pnl','PNL'],['paper','Paper Trading'],['testnet','Legacy Demo OFF'],['live','Live Trading'],['analytics','Analytics'],['settings','Settings']
];
const num = v => Number.isFinite(+v) ? +v : 0;
const pct = v => (num(v) >= 0 ? '+' : '') + num(v).toFixed(2) + '%';
const money = v => '₹' + num(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [inspect, setInspect] = useState('');

  const load = async () => {
    try {
      const cacheBust = '?t=' + Date.now();
      const results = await Promise.all([
        fetch('/api/market' + cacheBust, { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/health' + cacheBust, { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/engine/state' + cacheBust, { cache: 'no-store' }).then(r => r.json())
      ]);
      if (!results[0].success) throw new Error(results[0].error || 'Market unavailable');
      setMarket(results[0].result || []);
      setHealth(results[1]);
      if (results[2].success) setState(results[2]); else throw new Error(results[2].error || 'Engine state unavailable');
      setError('');
    } catch (e) { setError(e.message || 'Dashboard data unavailable'); }
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
    if (!secret) { setTab('settings'); setError('ENGINE_SECRET is required for control actions.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/engine/toggle', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-engine-secret': secret },
        body: JSON.stringify(patch)
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Control failed');
      await load();
    } catch (e) { setError(e.message || 'Control failed'); }
    finally { setBusy(false); }
  };

  const selected = useMemo(() => {
    const chosen = inspect || signals[0]?.symbol || '';
    const candidates = signals.filter(x => x.symbol === chosen);
    return candidates.find(x => x.strategy === 'MOMENTUM') || candidates[0] || null;
  }, [inspect, signals]);

  const selectedScalp = selected ? signals.find(x => x.symbol === selected.symbol && x.strategy === 'SCALPING') : null;
  const stale = !health?.tickFresh;
  return <div className="terminal">
    <header className="topbar">
      <div>
        <div className="brand">D <span>DEALDOST</span></div>
        <div className="sub">DELTA INDIA · PERPETUAL FUTURES COMMAND CENTER</div>
      </div>
      <div className="headerRight">
        <span>BUILD v2.0.20261009.02</span>
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
    {error ? <div className="error">{error}</div> : null}
    <nav>{tabs.map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'live' ? ' 🔒' : ''}</button>)}</nav>

    {tab === 'dashboard' && <Dashboard market={market} settings={settings} health={health} trades={trades} positions={positions} signals={signals} signalOrders={state?.signalOrders || []} tradetronEvents={state?.tradetronEvents || []} executionCoverage={state?.executionCoverage || null} onInspect={setInspect} inspect={selected} logs={state?.logs || []} />}
    {tab === 'rotation' && <Rotation ledger={state?.ledger || []} />}
    {tab === 'momentum' && <EngineView engine="MOMENTUM" signals={signals} />}
    {tab === 'momentum-history' && <TradeHistory trades={trades.filter(t => t.strategy === 'MOMENTUM')} title="Momentum History" />}
    {tab === 'scalping' && <EngineView engine="SCALPING" signals={signals} />}
    {tab === 'options' && <OptionsView signals={signals} settings={settings} optionCache={state?.optionCache || []} />}
    {tab === 'scalp-history' && <TradeHistory trades={trades.filter(t => t.strategy === 'SCALPING')} title="Scalping History" />}
    {tab === 'positions' && <Positions rows={positions} />}
    {tab === 'trade-history' && <TradeHistory trades={trades} title="Trade History · Real Fills Only" />}
    {tab === 'pnl' && <PNL trades={trades} settings={settings} />}
    {tab === 'paper' && <Panel title="Paper Trading"><div className="lockedText">Scanner is signal-only. No Delta order is placed here; Tradetron Live Offline runs the simulated execution.</div></Panel>}
    {tab === 'testnet' && <Testnet settings={settings} health={health} busy={busy} mutate={mutate} positions={positions} />}
    {tab === 'live' && <Panel title="Live Trading"><div className="liveLock">🔒 DIRECT DELTA EXECUTION LOCKED<br/><small>The scanner never sends production orders. Future live execution must be enabled manually in Tradetron.</small></div></Panel>}
    {tab === 'analytics' && <Analytics trades={trades} />}
    {tab === 'settings' && <Settings settings={settings} secret={secret} setSecret={v => { setSecret(v); sessionStorage.setItem('delta-engine-secret', v); }} busy={busy} mutate={mutate} />}
    <footer>Delta Exchange India · production market feed · Tradetron signal-only · no direct orders · no guaranteed win rate</footer>
  </div>;
}

function Panel({ title, children }) {
  return <section className="panel"><div className="panelTitle"><h2>{title}</h2></div><div className="pad">{children}</div></section>;
}
function Card({ label, value, sub }) {
  return <div className="card"><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>;
}
function Dashboard({ market, settings, health, trades, positions, signals, signalOrders = [], tradetronEvents = [], executionCoverage = null, onInspect, inspect, logs }) {
  const today = new Date().toISOString().slice(0,10);
  const todayTrades = trades.filter(t => String(t.closed_at || '').slice(0,10) === today);
  const wins = todayTrades.filter(t => num(t.net_pnl) > 0).length;
  const loss = todayTrades.filter(t => num(t.net_pnl) < 0).length;
  const reasons = {};
  for (const s of signals) for (const r of (String(s.blocked_reasons || '').split(' · ').filter(Boolean))) reasons[r] = (reasons[r] || 0) + 1;
  const top = Object.entries(reasons).sort((a,b) => b[1]-a[1]).slice(0,3).map(x => x[0] + ' (' + x[1] + ')').join(', ');
  return <>
    <section className="cards">
      <Card label="EQUITY" value={money(settings.equity)} sub="Tradetron signal-only capital"/>
      <Card label="AVAILABLE" value={money(settings.available_balance)} sub="signal sizing reference"/>
      <Card label="REALIZED PNL" value={money(settings.realized_pnl)} sub="closed trades after fees"/>
      <Card label="UNREALIZED PNL" value={money(settings.unrealized_pnl)} sub="open positions"/>
      <Card label="TOTAL PNL" value={money(num(settings.realized_pnl)+num(settings.unrealized_pnl))} sub="realized + unrealized"/>
      <Card label="FEES TODAY" value={money(settings.fees_today)} sub="real fill commissions"/>
      <Card label="OPEN POSITIONS" value={positions.length} sub="Tradetron positions synced by webhook"/>
      <Card label="TT SIGNALS" value={signalOrders.length} sub="scanner → Tradetron API accepted"/>
      <Card label="TT EVENTS" value={tradetronEvents.length} sub="Tradetron activity received"/>
      <Card label="TODAY" value={todayTrades.length} sub={wins + ' wins / ' + loss + ' losses · ' + (todayTrades.length ? (wins/todayTrades.length*100).toFixed(1) : '0.0') + '% WR'}/>
    </section>
    <Panel title={'Full Delta Market Scanner · ' + (market?.length || 0) + ' live perpetuals · Signal Only'}>
      <MarketTable market={market} signals={signals}/>
    </Panel>
    <Panel title="Tradetron Execution Coverage">
      <section className="cards">
        <Card label="LIVE FUTURES SCANNED" value={market?.length || 0} sub="Delta India perpetual tickers" />
        <Card label="FUTURES SYMBOLS ROUTED" value={executionCoverage ? (executionCoverage.routedFuturesSymbols + ' / ' + (market?.length || 0)) : '—'} sub={(executionCoverage?.configuredFuturesRoutes ?? 0) + ' configured futures bridge(s)'} />
        <Card label="OPTIONS UNDERLYINGS" value="BTC · ETH · GOLD" sub="Gold contract symbol: XAUT" />
        <Card label="OPTIONS EXECUTION" value={executionCoverage?.optionsRouteConfigured ? 'CONFIGURED' : 'LOCKED'} sub={executionCoverage?.optionsRouteConfigured ? 'Dedicated options route detected; still validate in Live Offline' : 'Dedicated Tradetron Options bridge + token required'} />
      </section>
    </Panel>
    <section className="grid2">
      <RiskGovernor signals={signals} health={health} positions={positions} onInspect={onInspect} inspect={inspect}/>
      <Panel title="Signal Stages · WATCH → SETUP → CONFIRMED"><div className="tablewrap"><table><thead><tr><th>COIN</th><th>ENG</th><th>STAGE</th><th>SIDE</th><th>SCORE</th><th>QTY</th><th>NOTIONAL</th><th>RISK</th><th>READY</th><th>WHY BLOCKED</th></tr></thead><tbody>{signals.map(s => <tr key={s.symbol + s.strategy}><td className="symbol">{s.symbol}</td><td>{s.strategy === 'MOMENTUM' ? 'MOM' : 'SCALP'}</td><td>{s.stage}</td><td className={s.side === 'BUY' ? 'up' : s.side === 'SELL' ? 'down' : 'muted'}>{s.side || '—'}</td><td><b>{num(s.score).toFixed(0)}</b>/100</td><td>{fmtQty(s.qty_contracts)}</td><td>{money(s.notional)}</td><td>{money(s.risk_usd)}</td><td className={s.ready ? 'up' : 'down'}>{s.ready ? 'YES' : 'NO'}</td><td className="muted">{fmtReasons(s.blocked_reasons)}</td></tr>)}</tbody></table></div></Panel>
    </section>
    <Panel title="Signal Mode"><div className="idle">SCANNER → TRADETRON → LIVE OFFLINE <span>No orders are sent by the scanner. Tradetron owns Live Offline execution and position management.</span></div></Panel>
    <TradetronActivity events={tradetronEvents} signals={signalOrders} />
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

function MarketTable({ market, signals }) {
  const map = new Map();
  for (const s of signals || []) {
    if (!map.has(s.symbol)) map.set(s.symbol, {});
    map.get(s.symbol)[s.strategy] = s;
  }
  return <div className="tablewrap"><table><thead><tr><th>#</th><th>COIN</th><th>PRICE</th><th>24H %</th><th>TURNOVER</th><th>VOL SPIKE</th><th>MOM</th><th>SCALP</th><th>TREND</th><th>SUPPORT</th><th>RESIST.</th><th>SIGNAL</th><th>TRADE</th></tr></thead><tbody>{market.map((m,i) => {
    const x = map.get(m.symbol) || {};
    const best = [x.MOMENTUM,x.SCALPING].filter(Boolean).sort((a,b) => num(b.score)-num(a.score))[0];
    return <tr key={m.symbol}><td>{i+1}</td><td className="symbol">{m.symbol}</td><td>{price(m.mark_price || m.close)}</td><td className={num(m.ltp_change_24h)>=0?'up':'down'}>{pct(m.ltp_change_24h)}</td><td>{money(m.turnover_usd)}</td><td>{best ? num(best.volume_spike).toFixed(2) + 'x' : '—'}</td><td><span className={x.MOMENTUM?.side==='BUY'?'up':x.MOMENTUM?.side==='SELL'?'down':''}>{x.MOMENTUM ? num(x.MOMENTUM.score).toFixed(0) + ' ' + (x.MOMENTUM.side || '') : '—'}</span></td><td><span className={x.SCALPING?.side==='BUY'?'up':x.SCALPING?.side==='SELL'?'down':''}>{x.SCALPING ? num(x.SCALPING.score).toFixed(0) + ' ' + (x.SCALPING.side || '') : '—'}</span></td><td>{best?.trend || '—'} / {best?.confirm_trend || '—'}</td><td>{price(best?.support)}</td><td>{price(best?.resistance)}</td><td><b className={best?.stage==='CONFIRMED'?'up':best?.stage==='SETUP'?'warn':'muted'}>{best?.stage || 'WATCH'}</b></td><td><button className="tiny" disabled title="Browser never places orders">WORKER</button></td></tr>;
  })}</tbody></table></div>;
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

function OptionsView({ signals, settings, optionCache = [] }) {
  const rows = (optionCache.length ? optionCache : signals.filter(x => x.strategy === 'OPTIONS_BUY' || x.strategy === 'OPTIONS_SELL'))
    .sort((a,b) => num(b.score) - num(a.score));
  const buys = rows.filter(x => x.strategy === 'OPTIONS_BUY');
  const sells = rows.filter(x => x.strategy === 'OPTIONS_SELL');
  return <>
    <section className="cards">
      <Card label="OPTIONS ENGINE" value={settings.options_enabled === false ? 'OFF' : 'ON'} sub="BTC / ETH / GOLD (XAUT) only"/>
      <Card label="BUY" value={settings.options_buy_enabled === false ? 'OFF' : 'ON'} sub="ATM / near-ITM · Δ 0.45–0.65"/>
      <Card label="SELL" value={settings.options_sell_enabled === false ? 'OFF' : 'ON'} sub="defined-risk spread only"/>
      <Card label="EXECUTION" value="TRADETRON" sub="signal-only · Live Offline"/>
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

function Positions({ rows }) {
  return <Panel title="Positions · Tradetron + Engine Origin"><div className="tablewrap"><table><thead><tr><th>TIME</th><th>COIN</th><th>STRATEGY</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>MARK</th><th>SL</th><th>TP1</th><th>TP</th><th>PROTECTION</th><th>ORIGIN</th></tr></thead><tbody>{rows.map(p => <tr key={p.execution_id}><td>{new Date(p.opened_at).toLocaleTimeString('en-IN')}</td><td className="symbol">{p.symbol}</td><td>{p.strategy}</td><td className={p.side==='BUY'?'up':'down'}>{p.side}</td><td>{fmtQty(p.qty)}</td><td>{price(p.entry_price)}</td><td>{price(p.current_price)}</td><td>{price(p.stop_price)}</td><td>{price(p.tp1_price)}</td><td>{price(p.tp_price)}</td><td className={p.protection_verified || p.origin==='TRADETRON'?'up':'down'}>{p.origin==='TRADETRON'?'Tradetron-managed':(p.protection_verified?'VERIFIED':'UNPROTECTED')}</td><td>{p.origin || 'ENGINE'}</td></tr>)}</tbody></table></div></Panel>;
}
function TradeHistory({ trades, title }) {
  return <Panel title={title}><div className="tablewrap"><table><thead><tr><th>TIME</th><th>COIN</th><th>MODE</th><th>STRATEGY</th><th>SIDE</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>FEES</th><th>GROSS</th><th>NET</th><th>PNL%</th><th>R</th><th>EXIT REASON</th><th>RESULT</th></tr></thead><tbody>{trades.map(t => <tr key={t.execution_id}><td>{t.closed_at ? new Date(t.closed_at).toLocaleString('en-IN') : '—'}</td><td className="symbol">{t.symbol}</td><td>TRADetron OFFLINE</td><td>{t.strategy}</td><td className={t.side==='BUY'?'up':'down'}>{t.side}</td><td>{price(t.entry_price)}</td><td>{price(t.exit_price)}</td><td>{fmtQty(t.qty)}</td><td>{money(t.fees)}</td><td>{money(t.gross_pnl)}</td><td className={num(t.net_pnl)>=0?'up':'down'}>{money(t.net_pnl)}</td><td>{pct(t.pnl_pct)}</td><td>{num(t.r_multiple).toFixed(2)}</td><td>{t.exit_reason || '—'}</td><td>{t.result}</td></tr>)}</tbody></table></div></Panel>;
}
function PNL({ trades, settings }) {
  const net = trades.reduce((s,t)=>s+num(t.net_pnl),0);
  const fees = trades.reduce((s,t)=>s+num(t.fees),0);
  return <section className="cards"><Card label="REALIZED NET" value={money(net)} sub="all real closed trades"/><Card label="FEES" value={money(fees)} sub="real fill commissions"/><Card label="EQUITY" value={money(settings.equity)} sub="current Demo equity"/><Card label="UNREALIZED" value={money(settings.unrealized_pnl)} sub="Tradetron activity feed"/></section>;
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
  return <><section className="cards"><Card label="ENVIRONMENT" value="SIGNAL ONLY" sub="production market feed"/><Card label="AUTO" value="BRIDGE ON" sub="Tradetron signal route"/><Card label="CONTINUOUS MODE" value="NO POSITION CAP" sub="scanner opportunity routing"/><Card label="OPEN POSITIONS" value={positions.length} sub={'max '+(settings.max_open_positions||2)}/></section><Panel title="Testnet Controls"><div className="lockedText">Direct Delta execution is disabled. Tradetron Live Offline is the only execution/simulation layer.</div><div className="statusLine">Worker {health?.workerLeaseActive?'ONLINE':'OFFLINE'} · Tick {health?.tickFresh?'FRESH':'STALE'} · Exchange {health?.exchangeHealthy?'HEALTHY':'DOWN'}</div><p className="muted">Signal-only mode ignores legacy Delta position caps. A rolling rate guard limits accepted Tradetron bridge entries to 2 per 5 minutes, while per-symbol/candle idempotency prevents duplicates.</p></Panel></>;
}
function Settings({ settings, secret, setSecret, busy, mutate }) {
  return <><Panel title="Server Controls"><div className="settings"><label>ENGINE_SECRET<input type="password" value={secret} onChange={e=>setSecret(e.target.value)} placeholder="Stored in this browser session only"/></label><label>Risk % per trade<input type="number" step="0.1" value={settings.risk_pct ?? 0.3} onChange={e=>mutate({riskPct:Number(e.target.value)})} disabled={busy}/></label><label>Max open positions<input type="number" value={settings.max_open_positions ?? 20} onChange={e=>mutate({maxOpenPositions:Number(e.target.value)})} disabled={busy}/></label><label>Momentum RR<input type="number" step="0.1" value={settings.momentum_rr ?? 2.0} onChange={e=>mutate({momentumRr:Number(e.target.value)})} disabled={busy}/></label><label>Scalping RR<input type="number" step="0.1" value={settings.scalping_rr ?? 2.0} onChange={e=>mutate({scalpingRr:Number(e.target.value)})} disabled={busy}/></label><label>TP1 %<input type="number" value={settings.tp1_pct ?? 33} onChange={e=>mutate({tp1Pct:Number(e.target.value)})} disabled={busy}/></label><label>Max hold minutes<input type="number" value={settings.max_hold_minutes ?? 240} onChange={e=>mutate({maxHoldMinutes:Number(e.target.value)})} disabled={busy}/></label></div></Panel><Panel title="Strategy / Safety Defaults"><div className="ruleGrid"><span>Momentum: EMA9/21/50 + RSI 54–68 / 32–46 + volume ≥1.6x + ATR stop ≥0.95%</span><span>Scalping: 1m/5m EMA + RSI + VWAP + stop ≥0.75%</span><span>Confirmed score: ≥70</span><span>Volume impulse: ≥0.75x on entry timeframe or 5m context; high-score sparse-feed fallback at local score ≥85</span><span>5m candle range: ≤3.00x ATR</span><span>EMA21 distance: ≤2.50x ATR</span><span>BTC regime: FLAT/mixed is neutral; only fully opposing BTC 5m+15m blocks; extreme opposing regimes can use the strong-local override</span><span>Fee + spread budget: 20% of 1R Momentum / 25% Scalping</span><span>Risk sizing: 0.30% equity, whole contracts, max 3x configurable notional cap</span><span>BTC override still respects spread, cost, stop, margin, position cap and daily 1% hard loss</span><span>Exits: TP1 33% at 1R, BE+fees, trail 1R, final TP default 2.5R</span></div></Panel><Panel title="Environment Lock"><div className="liveLock">PRODUCTION MARKET · SIGNAL ONLY. The scanner reads Delta India production market data and sends signals only; direct Delta order APIs are hard-locked.</div></Panel></>;
}
function TradetronActivity({ events, signals }) {
  const rows = (events || []).slice(0, 30);
  const webhookUrl = typeof window !== 'undefined'
    ? window.location.origin + '/api/tradetron/webhook'
    : '/api/tradetron/webhook';
  return <Panel title="Tradetron Offline Activity · actual events received">
    <div className="lockedText"><b>Outbound webhook:</b> <span className="mono">{webhookUrl}</span><br/><small>Tradetron → scanner: send fill/position/error activity here. Fill/position events now materialize Tradetron-owned open positions in DeltaScanner.</small></div>
    {rows.length ? <div className="tablewrap"><table><thead><tr><th>TIME</th><th>EVENT</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>PNL</th><th>STATUS</th><th>EXECUTION</th></tr></thead><tbody>{rows.map(e => <tr key={e.event_id}><td>{e.event_at ? new Date(e.event_at).toLocaleTimeString('en-IN') : new Date(e.created_at).toLocaleTimeString('en-IN')}</td><td>{e.event_type || 'UNKNOWN'}</td><td className="symbol">{e.symbol || '—'}</td><td className={e.side==='BUY'?'up':e.side==='SELL'?'down':''}>{e.side || '—'}</td><td>{fmtQty(e.qty)}</td><td>{price(e.price)}</td><td className={num(e.pnl)>=0?'up':'down'}>{e.pnl == null ? '—' : money(e.pnl)}</td><td>{e.status || '—'}</td><td className="mono">{e.execution_id || '—'}</td></tr>)}</tbody></table></div>
    : <div className="lockedText">No Tradetron outbound activity has reached the scanner yet. Scanner signals are accepted separately; once Tradetron posts activity/fills/errors to the webhook above, they will appear here.</div>}
    <div className="micro"><span>Signals sent: {signals?.length || 0}</span><span>Tradetron events: {events?.length || 0}</span><span>Webhook: READY</span><span>Live Offline: ACTIVE on Tradetron</span></div>
  </Panel>;
}
function Log({ rows }) {
  return <div className="log">{rows.length ? rows.map(x=><div key={x.id}><small>{new Date(x.created_at).toLocaleTimeString()}</small><b>{x.level}</b><span>{x.message}</span></div>) : <div className="muted">Open Dashboard state includes the last 200 engine logs when the database is connected.</div>}</div>;
}

createRoot(document.getElementById('root')).render(<App/>);