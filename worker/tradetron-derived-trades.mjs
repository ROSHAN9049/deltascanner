import { createHash, randomUUID } from 'node:crypto';

const clean = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === null || value === undefined || clean(value) === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const firstValue = (row, keys) => {
  for (const key of keys) {
    if (row?.[key] !== null && row?.[key] !== undefined && clean(row[key]) !== '') return row[key];
  }
  return null;
};
const SYMBOL_KEYS = ['instrument_symbol','instrumentSymbol','trading_symbol','tradingSymbol','tradingsymbol','contract_symbol','contractSymbol','instrument','symbol','asset','name'];
const QTY_KEYS = ['net_quantity','netQuantity','net_qty','netQty','signed_position_size','signedPositionSize','quantity','qty','position_qty','positionQty','open_quantity','openQuantity','open_qty','openQty','position_size','positionSize','size'];
const LTP_KEYS = ['ltp','last_traded_price','lastTradedPrice','mark_price','markPrice','current_price','currentPrice','last_price','lastPrice'];
const SIDE_KEYS = ['side','position_side','positionSide','direction'];
const ID_KEYS = ['position_id','positionId','leg_id','legId','trade_id','tradeId','execution_id','executionId','id'];
const ENTRY_KEYS = ['entry_price','entryPrice','average_entry_price','averageEntryPrice','average_price','averagePrice','avg_price','avgPrice','entry'];
const EXIT_KEYS = ['exit_price','exitPrice','average_exit_price','averageExitPrice','close_price','closePrice','exit'];
const OPEN_KEYS = ['open','is_open','isOpen','open_position','isOpenPosition'];
const CLOSE_TIME_KEYS = ['closed_at','closedAt','exit_time','exitTime','closed_on','closedOn'];

function normalizeSide(value) {
  const side = clean(value).toUpperCase();
  if (['LONG','BUY'].includes(side)) return 'LONG';
  if (['SHORT','SELL'].includes(side)) return 'SHORT';
  return null;
}

export function tradetronDerivedSymbol(value) {
  const raw = clean(value);
  if (!raw) return '';
  const contract = raw.match(/(?:^|[_ -])DIN[-_]?([A-Z0-9]+)(?=[_ ]|$)/i);
  if (contract) return contract[1].toUpperCase();
  return raw.replace(/^DIN[-_]?/i, '').split(/[ _]/)[0].toUpperCase();
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
function parseTime(value) {
  if (value === null || value === undefined || clean(value) === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function eventTime(notification) {
  return parseTime(notification?.event_at || notification?.at || notification?.raw?.at);
}
function eventText(notification) {
  return [
    notification?.title, notification?.description, notification?.message,
    notification?.raw?.message, notification?.raw?.description
  ].filter(Boolean).join(' ');
}

export function normalizeDerivedPosition(position, deploymentId, asOf = new Date().toISOString()) {
  if (!position || typeof position !== 'object' || Array.isArray(position)) return null;
  const rawSymbol = clean(firstValue(position, SYMBOL_KEYS));
  const symbol = tradetronDerivedSymbol(rawSymbol);
  if (!symbol) return null;
  const idValue = firstValue(position, ID_KEYS);
  const positionKey = idValue !== null ? String(idValue) : rawSymbol;
  if (!positionKey) return null;
  const quantity = numberOrNull(firstValue(position, QTY_KEYS));
  const explicitOpenRaw = firstValue(position, OPEN_KEYS);
  const explicitOpen = typeof explicitOpenRaw === 'boolean'
    ? explicitOpenRaw
    : ['true','yes','1','open','opened','active'].includes(clean(explicitOpenRaw).toLowerCase())
      ? true
      : ['false','no','0','closed','close','exited','flat'].includes(clean(explicitOpenRaw).toLowerCase())
        ? false : null;
  const isOpen = quantity !== null ? Math.abs(quantity) > 0 : explicitOpen === true;
  const side = normalizeSide(firstValue(position, SIDE_KEYS));
  const entryPrice = numberOrNull(firstValue(position, ENTRY_KEYS));
  const exitPrice = numberOrNull(firstValue(position, EXIT_KEYS));
  const closedAtExplicit = parseTime(firstValue(position, CLOSE_TIME_KEYS));
  return {
    id: randomUUID(),
    deployment_id: String(deploymentId),
    position_key: positionKey,
    symbol,
    quantity,
    side,
    ltp: numberOrNull(firstValue(position, LTP_KEYS)),
    raw_pnl: numberOrNull(position.pnl),
    is_open: isOpen,
    explicit_open: explicitOpen,
    explicit_closed: quantity === 0 && explicitOpen === false,
    entry_price: entryPrice,
    exit_price: exitPrice,
    closed_at_explicit: closedAtExplicit,
    raw_api_data: position,
    observed_at: parseTime(asOf) || new Date().toISOString(),
    last_observed_at: parseTime(asOf) || new Date().toISOString(),
    is_current: true
  };
}

function dataQuality({ side, entryPrice, exitPrice }) {
  if (entryPrice !== null && entryPrice !== undefined && exitPrice !== null && exitPrice !== undefined) return 'FULL';
  return side ? 'PARTIAL' : 'MINIMAL';
}

function notificationEstimate({ notifications, deploymentId, fromTime, toTime, onlyCloseCandidate }) {
  if (!onlyCloseCandidate) return null;
  const from = Date.parse(fromTime || '');
  const to = Date.parse(toTime || '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const matches = (Array.isArray(notifications) ? notifications : []).filter(item => {
    if (String(item?.deployment_id ?? '') !== String(deploymentId)) return false;
    const at = eventTime(item);
    if (!at) return false;
    const ms = Date.parse(at);
    if (ms < from || ms > to) return false;
    const text = eventText(item);
    return /\b(exited|closed|position\s+closed|close\s+complete)\b/i.test(text) ||
      /to\s+exited\b/i.test(text);
  });
  return matches.length === 1 ? eventTime(matches[0]) : null;
}

function buildTrade({ current, previous, deploymentId, derivedFrom, detectedAt, notifications, uniqueCloseCandidate }) {
  const previousRaw = previous?.raw_api_data && typeof previous.raw_api_data === 'object'
    ? previous.raw_api_data : {};
  const currentRaw = current?.raw_api_data && typeof current.raw_api_data === 'object'
    ? current.raw_api_data : {};
  const previousEntry = numberOrNull(firstValue(previousRaw, ENTRY_KEYS));
  const currentEntry = numberOrNull(firstValue(currentRaw, ENTRY_KEYS));
  const entryPrice = currentEntry ?? previousEntry;
  const exitPrice = numberOrNull(firstValue(currentRaw, EXIT_KEYS));
  const side = current?.side || previous?.side || null; // side is only accepted when explicitly present in raw API data
  const ltp = current?.ltp ?? previous?.ltp ?? null; // Last known LTP is not an exit price.
  const rawPnl = Object.hasOwn(currentRaw, 'pnl') ? numberOrNull(currentRaw.pnl) : null;
  const sourceKey = derivedFrom === 'poll_transition'
    ? ['poll_transition', deploymentId, current.position_key, previous?.id || 'missing-prior'].join(':')
    : ['snapshot_closed', deploymentId, current.position_key].join(':');
  const closeAtFromNotification = derivedFrom === 'poll_transition'
    ? notificationEstimate({
        notifications,
        deploymentId,
        fromTime: previous?.last_observed_at || previous?.observed_at,
        toTime: detectedAt,
        onlyCloseCandidate: uniqueCloseCandidate
      })
    : null;
  const explicitClosedAt = current.closed_at_explicit || parseTime(firstValue(currentRaw, CLOSE_TIME_KEYS));
  return {
    id: randomUUID(),
    deployment_id: String(deploymentId),
    symbol: current.symbol,
    side,
    qty_closed: derivedFrom === 'poll_transition' && numberOrNull(previous?.quantity) !== null
      ? Math.abs(numberOrNull(previous.quantity)) : null,
    last_known_ltp: ltp,
    raw_pnl: rawPnl,
    raw_api_data: {
      current: currentRaw,
      previous: previous ? {
        id: previous.id,
        quantity: previous.quantity,
        side: previous.side,
        ltp: previous.ltp,
        raw_pnl: previous.raw_pnl,
        observed_at: previous.observed_at,
        last_observed_at: previous.last_observed_at,
        raw_api_data: previousRaw
      } : null,
      source_note: derivedFrom === 'snapshot_closed'
        ? 'Explicit zero-quantity/closed API snapshot observation; not proof of a newly closed trade.'
        : 'Detected by comparing two API polls. Row-level P&L semantics remain unverified.'
    },
    derived_from: derivedFrom,
    data_quality: dataQuality({ side, entryPrice, exitPrice }),
    transition_from_snapshot_id: derivedFrom === 'poll_transition' ? previous?.id || null : null,
    detected_at: parseTime(detectedAt) || new Date().toISOString(),
    closed_at_estimated: explicitClosedAt || closeAtFromNotification,
    entry_price: entryPrice,
    exit_price: exitPrice,
    opened_at: parseTime(firstValue(previousRaw, ['opened_at','openedAt','entry_time','entryTime'])),
    closed_at: explicitClosedAt,
    is_verified: false,
    source_fingerprint: hash(sourceKey)
  };
}

/**
 * Build a side-effect-free plan for display-only derived position history.
 * Missing positions never imply a close. Quantity sign never implies side.
 */
export function buildApiDerivedTrackingPlan({
  previousObservations = [],
  snapshots = [],
  notifications = [],
  detectedAt = new Date().toISOString()
} = {}) {
  const now = parseTime(detectedAt) || new Date().toISOString();
  const previousByKey = new Map();
  for (const row of Array.isArray(previousObservations) ? previousObservations : []) {
    if (row?.is_current !== false && row?.deployment_id != null && row?.position_key) {
      previousByKey.set(String(row.deployment_id) + ':' + String(row.position_key), row);
    }
  }
  const records = [];
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const deploymentId = snapshot?.deployment_id;
    if (deploymentId === null || deploymentId === undefined) continue;
    const rows = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
    for (const raw of rows) {
      const current = normalizeDerivedPosition(raw, deploymentId, snapshot?.as_of || now);
      if (!current) continue;
      const mapKey = String(deploymentId) + ':' + current.position_key;
      const previous = previousByKey.get(mapKey) || null;
      const prevQty = numberOrNull(previous?.quantity);
      const transitionClose = !!previous && prevQty !== null && prevQty !== 0 &&
        current.quantity === 0 && current.explicit_closed;
      const snapshotClosed = !previous && current.quantity === 0 && current.explicit_closed;
      if (transitionClose) {
        records.push({ kind: 'trade', row: null, trade: buildTrade({
          current, previous, deploymentId, derivedFrom: 'poll_transition', detectedAt: now,
          notifications, uniqueCloseCandidate: false
        }), previous, current, transitionClose: true, mapKey });
      } else if (snapshotClosed) {
        records.push({ kind: 'trade', row: null, trade: buildTrade({
          current, previous: null, deploymentId, derivedFrom: 'snapshot_closed', detectedAt: now,
          notifications, uniqueCloseCandidate: false
        }), previous: null, current, transitionClose: false, mapKey });
      }

      if (previous && !transitionClose && previous.is_open === current.is_open &&
          numberOrNull(previous.quantity) === current.quantity) {
        records.push({
          kind: 'update', previous,
          row: {
            quantity: current.quantity, side: current.side || previous.side || null, ltp: current.ltp,
            raw_pnl: current.raw_pnl, is_open: current.is_open,
            raw_api_data: current.raw_api_data, last_observed_at: now,
            symbol: current.symbol
          },
          current, mapKey
        });
      } else if (previous) {
        records.push({
          kind: 'replace', previous,
          row: current, current, mapKey
        });
      } else {
        records.push({ kind: 'insert', row: current, current, mapKey });
      }
      previousByKey.set(mapKey, previous && !transitionClose && previous.is_open === current.is_open &&
        numberOrNull(previous.quantity) === current.quantity
        ? { ...previous, ...current, last_observed_at: now }
        : current);
    }
  }

  const closeCandidatesByDeployment = new Map();
  for (const record of records) {
    if (record.transitionClose) {
      const key = String(record.trade.deployment_id);
      closeCandidatesByDeployment.set(key, (closeCandidatesByDeployment.get(key) || 0) + 1);
    }
  }
  for (const record of records) {
    if (!record.transitionClose) continue;
    const trade = record.trade;
    const previous = record.previous;
    const closeCandidates = closeCandidatesByDeployment.get(String(trade.deployment_id)) || 0;
    if (closeCandidates === 1) {
      trade.closed_at_estimated = record.current.closed_at_explicit || notificationEstimate({
        notifications,
        deploymentId: trade.deployment_id,
        fromTime: previous?.last_observed_at || previous?.observed_at,
        toTime: now,
        onlyCloseCandidate: true
      });
    }
  }

  return {
    trades: records.filter(record => record.kind === 'trade').map(record => record.trade),
    observationActions: records.filter(record => record.kind !== 'trade').map(record => ({
      type: record.kind,
      previous_id: record.previous?.id || null,
      row: record.row
    })),
    detectedAt: now
  };
}
