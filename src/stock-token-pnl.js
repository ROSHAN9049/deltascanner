export const STOCK_TOKEN_SYMBOLS = new Set([
  'AMDBUSD','AAPLXUSD','AMZNXUSD','CBRSBUSD','INTCBUSD','SNDKBUSD',
  'MSTRBUSD','TSLAXUSD','GOOGLXUSD','DRAMBUSD','NBISBUSD','CRCLXUSD',
  'COINXUSD','PLTRBUSD','ORCLBUSD','HOODBUSD','KORUBUSD'
]);

const safeNum = value => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function contractValueForSymbol(marketCache, symbol) {
  const key = String(symbol || '').trim().toUpperCase();
  const row = (Array.isArray(marketCache) ? marketCache : []).find(item =>
    String(item?.symbol || '').trim().toUpperCase() === key
  );
  return safeNum(row?.contract_value ?? row?.contractValue);
}

export function stockTokenPnlTooltip(symbol, rawPnl, contractValue) {
  const key = String(symbol || '').trim().toUpperCase();
  if (!STOCK_TOKEN_SYMBOLS.has(key)) return null;
  const value = safeNum(rawPnl);
  const cv = safeNum(contractValue);
  const raw = value === null ? 'unavailable' : String(value);
  const note = '⚠️ Adjusted value is a HYPOTHESIS. Tradetron API docs do not confirm the P&L field unit. Do not rely on this for trading.';
  if (value === null || cv === null) {
    return 'Raw API field: ' + raw + ' USD. Delta contract_value: ' +
      (cv === null ? 'unavailable' : String(cv)) +
      '. A possible adjusted value cannot be calculated from the available fields. ' + note;
  }
  return 'Raw API field: ' + raw + ' USD. Delta contract_value: ' + String(cv) +
    '. Possible adjusted value: $' + (value * cv).toFixed(2) + '. ' + note;
}

export function stockTokenOpenPnlTooltip(rows, marketCache, displayedRawPnl) {
  const adjustedRows = (Array.isArray(rows) ? rows : []).flatMap(row => {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const value = safeNum(row?.pnl ?? row?.raw_pnl);
    const cv = contractValueForSymbol(marketCache, symbol);
    return STOCK_TOKEN_SYMBOLS.has(symbol) && value !== null && cv !== null
      ? [{ symbol, value, cv, adjusted: value * cv }]
      : [];
  });
  const adjustedSubtotal = adjustedRows.reduce((sum, row) => sum + row.adjusted, 0);
  const basis = displayedRawPnl === null || displayedRawPnl === undefined
    ? 'Displayed raw open-P&L sum is unavailable.'
    : 'Displayed raw open-P&L sum remains ' + String(displayedRawPnl) + ' and is not changed.';
  const components = adjustedRows.length
    ? 'Possible stock-token adjusted subtotal: $' + adjustedSubtotal.toFixed(2) +
      ' from ' + adjustedRows.length + ' row(s): ' +
      adjustedRows.map(row => row.symbol + ' (' + row.value + ' × ' + row.cv + ' = $' + row.adjusted.toFixed(2) + ')').join('; ') + '.'
    : 'No stock-token row had both raw P&L and contract_value available for a hypothesis.';
  return basis + ' ' + components + ' ⚠️ Adjusted subtotal is a HYPOTHESIS only. Tradetron API docs do not confirm the P&L field unit. Do not rely on this for trading.';
}
