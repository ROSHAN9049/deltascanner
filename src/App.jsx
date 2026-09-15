import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const API = 'https://api.india.delta.exchange/v2';
const WS = 'wss://public-socket.india.delta.exchange';
const TELEGRAM_COOLDOWN = 15 * 60 * 1000;
const MAX_PAPER_SPREADS = 4;
const OPTION_REFRESH_MS = 5000;
const ENTRY_COOLDOWN_MS = 15 * 60 * 1000;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function optionMeta(x) {
  const symbol = String(x.symbol || x.product_symbol || '');
  const m = symbol.match(/^([CP])-(BTC|ETH)-([0-9.]+)-([0-9]{6})/i);
  const type = String(x.contract_type || '').toLowerCase();
  const side = type === 'put_options' || symbol.startsWith('P-') ? 'PUT' : 'CALL';
  const underlying = String(x.underlying_asset_symbol || x.underlying || (m?.[2] || '')).toUpperCase();
  const strike = num(x.strike_price ?? x.strike ?? m?.[3]);
  const expiry = String(x.expiry_date || x.expiry || x.settlement_time || m?.[4] || '');
  const delta = num(x.greeks?.delta ?? x.delta, NaN);
  const mark = num(x.mark_price ?? x.close ?? x.last_price ?? x.ltp, NaN);
  return { ...x, symbol, side, underlying, strike, expiry, delta, mark };
}

function pickSpread(chain, direction) {
  const clean = chain.map(optionMeta).filter(o => o.mark > 0 && o.strike > 0 && (o.side === 'PUT' || o.side === 'CALL'));
  if (!clean.length) return null;
  const groups = [...new Set(clean.map(o => o.expiry))].filter(Boolean);
  const expiry = groups.sort()[0];
  const same = clean.filter(o => o.expiry === expiry);
  const wantedSide = direction === 'PUMP' ? 'PUT' : 'CALL';
  const candidates = same.filter(o => o.side === wantedSide);
  if (candidates.length < 2) return null;

  const hasDelta = candidates.some(o => Number.isFinite(o.delta));
  let shortLeg;
  if (hasDelta) {
    const target = direction === 'PUMP' ? -0.25 : 0.25;
    shortLeg = [...candidates].sort((a, b) => Math.abs(a.delta - target) - Math.abs(b.delta - target))[0];
  } else {
    const atm = [...candidates].sort((a, b) => Math.abs(a.strike - (a.underlying_price || a.spot_price || 0)) - Math.abs(b.strike - (b.underlying_price || b.spot_price || 0)))[0];
    shortLeg = atm || candidates[Math.floor(candidates.length / 2)];
  }

  const hedgeCandidates = candidates.filter(o => direction === 'PUMP' ? o.strike < shortLeg.strike : o.strike > shortLeg.strike);
  if (!hedgeCandidates.length) return null;
  const hedge = hasDelta
    ? [...hedgeCandidates].sort((a, b) => Math.abs(Math.abs(a.delta) - 0.10) - Math.abs(Math.abs(b.delta) - 0.10))[0]
    : [...hedgeCandidates].sort((a, b) => Math.abs(a.strike - shortLeg.strike) - Math.abs(b.strike - shortLeg.strike))[0];
  if (!hedge || hedge.symbol === shortLeg.symbol) return null;

  return { shortLeg, hedge, expiry };
}

function spreadPnl(position, optionMap) {
  const shortNow = num(optionMap[position.short.symbol]?.mark, position.short.entry);
  const hedgeNow = num(optionMap[position.hedge.symbol]?.mark, position.hedge.entry);
  const shortPnl = position.short.entry - shortNow;
  const hedgePnl = hedgeNow - position.hedge.entry;
  const multiplier = num(position.multiplier, 1);
  return {
    shortNow,
    hedgeNow,
    shortPnl: shortPnl * multiplier,
    hedgePnl: hedgePnl * multiplier,
    total: (shortPnl + hedgePnl) * multiplier,
  };
}

function App() {
  const [tickers, setTickers] = useState([]);
  const [status, setStatus] = useState('CONNECTING');
  const [last, setLast] = useState(null);
  const [candleMap, setCandleMap] = useState({});
  const [optionMap, setOptionMap] = useState({});
  const [paperSpreads, setPaperSpreads] = useState([]);
  const [paperEnabled, setPaperEnabled] = useState(true);
  const [threshold, setThreshold] = useState(70);
  const history = useRef({});
  const alertState = useRef({});
  const entryCooldown = useRef({});
  const [telegram, setTelegram] = useState(() => localStorage.getItem('deltaTelegram') === '1');

  const loadTickers = async () => {
    try {
      const r = await fetch(`${API}/tickers?contract_types=perpetual_futures`);
      const d = await r.json();
      if (d.result) {
        setTickers(d.result);
        setLast(new Date());
        setStatus('LIVE');
      }
    } catch {
      setStatus('POLLING');
    }
  };

  const loadOptions = async () => {
    try {
      const results = await Promise.all(['BTC', 'ETH'].map(async asset => {
        const r = await fetch(`${API}/tickers?contract_types=call_options,put_options&underlying_asset_symbols=${asset}`);
        const d = await r.json();
        return d.result || [];
      }));
      const next = {};
      results.flat().forEach(raw => {
        const o = optionMeta(raw);
        if (o.symbol && o.mark > 0) next[o.symbol] = o;
      });
      setOptionMap(next);
    } catch {
      // Keep the last valid option marks so paper P&L does not disappear on a transient API error.
    }
  };

  useEffect(() => {
    let ws;
    let alive = true;
    loadTickers();
    loadOptions();
    const poll = setInterval(loadTickers, 5000);
    const optionPoll = setInterval(loadOptions, OPTION_REFRESH_MS);
    try {
      ws = new WebSocket(WS);
      ws.onopen = () => {
        setStatus('LIVE');
        ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [
          { name: 'ticker', symbols: ['perpetual_futures'] },
          { name: 'candlestick_5m', symbols: ['perpetual_futures'] },
          { name: 'candlestick_15m', symbols: ['perpetual_futures'] },
        ] } }));
      };
      ws.onmessage = e => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === 'ticker' && d.sy) {
            setTickers(x => {
              const m = new Map(x.map(a => [a.symbol, a]));
              const old = m.get(d.sy) || {};
              m.set(d.sy, { ...old, symbol: d.sy, close: d.c ?? old.close, ltp_change_24h: d.ltp_change_24h ?? old.ltp_change_24h, turnover_usd: d.turnover_usd ?? old.turnover_usd });
              return [...m.values()];
            });
            setLast(new Date());
          }
          if ((d.type === 'candlestick_5m' || d.type === 'candlestick_15m') && d.sy) {
            const res = d.type.includes('15m') ? '15m' : '5m';
            const candle = { open: num(d.o), close: num(d.c), high: num(d.h), low: num(d.l), volume: num(d.v), ts: d.ts };
            setCandleMap(x => ({ ...x, [`${res}:${d.sy}`]: candle }));
            const k = `${res}:${d.sy}`;
            const arr = history.current[k] || [];
            history.current[k] = [...arr, candle].slice(-25);
          }
        } catch { /* ignore malformed public messages */ }
      };
      ws.onerror = () => setStatus('POLLING');
      ws.onclose = () => alive && setStatus('RECONNECTING');
    } catch {
      setStatus('POLLING');
    }
    return () => { alive = false; clearInterval(poll); clearInterval(optionPoll); ws?.close(); };
  }, []);

  const rows = useMemo(() => tickers
    .filter(x => x.symbol && x.contract_type === 'perpetual_futures')
    .map(x => {
      const ch = num(x.ltp_change_24h);
      const vol = num(x.turnover_usd);
      const c5 = candleMap[`5m:${x.symbol}`];
      const c15 = candleMap[`15m:${x.symbol}`];
      const trend5 = c5 ? (c5.close > c5.open ? 'BULL' : c5.close < c5.open ? 'BEAR' : 'FLAT') : 'WAIT';
      const trend15 = c15 ? (c15.close > c15.open ? 'BULL' : c15.close < c15.open ? 'BEAR' : 'FLAT') : 'WAIT';
      const h5 = history.current[`5m:${x.symbol}`] || [];
      const prev = h5.slice(0, -1).map(a => a.volume).filter(v => v > 0);
      const avg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;
      const spike = avg > 0 ? Number((num(c5?.volume) / avg).toFixed(1)) : 0;
      const momentum = Math.min(30, Math.round(Math.abs(ch) * 5));
      const volumeScore = Math.min(30, Math.round(Math.max(0, spike - 1) * 10));
      const t5 = ((trend5 === 'BULL' && ch > 0) || (trend5 === 'BEAR' && ch < 0)) ? 20 : trend5 === 'FLAT' ? 8 : 0;
      const t15 = ((trend15 === 'BULL' && ch > 0) || (trend15 === 'BEAR' && ch < 0)) ? 20 : trend15 === 'FLAT' ? 8 : 0;
      const score = Math.min(100, momentum + volumeScore + t5 + t15);
      const direction = ch >= 0 ? 'LONG' : 'SHORT';
      const confirmed = direction === 'LONG' ? trend5 === 'BULL' && trend15 === 'BULL' : trend5 === 'BEAR' && trend15 === 'BEAR';
      const signal = score >= threshold && confirmed ? (direction === 'LONG' ? 'PUMP' : 'DUMP') : score >= 50 ? 'WATCH' : '—';
      return { ...x, ch, vol, spike, trend5, trend15, score, signal, confirmed };
    })
    .sort((a, b) => b.score - a.score), [tickers, candleMap, threshold]);

  const pump = rows.filter(r => r.signal === 'PUMP').slice(0, 5);
  const dump = rows.filter(r => r.signal === 'DUMP').slice(0, 5);
  const spikes = rows.filter(r => r.spike >= 2).sort((a, b) => b.spike - a.spike).slice(0, 5);

  useEffect(() => {
    if (!paperEnabled) return;
    const candidates = [...rows.filter(r => r.signal === 'PUMP' || r.signal === 'DUMP')]
      .filter(r => r.symbol.startsWith('BTC') || r.symbol.startsWith('ETH'))
      .sort((a, b) => b.score - a.score);

    setPaperSpreads(current => {
      if (current.length >= MAX_PAPER_SPREADS) return current;
      const existing = new Set(current.map(p => p.underlying));
      const additions = [];
      for (const signal of candidates) {
        if (current.length + additions.length >= MAX_PAPER_SPREADS) break;
        const underlying = signal.symbol.startsWith('BTC') ? 'BTC' : 'ETH';
        const key = `${underlying}:${signal.signal}`;
        if (existing.has(key) || Date.now() - (entryCooldown.current[key] || 0) < ENTRY_COOLDOWN_MS) continue;
        const chain = Object.values(optionMap).filter(o => o.underlying === underlying);
        const spread = pickSpread(chain, signal.signal);
        if (!spread) continue;
        const shortEntry = spread.shortLeg.mark;
        const hedgeEntry = spread.hedge.mark;
        const multiplier = num(spread.shortLeg.contract_value ?? spread.hedge.contract_value, 1);
        additions.push({
          id: `${underlying}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          underlying,
          direction: signal.signal,
          strategy: signal.signal === 'PUMP' ? 'Bull Put Credit' : 'Bear Call Credit',
          signalScore: signal.score,
          openedAt: Date.now(),
          multiplier,
          short: { symbol: spread.shortLeg.symbol, strike: spread.shortLeg.strike, entry: shortEntry, delta: spread.shortLeg.delta },
          hedge: { symbol: spread.hedge.symbol, strike: spread.hedge.strike, entry: hedgeEntry, delta: spread.hedge.delta },
        });
        existing.add(key);
        entryCooldown.current[key] = Date.now();
      }
      return additions.length ? [...current, ...additions] : current;
    });
  }, [rows, optionMap, paperEnabled]);

  useEffect(() => {
    if (!telegram) return;
    rows.filter(r => r.signal === 'PUMP' || r.signal === 'DUMP').slice(0, 10).forEach(r => {
      const key = r.symbol + ':' + r.signal;
      const now = Date.now();
      if (now - (alertState.current[key] || 0) < TELEGRAM_COOLDOWN) return;
      alertState.current[key] = now;
      fetch('/api/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: r.symbol, signal: r.signal, score: r.score, change: r.ch, volumeSpike: r.spike, trend5: r.trend5, trend15: r.trend15 }) }).catch(() => {});
    });
  }, [rows, telegram]);

  const closePaper = id => setPaperSpreads(current => current.filter(p => p.id !== id));
  const clearAllPaper = () => setPaperSpreads([]);
  const totalPaperPnl = paperSpreads.reduce((sum, p) => sum + spreadPnl(p, optionMap).total, 0);
  const toggleTelegram = () => { const n = !telegram; setTelegram(n); localStorage.setItem('deltaTelegram', n ? '1' : '0'); };

  return <div className="app">
    <header><div><div className="brand">⚡ Delta Scanner</div><div className="sub">Delta Exchange India · Live Momentum + Volume Scanner</div></div><div className="live"><span/> {status}</div></header>

    <section className="hero"><div><h1>Market Radar</h1><p>24H momentum + volume spike + 5m/15m confirmation. Paper options can enter automatically; real orders remain OFF.</p></div><div className="modebar"><button className={paperEnabled ? 'mode active' : 'mode'} onClick={() => setPaperEnabled(v => !v)}>📄 PAPER {paperEnabled ? 'ON' : 'OFF'}</button><button className="mode locked" disabled>🔒 LIVE MODE</button><button onClick={toggleTelegram}>🔔 Telegram {telegram ? 'ON' : 'OFF'}</button></div></section>

    <section className="cards"><Card title="Top Pump" data={pump}/><Card title="Top Dump" data={dump}/><Card title="Volume Spike" data={spikes} spike/><div className="card"><small>MIN SIGNAL SCORE</small><strong>{threshold}/100</strong><input className="range" type="range" min="50" max="90" value={threshold} onChange={e => setThreshold(Number(e.target.value))}/><small>5m + 15m confirmation required</small></div></section>

    <section className="panel paper-panel"><div className="panelhead"><div><h2>📄 Paper Option Spreads</h2><span>Automatic entry · max {MAX_PAPER_SPREADS} simultaneous · 2 legs · live marks</span></div><div className="paper-total">PAPER P&amp;L <b className={totalPaperPnl >= 0 ? 'up' : 'down'}>{totalPaperPnl >= 0 ? '+' : ''}{totalPaperPnl.toFixed(2)}</b></div></div>
      <div className="spread-grid">
        {paperSpreads.length ? paperSpreads.map(p => {
          const pnl = spreadPnl(p, optionMap);
          return <div className="spread-card" key={p.id}>
            <div className="spread-head"><div><b>{p.underlying} · {p.strategy}</b><small>Signal {p.signalScore}/100 · {new Date(p.openedAt).toLocaleTimeString()}</small></div><button className="close-btn" onClick={() => closePaper(p.id)}>Close</button></div>
            <div className="legs"><div><span className="leg short">SELL</span><b>{p.short.symbol}</b><small>Entry {p.short.entry.toFixed(4)} · Live {pnl.shortNow.toFixed(4)}</small></div><div><span className="leg hedge">BUY</span><b>{p.hedge.symbol}</b><small>Entry {p.hedge.entry.toFixed(4)} · Live {pnl.hedgeNow.toFixed(4)}</small></div></div>
            <div className="spread-foot"><span>2-leg P&amp;L</span><strong className={pnl.total >= 0 ? 'up' : 'down'}>{pnl.total >= 0 ? '+' : ''}{pnl.total.toFixed(2)}</strong></div>
          </div>;
        }) : <div className="empty-spreads">Waiting for a qualifying BTC/ETH PUMP or DUMP signal and a live 2-leg option chain…</div>}
      </div>
      <div className="paper-actions"><span>{paperSpreads.length}/{MAX_PAPER_SPREADS} spreads active · No real orders are sent</span><button onClick={clearAllPaper} disabled={!paperSpreads.length}>Clear Paper Positions</button></div>
    </section>

    <section className="panel"><div className="panelhead"><h2>Market Scanner</h2><span>{rows.length} perpetuals · {last ? last.toLocaleTimeString() : ''}</span></div><div className="tablewrap"><table><thead><tr><th>Symbol</th><th>24H Change</th><th>Volume</th><th>Spike</th><th>5m</th><th>15m</th><th>Strength</th><th>Signal</th></tr></thead><tbody>{rows.slice(0, 100).map(r => <tr key={r.symbol}><td><b>{r.symbol}</b></td><td className={r.ch >= 0 ? 'up' : 'down'}>{r.ch.toFixed(2)}%</td><td>${fmt(r.vol)}</td><td className={r.spike >= 2 ? 'hot' : ''}>{r.spike ? r.spike + 'x' : '—'}</td><td><span className={'trend ' + r.trend5.toLowerCase()}>{r.trend5}</span></td><td><span className={'trend ' + r.trend15.toLowerCase()}>{r.trend15}</span></td><td><div className="score"><i style={{ width: `${r.score}%` }}/><span>{r.score}</span></div></td><td><span className={`pill ${r.signal === 'PUMP' ? 'buy' : r.signal === 'DUMP' ? 'sell' : 'watch'}`}>{r.signal}</span></td></tr>)}</tbody></table></div></section>
    <footer>⚠️ Paper trading only. Live mode is intentionally locked: this build never places real Delta Exchange orders. Option-chain marks come from Delta's public market API. Telegram alerts require Vercel environment variables.</footer>
  </div>;
}

function Card({ title, data, spike }) { return <div className="card"><small>{title.toUpperCase()}</small>{data.length ? <ol>{data.map(x => <li key={x.symbol}><span>{x.symbol}</span><strong className={spike ? 'hot' : x.ch >= 0 ? 'up' : 'down'}>{spike ? x.spike + 'x' : x.ch.toFixed(2) + '%'}</strong></li>)}</ol> : <small>No qualifying signal yet</small>}</div>; }
function fmt(n) { if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return n.toFixed(0); }

createRoot(document.getElementById('root')).render(<App/>);
