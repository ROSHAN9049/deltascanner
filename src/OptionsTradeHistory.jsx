import React, { useMemo, useState } from 'react';

const value = v => v === null || v === undefined || v === '' ? '—' : String(v);
const numeric = v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const money = v => numeric(v) === null ? '—' : numeric(v).toLocaleString('en-IN', { maximumFractionDigits: 8 });
const rawOf = row => row?.raw && typeof row.raw === 'object' ? row.raw : {};

export default function OptionsTradeHistory({ positions = [], orders = [], accountDataProtected = false, complete = true }) {
  const [filter, setFilter] = useState('ALL');
  const rows = useMemo(() => {
    const allOrders = Array.isArray(orders) ? orders : [];
    return (Array.isArray(positions) ? positions : []).map(position => {
      const raw = rawOf(position);
      const entryId = String(position.entry_order_id || '');
      const matching = allOrders.filter(order => String(order.symbol || '') === String(position.symbol || ''));
      const entry = matching.find(order => String(order.id || '') === entryId ||
        String(order.raw?.exchange_order_id || '') === entryId ||
        String(order.client_order_id || '').includes(String(position.position_key || '')));
      const exits = matching.filter(order => String(order.role || '').toUpperCase() === 'EXIT' ||
        String(order.raw?.role || '').toUpperCase() === 'EXIT');
      const exit = exits.filter(order => !position.opened_at || new Date(order.created_at) >= new Date(position.opened_at))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      const exitRaw = rawOf(exit);
      const exitPrice = position.short_exit_premium ?? raw.exit_fill_price ?? exitRaw.average_fill_price ?? exitRaw.fill_price ??
        exit?.limit_price ?? null;
      const sl = raw.stop_premium ?? raw.stop_loss_price ?? raw.bracket_stop_loss_price;
      const tp = raw.take_profit_premium ?? raw.take_profit_price ?? raw.bracket_take_profit_price;
      return {
        ...position,
        entryPrice: position.entry_premium ?? raw.entry_premium ?? entry?.raw?.average_fill_price ?? entry?.limit_price,
        exitPrice,
        sl,
        tp,
        orderIds: [entryId, raw.exit_order_id, exitRaw.exchange_order_id, exit?.id, exit?.raw?.exchange_order_id].filter(Boolean)
          .filter((id, index, list) => list.indexOf(id) === index).join(' / ')
      };
    }).sort((a, b) => new Date(b.opened_at || b.updated_at || 0) - new Date(a.opened_at || a.updated_at || 0));
  }, [positions, orders]);
  const visible = rows.filter(row => filter === 'ALL' || String(row.status).toUpperCase() === filter);
  if (accountDataProtected) return <section className="panel"><div className="panelTitle"><h2>Options Trade History</h2></div><div className="pad lockedText">Private Options trade history is locked. Unlock the dashboard session in Settings. Hidden data is not zero.</div></section>;
  return <section className="panel">
    <div className="panelTitle"><h2>Options Trade History</h2><span className="muted">{rows.length} trades</span></div>
    <div className="pad">
      {!complete ? <p className="warn">Options history could not be fully loaded. The visible rows may be incomplete.</p> : null}
      <div className="historyFilters" role="group" aria-label="Filter Options trade history">
        {['ALL', 'OPEN', 'CLOSED'].map(key => <button key={key} type="button" className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{key === 'ALL' ? 'View All' : key}</button>)}
      </div>
      <div className="tablewrap"><table><thead><tr>
        <th>DATE / TIME</th><th>SYMBOL</th><th>SIDE</th><th>ENTRY PRICE</th><th>EXIT PRICE</th><th>QTY</th><th>SL / TP</th><th>STATUS</th><th>REALIZED PNL</th><th>ORDER ID</th>
      </tr></thead><tbody>
        {visible.map((row, index) => <tr key={row.position_key || row.entry_order_id || index}>
          <td>{row.opened_at ? new Date(row.opened_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : value(row.updated_at)}</td>
          <td className="symbol">{value(row.symbol)}</td><td className={row.side === 'BUY' ? 'up' : 'down'}>{value(row.side)}</td>
          <td>{money(row.entryPrice)}</td><td>{money(row.exitPrice)}</td><td>{value(row.qty)}</td>
          <td>SL {money(row.sl)} / TP {money(row.tp)}</td>
          <td>{String(row.status || 'UNKNOWN').toUpperCase()}</td>
          <td className={row.realized_pnl_verified === true && numeric(row.realized_pnl) !== null ? (numeric(row.realized_pnl) >= 0 ? 'up' : 'down') : 'muted'}>
            {row.realized_pnl_verified === true ? money(row.realized_pnl) : 'UNVERIFIED'}
          </td><td>{row.orderIds || value(row.entry_order_id)}</td>
        </tr>)}
        {!visible.length ? <tr><td colSpan={10}>No {filter === 'ALL' ? '' : filter.toLowerCase() + ' '}Options trades found.</td></tr> : null}
      </tbody></table></div>
      <p className="muted">PnL is displayed only when the exchange close fill is verified. Missing exit fills are not estimated from mark/current premium.</p>
    </div>
  </section>;
}
