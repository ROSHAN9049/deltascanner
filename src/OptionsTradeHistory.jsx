import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from './api-url.js';

const fmt = value => value === null || value === undefined || value === '' ? '—'
  : Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN', { maximumFractionDigits: 8 }) : '—';
const money = value => value === null || value === undefined ? '—'
  : (Number(value) >= 0 ? '+' : '') + Number(value).toLocaleString('en-IN', { maximumFractionDigits: 4 });

export default function OptionsTradeHistory({ accountDataProtected = false }) {
  const [filter, setFilter] = useState('ALL');
  const [rows, setRows] = useState([]);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (accountDataProtected) {
      setRows([]);
      setComplete(false);
      setError('Unlock the private dashboard session in Settings to view Options trade history.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetch(apiUrl('/api/options/history?t=' + Date.now()), {
        credentials: 'include', cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok || data?.success !== true || !Array.isArray(data.rows)) {
        throw new Error(data?.error || 'Options trade history could not be loaded');
      }
      setRows(data.rows);
      setComplete(data.complete === true);
    } catch (err) {
      setError(err.message || 'Options trade history unavailable');
    } finally {
      setLoading(false);
    }
  }, [accountDataProtected]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => rows.filter(row => filter === 'ALL' ||
    (filter === 'OPEN' ? row.status === 'OPEN' : row.status === 'CLOSED')), [rows, filter]);

  return <section className="panel">
    <div className="panelTitle">
      <h2>Options Trade History</h2>
      <button className="action" type="button" onClick={() => void load()} disabled={loading}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
    <div className="chips" role="group" aria-label="Filter Options trade history">
      {['ALL', 'OPEN', 'CLOSED'].map(value => <button key={value} type="button"
        className={filter === value ? 'action' : 'secondary'}
        aria-pressed={filter === value} onClick={() => setFilter(value)}>
        {value === 'ALL' ? 'View All' : value}
      </button>)}
      <span>{filtered.length} / {rows.length} trades</span>
    </div>
    {error ? <div className="lockedText" role="alert">{error}</div> : null}
    {!complete && rows.length ? <div className="lockedText">History may be partial because the API page limit was reached. Refresh after reviewing older records.</div> : null}
    <div className="tablewrap">
      <table>
        <thead><tr>
          <th>Date / Time</th><th>Symbol</th><th>Side</th><th>Entry Price</th><th>Exit Price</th>
          <th>Qty</th><th>SL / TP</th><th>Status</th><th>Realized PnL</th><th>Order ID</th>
        </tr></thead>
        <tbody>
          {filtered.map(row => <tr key={row.positionKey}>
            <td>{row.dateTime ? new Date(row.dateTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td>
            <td className="symbol">{row.symbol}</td>
            <td className={row.side === 'BUY' ? 'up' : row.side === 'SELL' ? 'down' : ''}>{row.side}</td>
            <td>{fmt(row.entryPrice)}</td><td>{fmt(row.exitPrice)}</td><td>{fmt(row.quantity)}</td>
            <td>{fmt(row.stopLoss)} / {fmt(row.takeProfit)}</td>
            <td className={row.status === 'OPEN' ? 'warn' : 'muted'}>{row.status}</td>
            <td title={row.realizedPnlVerified ? 'Exchange-verified realized PnL' : 'Not available: no verified exit-fill PnL'}>{row.realizedPnlVerified ? money(row.realizedPnl) : 'UNVERIFIED'}</td>
            <td>{row.orderId}</td>
          </tr>)}
          {!filtered.length ? <tr><td colSpan={10}>{loading ? 'Loading Options history…' : 'No Options trades for this filter.'}</td></tr> : null}
        </tbody>
      </table>
    </div>
  </section>;
}
