const EPSILON = 1e-8;

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();
const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const assetSymbol = value => upper(
  typeof value === 'string' ? value : value?.symbol ?? value?.asset_symbol ?? value?.currency
);
const productAsset = product => assetSymbol(
  product?.settling_asset ?? product?.settlingAsset ?? product?.settlement_asset
);
const closeEnough = (a, b, tolerance = EPSILON) =>
  Number.isFinite(Number(a)) && Number.isFinite(Number(b)) &&
  Math.abs(Number(a) - Number(b)) <= tolerance;
const activeOrderState = state =>
  ['RESERVED', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'UNKNOWN', 'RECONCILIATION_REQUIRED']
    .includes(upper(state));

function walletRows(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.result)) return snapshot.result;
  if (Array.isArray(snapshot?.result?.balances)) return snapshot.result.balances;
  if (Array.isArray(snapshot?.balances)) return snapshot.balances;
  return null;
}

function walletUserId(snapshot, rows) {
  const ids = new Set();
  const metaId = snapshot?.meta?.user_id ?? snapshot?.user_id ?? snapshot?.result?.user_id;
  if (metaId !== undefined && metaId !== null && text(metaId)) ids.add(String(metaId));
  for (const row of rows) {
    if (row?.user_id !== undefined && row?.user_id !== null && text(row.user_id)) {
      ids.add(String(row.user_id));
    }
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function walletAsset(snapshot, wantedAsset) {
  const rows = walletRows(snapshot);
  if (!rows || !rows.length) {
    return { valid: false, reason: 'WALLET_ROWS_UNAVAILABLE' };
  }
  const matches = rows.filter(row => assetSymbol(row?.asset_symbol ?? row?.currency ?? row?.symbol) === wantedAsset);
  if (matches.length !== 1) {
    return { valid: false, reason: matches.length ? 'WALLET_ASSET_AMBIGUOUS' : 'SETTLEMENT_ASSET_WALLET_MISSING' };
  }
  const row = matches[0];
  const balance = numberOrNull(row.balance ?? row.total_balance ?? row.wallet_balance);
  const available = numberOrNull(row.available_balance);
  const blocked = numberOrNull(row.blocked_margin);
  const userId = walletUserId(snapshot, rows);
  if (!userId || balance === null || available === null || blocked === null ||
      balance < 0 || available < 0 || blocked < 0 || blocked - balance > EPSILON) {
    return { valid: false, reason: 'WALLET_IDENTITY_OR_BALANCE_FIELDS_UNVERIFIED' };
  }
  const cashAfterBlocks = Math.max(0, balance - blocked);
  // available_balance can be stricter than balance minus blocked_margin.
  // Use the lower figure and never add unrealized P&L or option value.
  const spendable = Math.min(available, cashAfterBlocks);
  return {
    valid: true,
    userId,
    asset: wantedAsset,
    balance,
    available,
    blocked,
    spendable
  };
}

function mapBySymbol(rows) {
  const map = new Map();
  for (const row of rows) {
    const symbol = upper(row?.symbol ?? row?.product_symbol);
    if (!symbol || map.has(symbol)) return null;
    map.set(symbol, row);
  }
  return map;
}

function evaluateFuturesExposure(snapshot, wantedAsset, reasons) {
  const exchange = snapshot.futuresPositions;
  const tracked = snapshot.dbFuturesPositions;
  const products = snapshot.futuresProducts;
  if (!Array.isArray(exchange) || !Array.isArray(tracked) || !Array.isArray(products)) {
    reasons.push('FUTURES_POSITION_SNAPSHOT_INCOMPLETE');
    return { risk: null, gridRisk: null };
  }
  const exchangeMap = mapBySymbol(exchange);
  const trackedMap = mapBySymbol(tracked);
  if (!exchangeMap || !trackedMap || exchangeMap.size !== trackedMap.size) {
    reasons.push('FUTURES_EXCHANGE_DATABASE_POSITION_MISMATCH');
    return { risk: null, gridRisk: null };
  }
  const productMap = new Map(products.map(product => [upper(product?.symbol), product]));
  let totalRisk = 0;
  let gridRisk = 0;

  for (const [symbol, position] of exchangeMap) {
    const dbRow = trackedMap.get(symbol);
    const product = productMap.get(symbol);
    const productId = numberOrNull(position.product_id ?? position.productId);
    const trackedProductId = numberOrNull(dbRow?.product_id);
    const qty = numberOrNull(position.qty ?? position.size);
    const dbQty = numberOrNull(dbRow?.qty);
    const side = upper(position.side);
    const entry = numberOrNull(position.entry_price ?? position.entryPrice);
    const dbEntry = numberOrNull(dbRow?.entry_price);
    const stop = numberOrNull(dbRow?.sl_price);
    const exchangeStop = numberOrNull(position.sl_price ?? position.bracket_stop_loss_price);
    const contractValue = numberOrNull(product?.contract_value);
    const settle = productAsset(product);

    if (!product || !Number.isSafeInteger(productId) || productId <= 0 ||
        productId !== trackedProductId || !(qty > 0) || !closeEnough(qty, dbQty) ||
        !['BUY', 'SELL'].includes(side) || upper(dbRow?.side) !== side ||
        !(entry > 0) || !(dbEntry > 0) || !closeEnough(entry, dbEntry) ||
        !(stop > 0) || !(exchangeStop > 0) ||
        !closeEnough(stop, exchangeStop, numberOrNull(product?.tick_size) * 0.51 || EPSILON) ||
        !(contractValue > 0) || !settle) {
      reasons.push('FUTURES_POSITION_RISK_OR_PROTECTION_UNVERIFIED:' + symbol);
      continue;
    }

    if ((side === 'BUY' && stop >= entry) || (side === 'SELL' && stop <= entry)) {
      reasons.push('FUTURES_STOP_DIRECTION_INVALID:' + symbol);
      continue;
    }
    const feeRate = numberOrNull(product?.taker_commission_rate) ??
      numberOrNull(product?.maker_commission_rate) ?? 0.0006;
    const gridSlippageRate = upper(dbRow?.strategy) === 'GRID' ? 0.0002 : 0;
    const risk = (Math.abs(entry - stop) * contractValue +
      entry * contractValue * 2 * (feeRate + gridSlippageRate)) * qty;
    if (!Number.isFinite(risk) || risk <= 0) {
      reasons.push('FUTURES_MAX_LOSS_UNVERIFIED:' + symbol);
      continue;
    }
    if (upper(dbRow?.strategy) === 'GRID') gridRisk += risk;
    if (settle !== wantedAsset) {
      reasons.push('CROSS_SETTLEMENT_EXPOSURE_NOT_NETTABLE:' + symbol + ':' + settle);
      continue;
    }
    totalRisk += risk;
  }

  const openOrders = snapshot.futuresOrders;
  if (!Array.isArray(openOrders)) {
    reasons.push('FUTURES_OPEN_ORDER_SNAPSHOT_UNAVAILABLE');
  } else {
    for (const order of openOrders) {
      const symbol = upper(order?.product_symbol ?? order?.symbol);
      const product = productMap.get(symbol);
      const settle = productAsset(product);
      const reduceOnly = order?.reduce_only === true;
      if (!product || !settle) {
        reasons.push('FUTURES_OPEN_ORDER_SETTLEMENT_UNKNOWN:' + (symbol || 'UNKNOWN'));
      } else if (settle === wantedAsset && !reduceOnly) {
        reasons.push('FUTURES_NON_REDUCE_ONLY_ORDER_PENDING:' + symbol);
      }
    }
  }

  const gridState = snapshot.gridState;
  const gridRows = tracked.filter(row => upper(row?.strategy) === 'GRID');
  const gridPositions = Array.isArray(gridState?.positions) ? gridState.positions : null;
  if (!gridRows.length && (!gridPositions || gridPositions.length === 0)) {
    // No live Grid exposure: an uninitialized Grid state is acceptable.
  } else if (!gridState || !gridPositions || gridPositions.length !== gridRows.length ||
      !closeEnough(gridState.openRiskUsd, gridRisk)) {
    reasons.push('GRID_STATE_AND_EXCHANGE_RISK_MISMATCH');
  } else if (gridRows.length) {
    for (const row of gridRows) {
      const match = gridPositions.find(position => upper(position?.symbol) === upper(row.symbol));
      if (!match || !closeEnough(match.qty, row.qty) ||
          !closeEnough(match.riskUsd, (
            Math.abs(numberOrNull(row.entry_price) - numberOrNull(row.sl_price)) *
            numberOrNull(productMap.get(upper(row.symbol))?.contract_value) +
            numberOrNull(row.entry_price) * numberOrNull(productMap.get(upper(row.symbol))?.contract_value) * 2 * (
              (numberOrNull(productMap.get(upper(row.symbol))?.taker_commission_rate) ??
                numberOrNull(productMap.get(upper(row.symbol))?.maker_commission_rate) ?? 0.0006) + 0.0002
            )
          ) * numberOrNull(row.qty))) {
        reasons.push('GRID_POSITION_RISK_STATE_MISMATCH:' + upper(row.symbol));
      }
    }
  }
  return { risk: totalRisk, gridRisk };
}

function evaluateOptionsExposure(snapshot, wantedAsset, phase, groupId, reasons) {
  const group = snapshot.activeOptionsGroup || null;
  const positions = snapshot.optionsPositions;
  const openOrders = snapshot.optionsOpenOrders;
  const legs = snapshot.activeOptionsLegs;
  const ledgerOrders = snapshot.activeOptionsOrders;
  const products = snapshot.optionProducts;
  if (!Array.isArray(positions) || !Array.isArray(openOrders) ||
      !Array.isArray(products) || !Array.isArray(legs) || !Array.isArray(ledgerOrders)) {
    reasons.push('OPTIONS_EXCHANGE_OR_LEDGER_SNAPSHOT_INCOMPLETE');
    return { maxLoss: null, reservedMargin: null };
  }
  if (!group) {
    if (positions.length || openOrders.length || legs.length || ledgerOrders.length) {
      reasons.push('ORPHAN_OPTIONS_EXCHANGE_OR_LEDGER_EXPOSURE');
    }
    if (phase === 'ORDER') reasons.push('OPTIONS_GROUP_NOT_FOUND_FOR_ORDER');
    return { maxLoss: 0, reservedMargin: 0 };
  }

  if (phase === 'RESERVE' || String(group.id) !== String(groupId || group.id)) {
    reasons.push('OPTIONS_EXECUTION_SLOT_ALREADY_OCCUPIED');
  }
  if (upper(group.state) === 'EXIT_REQUIRED' || upper(group.state) === 'RECONCILIATION_REQUIRED') {
    reasons.push('OPTIONS_GROUP_NOT_ELIGIBLE_FOR_NEW_ENTRY');
  }

  const productMap = new Map(products.map(product => [upper(product?.symbol), product]));
  const expected = new Map();
  for (const leg of legs) {
    const symbol = upper(leg?.symbol);
    const product = productMap.get(symbol);
    const qty = numberOrNull(leg?.filled_qty) - numberOrNull(leg?.exit_filled_qty);
    if (!symbol || expected.has(symbol) || !product ||
        numberOrNull(leg?.product_id) !== numberOrNull(product.id ?? product.product_id) ||
        productAsset(product) !== wantedAsset || !Number.isFinite(qty) || qty < -EPSILON) {
      reasons.push('OPTIONS_LEG_PRODUCT_OR_SETTLEMENT_UNVERIFIED');
      continue;
    }
    if (qty > EPSILON) {
      expected.set(symbol, {
        productId: numberOrNull(leg.product_id),
        side: upper(leg.side),
        qty
      });
    }
  }

  const actual = mapBySymbol(positions);
  if (!actual || actual.size !== expected.size) {
    reasons.push('OPTIONS_POSITION_LEDGER_MISMATCH');
  } else {
    for (const [symbol, wanted] of expected) {
      const found = actual.get(symbol);
      if (!found || numberOrNull(found.product_id) !== wanted.productId ||
          upper(found.side) !== wanted.side || !closeEnough(found.qty, wanted.qty)) {
        reasons.push('OPTIONS_POSITION_LEDGER_MISMATCH:' + symbol);
      }
    }
  }

  if (openOrders.length) reasons.push('OPTIONS_ORDER_PENDING_REQUIRES_RECONCILIATION');
  for (const order of ledgerOrders) {
    if (activeOrderState(order.order_state)) {
      reasons.push('OPTIONS_LEDGER_ORDER_ATTEMPT_PENDING');
      break;
    }
  }

  const maxLoss = numberOrNull(group.max_loss_usd);
  const reservedMargin = numberOrNull(group.reserved_margin_usd);
  if (upper(group.settlement_asset) !== wantedAsset || !(maxLoss >= 0) ||
      !(reservedMargin >= 0)) {
    reasons.push('OPTIONS_GROUP_RISK_OR_SETTLEMENT_UNVERIFIED');
    return { maxLoss: null, reservedMargin: null };
  }
  return { maxLoss, reservedMargin };
}

/**
 * Pure cross-strategy risk evaluator. It deliberately refuses FX conversion,
 * unrealized-P&L collateral, missing stop-loss protection and incomplete wallet
 * snapshots. The current SQL *_usd fields require USD-settled option contracts.
 */
export function evaluateDeltaOptionsAccountRisk({
  snapshot,
  candidate = null,
  phase = 'RESERVE',
  groupId = null,
  limits = {},
  now = Date.now(),
  maxSnapshotAgeMs = 30_000
} = {}) {
  const reasons = [];
  const normalizedPhase = upper(phase);
  if (!snapshot || snapshot.executionMode !== 'testnet') reasons.push('TESTNET_MODE_REQUIRED');
  const capturedAt = numberOrNull(snapshot?.capturedAt);
  if (capturedAt === null || capturedAt > now || now - capturedAt > maxSnapshotAgeMs) {
    reasons.push('ACCOUNT_RISK_SNAPSHOT_STALE_OR_INVALID');
  }
  if (!['RESERVE', 'ORDER'].includes(normalizedPhase)) reasons.push('ACCOUNT_RISK_PHASE_INVALID');

  const settlementAsset = assetSymbol(candidate?.settlement_asset ?? candidate?.settlementAsset);
  if (!settlementAsset || settlementAsset !== 'USD') reasons.push('OPTIONS_SETTLEMENT_ASSET_NOT_VERIFIED_AS_USD');
  const futuresWallet = settlementAsset ? walletAsset(snapshot?.futuresWallet, settlementAsset) : { valid: false, reason: 'SETTLEMENT_ASSET_UNKNOWN' };
  const optionsWallet = settlementAsset ? walletAsset(snapshot?.optionsWallet, settlementAsset) : { valid: false, reason: 'SETTLEMENT_ASSET_UNKNOWN' };
  if (!futuresWallet.valid) reasons.push('FUTURES_WALLET_' + futuresWallet.reason);
  if (!optionsWallet.valid) reasons.push('OPTIONS_WALLET_' + optionsWallet.reason);
  if (futuresWallet.valid && optionsWallet.valid && futuresWallet.userId !== optionsWallet.userId) {
    reasons.push('OPTIONS_AND_FUTURES_API_KEYS_BELONG_TO_DIFFERENT_ACCOUNTS');
  }

  const maxCombinedRiskPct = numberOrNull(limits.maxCombinedOpenRiskPct);
  const minimumAvailableBufferPct = numberOrNull(limits.minimumAvailableBufferPct);
  if (!(maxCombinedRiskPct > 0 && maxCombinedRiskPct <= 100)) reasons.push('MAX_COMBINED_OPEN_RISK_LIMIT_NOT_CONFIGURED');
  if (!(minimumAvailableBufferPct >= 0 && minimumAvailableBufferPct < 100)) reasons.push('MINIMUM_AVAILABLE_BALANCE_BUFFER_NOT_CONFIGURED');

  const futures = settlementAsset
    ? evaluateFuturesExposure(snapshot || {}, settlementAsset, reasons)
    : { risk: null, gridRisk: null };
  const options = settlementAsset
    ? evaluateOptionsExposure(snapshot || {}, settlementAsset, normalizedPhase, groupId, reasons)
    : { maxLoss: null, reservedMargin: null };

  const candidateMaxLoss = numberOrNull(candidate?.max_loss_usd ?? candidate?.maxLossUsd);
  const candidateReserve = numberOrNull(candidate?.reserved_margin_usd ?? candidate?.reservedMarginUsd);
  const candidateGroupId = text(candidate?.client_group_id ?? candidate?.clientGroupId);
  let riskToAdd = 0;
  let marginToAdd = 0;
  if (normalizedPhase === 'RESERVE') {
    if (!(candidateMaxLoss > 0) || !(candidateReserve > 0)) {
      reasons.push('CANDIDATE_MAX_LOSS_OR_RESERVED_MARGIN_INVALID');
    } else {
      riskToAdd = candidateMaxLoss;
      marginToAdd = candidateReserve;
    }
  } else if (normalizedPhase === 'ORDER') {
    if (!groupId || !snapshot?.activeOptionsGroup ||
        String(snapshot.activeOptionsGroup.id) !== String(groupId)) {
      reasons.push('ORDER_GROUP_IDENTITY_UNVERIFIED');
    }
    if (candidateGroupId && snapshot?.activeOptionsGroup &&
        candidateGroupId !== String(snapshot.activeOptionsGroup.client_group_id)) {
      reasons.push('ORDER_GROUP_CLIENT_IDENTITY_MISMATCH');
    }
  }

  const accountBalance = futuresWallet.valid && optionsWallet.valid
    ? Math.min(futuresWallet.balance, optionsWallet.balance)
    : null;
  const freeCash = futuresWallet.valid && optionsWallet.valid
    ? Math.min(futuresWallet.spendable, optionsWallet.spendable)
    : null;
  const currentRisk = futures.risk === null || options.maxLoss === null
    ? null : futures.risk + options.maxLoss;
  const projectedRisk = currentRisk === null ? null : currentRisk + riskToAdd;
  const riskCap = accountBalance !== null && maxCombinedRiskPct > 0
    ? accountBalance * maxCombinedRiskPct / 100 : null;
  const minimumBuffer = accountBalance !== null && minimumAvailableBufferPct >= 0
    ? accountBalance * minimumAvailableBufferPct / 100 : null;

  if (accountBalance === null || !(accountBalance > 0)) reasons.push('SETTLEMENT_ASSET_BALANCE_UNAVAILABLE');
  if (freeCash === null) reasons.push('SETTLEMENT_ASSET_AVAILABLE_BALANCE_UNAVAILABLE');
  if (projectedRisk === null || riskCap === null || projectedRisk > riskCap + EPSILON) {
    reasons.push('COMBINED_OPEN_MAX_LOSS_EXCEEDS_OR_CANNOT_VERIFY_RISK_CAP');
  }
  if (normalizedPhase === 'RESERVE' &&
      (freeCash === null || minimumBuffer === null ||
       freeCash - marginToAdd < minimumBuffer - EPSILON)) {
    reasons.push('INSUFFICIENT_SETTLEMENT_ASSET_AVAILABLE_BALANCE_AFTER_RESERVE');
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    allowed: uniqueReasons.length === 0,
    phase: normalizedPhase,
    settlementAsset: settlementAsset || null,
    userId: futuresWallet.userId && optionsWallet.userId &&
      futuresWallet.userId === optionsWallet.userId ? futuresWallet.userId : null,
    accountBalance,
    availableBalance: freeCash,
    currentOpenRisk: currentRisk,
    candidateMaxLoss: normalizedPhase === 'RESERVE' ? candidateMaxLoss : 0,
    projectedOpenRisk: projectedRisk,
    maxCombinedOpenRisk: riskCap,
    reservedMarginRequired: normalizedPhase === 'RESERVE' ? marginToAdd : 0,
    minimumAvailableBuffer: minimumBuffer,
    reasons: uniqueReasons
  };
}

export function createDeltaOptionsAccountRiskGate({
  database,
  futuresExecutor,
  optionsExecutor,
  manager,
  optionsSupervisor,
  getLimits = () => ({}),
  getGridState = () => null,
  now = () => Date.now(),
  maxSnapshotAgeMs = 30_000
} = {}) {
  if (!database || typeof database.select !== 'function' ||
      !futuresExecutor || typeof futuresExecutor.getOpenPositions !== 'function' ||
      typeof futuresExecutor.getOpenOrders !== 'function' ||
      typeof futuresExecutor.getProductMetadata !== 'function' ||
      typeof futuresExecutor.getRawWalletSnapshot !== 'function' ||
      !optionsExecutor || typeof optionsExecutor.getOptionProducts !== 'function' ||
      typeof optionsExecutor.getOptionWalletSnapshot !== 'function' ||
      typeof optionsExecutor.getOpenOptionPositions !== 'function' ||
      typeof optionsExecutor.getOpenOptionOrders !== 'function' ||
      !manager || typeof manager.getActiveGroup !== 'function' ||
      typeof manager.getGroupLegs !== 'function' ||
      typeof manager.getGroupOrders !== 'function' ||
      !optionsSupervisor || typeof optionsSupervisor.reconcileOnce !== 'function') {
    throw new Error('Delta Options account risk gate requires complete read-only exchange and ledger readers');
  }

  async function snapshot() {
    if (upper(process.env.DELTA_EXECUTION_MODE) !== 'TESTNET') {
      throw new Error('Options account risk gate only supports Delta India Testnet');
    }
    const [
      futuresWallet, futuresPositions, futuresOrders,
      optionsWallet, optionsPositions, optionsOpenOrders,
      activeOptionsGroup, dbFuturesPositions, settingsRows, reconciliation
    ] = await Promise.all([
      futuresExecutor.getRawWalletSnapshot(),
      futuresExecutor.getOpenPositions(),
      futuresExecutor.getOpenOrders(),
      optionsExecutor.getOptionWalletSnapshot(),
      optionsExecutor.getOpenOptionPositions(),
      optionsExecutor.getOpenOptionOrders(),
      manager.getActiveGroup(),
      database.select(
        'dd_delta_positions',
        'status=eq.OPEN&select=id,symbol,product_id,side,qty,entry_price,sl_price,strategy'
      ),
      database.select('dd_settings', 'id=eq.1&select=grid_state'),
      optionsSupervisor.reconcileOnce()
    ]);

    if (!Array.isArray(dbFuturesPositions) || !Array.isArray(settingsRows) || settingsRows.length !== 1) {
      throw new Error('Options account risk gate could not verify the Futures/Grid database snapshot');
    }
    const activeOptionsLegs = activeOptionsGroup
      ? await manager.getGroupLegs(activeOptionsGroup.id) : [];
    const activeOptionsOrders = activeOptionsGroup
      ? await manager.getGroupOrders(activeOptionsGroup.id) : [];
    const optionProducts = await optionsExecutor.getOptionProducts();
    const futuresSymbols = [...new Set([
      ...futuresPositions.map(row => upper(row.symbol)),
      ...futuresOrders.map(row => upper(row.product_symbol ?? row.symbol))
    ].filter(Boolean))];
    const futuresProducts = await Promise.all(futuresSymbols.map(symbol =>
      futuresExecutor.getProductMetadata(symbol)
    ));

    let gridState = settingsRows[0]?.grid_state ?? getGridState() ?? null;
    if (typeof gridState === 'string') {
      try { gridState = JSON.parse(gridState); } catch { throw new Error('Grid state JSON is malformed'); }
    }
    const capturedAt = now();
    return {
      executionMode: 'testnet',
      capturedAt,
      futuresWallet,
      optionsWallet,
      futuresPositions,
      futuresOrders,
      futuresProducts,
      dbFuturesPositions,
      gridState,
      optionsWalletReconciliation: reconciliation?.status ?? 'UNKNOWN',
      optionsPositions,
      optionsOpenOrders,
      optionProducts,
      activeOptionsGroup,
      activeOptionsLegs,
      activeOptionsOrders
    };
  }

  async function evaluate({ phase = 'RESERVE', candidate = null, groupId = null } = {}) {
    let data;
    try {
      data = await snapshot();
    } catch (error) {
      return {
        allowed: false,
        phase: upper(phase),
        reasons: ['ACCOUNT_RISK_SNAPSHOT_UNAVAILABLE'],
        error: text(error?.message || error).slice(0, 240)
      };
    }
    const limits = getLimits() || {};
    const result = evaluateDeltaOptionsAccountRisk({
      snapshot: data,
      candidate,
      phase,
      groupId,
      limits,
      now: now(),
      maxSnapshotAgeMs
    });
    const expectedSupervisorStatus = data.activeOptionsGroup ? 'RECONCILED' : 'NO_ACTIVE_GROUP';
    if (data.optionsWalletReconciliation !== expectedSupervisorStatus) {
      result.allowed = false;
      result.reasons = [...new Set([...result.reasons, 'OPTIONS_RESTART_RECONCILIATION_NOT_CLEAR'])];
    }
    return result;
  }

  return Object.freeze({ evaluate, snapshot });
}
