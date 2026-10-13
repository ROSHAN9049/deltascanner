const POSITION_SYMBOL_KEYS = [
  'instrument_symbol', 'instrumentSymbol', 'trading_symbol', 'tradingSymbol',
  'tradingsymbol', 'contract_symbol', 'contractSymbol', 'instrument', 'symbol', 'asset', 'name'
];
const POSITION_QTY_KEYS = [
  'net_quantity', 'netQuantity', 'net_qty', 'netQty', 'signed_position_size',
  'signedPositionSize', 'quantity', 'qty', 'position_qty', 'positionQty',
  'open_quantity', 'openQuantity', 'open_qty', 'openQty', 'position_size',
  'positionSize', 'size'
];
const OPEN_FLAG_KEYS = ['open', 'is_open', 'isOpen', 'open_position', 'isOpenPosition'];
const POSITION_STATUS_KEYS = ['position_status', 'positionStatus', 'status', 'state'];
const ENTRY_PRICE_KEYS = [
  'entry_price', 'entryPrice', 'average_entry_price', 'averageEntryPrice',
  'average_price', 'averagePrice', 'avg_price', 'avgPrice', 'price', 'entry'
];
const MARK_PRICE_KEYS = [
  'ltp', 'last_traded_price', 'lastTradedPrice', 'mark_price', 'markPrice',
  'current_price', 'currentPrice', 'last_price', 'lastPrice'
];
const POSITION_VALUE_KEYS = [
  'market_value', 'marketValue', 'position_value', 'positionValue',
  'value', 'notional', 'notional_value', 'notionalValue'
];
const POSITION_PNL_KEYS = [
  'm2m', 'mtm', 'unrealized_pnl', 'unrealizedPnl', 'open_pnl', 'openPnl',
  'mark_to_market', 'markToMarket', 'pnl'
];

const clean = value => String(value ?? '').trim();

function firstValue(row, keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && clean(row[key]) !== '') {
      return row[key];
    }
  }
  return null;
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || clean(value) === '') return null;
  const source = clean(value);
  const negativeByParentheses = /^\(.*\)$/.test(source);
  const numericText = source.replace(/[,$₹\s]/g, '').replace(/[^\d.eE+-]/g, '');
  if (!numericText || !/[\d]/.test(numericText)) return null;
  const parsed = Number(numericText);
  if (!Number.isFinite(parsed)) return null;
  return negativeByParentheses ? -Math.abs(parsed) : parsed;
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const text = clean(value).toLowerCase();
  if (['true', 'yes', '1', 'open', 'opened', 'entered', 'active'].includes(text)) return true;
  if (['false', 'no', '0', 'closed', 'close', 'exited', 'flat'].includes(text)) return false;
  return null;
}

function displaySymbol(value) {
  const raw = clean(value);
  if (!raw) return '';

  // Tradetron rows can identify futures with keys such as
  // FUTCRYPTO_DIN-LINKUSD_31DEC2099_XX_0. Extract the Delta contract
  // instead of showing the full futures identifier.
  const embeddedContract = raw.match(/(?:^|[_ -])DIN[-_]?([A-Z0-9]+)(?=[_ ]|$)/i);
  if (embeddedContract) return embeddedContract[1].toUpperCase();

  return raw.replace(/^DIN[-_]?/i, '').split(/[ _]/)[0].toUpperCase();
}

function hasPositionStatus(row) {
  const status = clean(firstValue(row, POSITION_STATUS_KEYS)).toLowerCase();
  if (['closed', 'close', 'exited', 'flat', 'square-off', 'squared-off'].includes(status)) return false;
  if (['open', 'opened', 'entered', 'active', 'live-entered'].includes(status)) return true;
  return null;
}

/**
 * Normalizes a raw Tradetron Developer API position row for display only.
 * It deliberately does not promote snapshot rows to fill/trade-ledger records.
 */
export function normalizeTradetronPosition(position, deployment = {}) {
  if (!position || typeof position !== 'object' || Array.isArray(position)) return null;
  const rawSymbol = clean(firstValue(position, POSITION_SYMBOL_KEYS));
  const symbol = displaySymbol(rawSymbol);
  if (!symbol) return null;

  const quantity = numericValue(firstValue(position, POSITION_QTY_KEYS));
  const explicitOpen = booleanValue(firstValue(position, OPEN_FLAG_KEYS));
  const statusOpen = hasPositionStatus(position);
  const open = explicitOpen === false
    ? false
    : quantity !== null && quantity !== 0
      ? true
      : explicitOpen === true || statusOpen === true;

  const price = numericValue(firstValue(position, ENTRY_PRICE_KEYS));
  const markPrice = numericValue(firstValue(position, MARK_PRICE_KEYS));
  const pnl = numericValue(firstValue(position, POSITION_PNL_KEYS));
  const value = numericValue(firstValue(position, POSITION_VALUE_KEYS));
  const sideRaw = clean(firstValue(position, ['side', 'position_side', 'positionSide', 'direction'])).toUpperCase();
  const side = quantity !== null && quantity !== 0
    ? (quantity < 0 ? 'SELL' : 'BUY')
    : (['BUY', 'LONG'].includes(sideRaw) ? 'BUY' : ['SELL', 'SHORT'].includes(sideRaw) ? 'SELL' : '');

  const identity = clean(firstValue(position, [
    'position_id', 'positionId', 'leg_id', 'legId', 'trade_id', 'tradeId',
    'execution_id', 'executionId', 'id'
  ])) || rawSymbol || symbol;

  return {
    key: String(deployment.deployment_id ?? 'deployment') + ':' + identity,
    deploymentId: deployment.deployment_id ?? null,
    deploymentName: clean(deployment.deployment_name || deployment.name) || 'Tradetron deployment',
    rawSymbol,
    symbol,
    side,
    quantity,
    entryPrice: price,
    markPrice,
    marketValue: value,
    pnl,
    open,
    status: clean(firstValue(position, POSITION_STATUS_KEYS)) || (open ? 'Open' : 'Closed'),
    raw: position
  };
}

export function normalizeTradetronPositions(deployments = []) {
  return (Array.isArray(deployments) ? deployments : []).flatMap(deployment =>
    (Array.isArray(deployment?.positions) ? deployment.positions : [])
      .map(position => normalizeTradetronPosition(position, deployment))
      .filter(Boolean)
  );
}

export function summarizeTradetronSnapshots(deployments = []) {
  const rows = Array.isArray(deployments) ? deployments : [];
  const normalized = normalizeTradetronPositions(rows);
  const openRows = normalized.filter(position => position.open);
  const visibleRows = rows.filter(row => row?.positions_hidden !== true);
  const reportedOpenCounts = rows
    .map(row => numericValue(row?.open_positions))
    .filter(value => value !== null && value >= 0);
  const reportedOpenCount = reportedOpenCounts.length
    ? reportedOpenCounts.reduce((total, value) => total + value, 0)
    : 0;
  const openCount = Math.max(reportedOpenCount, openRows.length);
  const pnlValues = rows.map(row => numericValue(row?.pnl)).filter(value => value !== null);
  const reportedPnl = rows.length > 0 && pnlValues.length === rows.length
    ? pnlValues.reduce((total, value) => total + value, 0)
    : null;
  const openPnlValues = openRows.map(row => row.pnl);
  const openPnl = openPnlValues.length && openPnlValues.every(value => value !== null)
    ? openPnlValues.reduce((total, value) => total + value, 0)
    : null;

  return {
    deployments: rows.length,
    visibleDeployments: visibleRows.length,
    totalRows: normalized.length,
    openRows,
    openCount,
    reportedPnl,
    openPnl,
    positionsHidden: rows.some(row => row?.positions_hidden === true),
    asOf: rows.reduce((latest, row) => {
      const candidate = row?.as_of || row?.last_success_at || null;
      return candidate && (!latest || Date.parse(candidate) > Date.parse(latest)) ? candidate : latest;
    }, null)
  };
}
