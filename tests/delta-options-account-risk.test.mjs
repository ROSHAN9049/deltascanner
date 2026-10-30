import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeltaOptionsAccountRisk } from '../worker/execution/delta-options-account-risk.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const LIMITS = {
  maxCombinedOpenRiskPct: 10,
  minimumAvailableBufferPct: 10
};
const candidate = {
  client_group_id: 'new-options-group-123',
  settlement_asset: 'USD',
  max_loss_usd: 30,
  reserved_margin_usd: 40
};
const wallet = (overrides = {}) => ({
  meta: { user_id: 77 },
  result: [{
    user_id: 77,
    asset_symbol: 'USD',
    balance: '1000',
    available_balance: '800',
    blocked_margin: '200',
    unrealized_pnl: '500',
    ...overrides
  }]
});
function baseSnapshot(overrides = {}) {
  return {
    executionMode: 'testnet',
    capturedAt: NOW,
    futuresWallet: wallet(),
    optionsWallet: wallet(),
    futuresPositions: [],
    dbFuturesPositions: [],
    futuresProducts: [],
    futuresOrders: [],
    gridState: { positions: [], openRiskUsd: 0 },
    optionsWalletReconciliation: 'NO_ACTIVE_GROUP',
    optionsPositions: [],
    optionsOpenOrders: [],
    optionProducts: [],
    activeOptionsGroup: null,
    activeOptionsLegs: [],
    activeOptionsOrders: [],
    ...overrides
  };
}
function evaluate(overrides = {}, args = {}) {
  return evaluateDeltaOptionsAccountRisk({
    snapshot: baseSnapshot(overrides),
    candidate,
    limits: LIMITS,
    now: NOW,
    ...args
  });
}

test('allows a verified USD-settled reservation within combined risk and free-cash limits', () => {
  const result = evaluate();
  assert.equal(result.allowed, true);
  assert.equal(result.settlementAsset, 'USD');
  assert.equal(result.userId, '77');
  assert.equal(result.accountBalance, 1000);
  assert.equal(result.availableBalance, 800);
  assert.equal(result.projectedOpenRisk, 30);
  assert.equal(result.maxCombinedOpenRisk, 100);
  assert.equal(result.reservedMarginRequired, 40);
});

test('does not add unrealized P&L to option-buy collateral', () => {
  const result = evaluate({
    futuresWallet: wallet({ unrealized_pnl: '9000', available_balance: '20', blocked_margin: '980' }),
    optionsWallet: wallet({ unrealized_pnl: '9000', available_balance: '20', blocked_margin: '980' })
  });
  assert.equal(result.allowed, false);
  assert.equal(result.availableBalance, 20);
  assert.ok(result.reasons.includes('INSUFFICIENT_SETTLEMENT_ASSET_AVAILABLE_BALANCE_AFTER_RESERVE'));
});

test('blocks different wallet account identities and missing asset rows', () => {
  const differentUser = wallet();
  differentUser.meta.user_id = 88;
  differentUser.result[0].user_id = 88;
  const mismatch = evaluate({ optionsWallet: differentUser });
  assert.equal(mismatch.allowed, false);
  assert.ok(mismatch.reasons.includes('OPTIONS_AND_FUTURES_API_KEYS_BELONG_TO_DIFFERENT_ACCOUNTS'));

  const missing = evaluate({ optionsWallet: { meta: { user_id: 77 }, result: [] } });
  assert.equal(missing.allowed, false);
  assert.ok(missing.reasons.includes('OPTIONS_WALLET_SETTLEMENT_ASSET_WALLET_MISSING'));
});

test('blocks stale snapshots, wrong mode, and unverified settlement currency', () => {
  assert.ok(evaluate({}, { now: NOW + 31_000 }).reasons.includes('ACCOUNT_RISK_SNAPSHOT_STALE_OR_INVALID'));
  assert.ok(evaluate({ executionMode: 'live' }).reasons.includes('TESTNET_MODE_REQUIRED'));
  assert.ok(evaluate({}, { candidate: { ...candidate, settlement_asset: 'USDT' } })
    .reasons.includes('OPTIONS_SETTLEMENT_ASSET_NOT_VERIFIED_AS_USD'));
});

test('requires explicit combined-risk cap and available-balance buffer limits', () => {
  const result = evaluate({}, { limits: {} });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('MAX_COMBINED_OPEN_RISK_LIMIT_NOT_CONFIGURED'));
  assert.ok(result.reasons.includes('MINIMUM_AVAILABLE_BALANCE_BUFFER_NOT_CONFIGURED'));
});

test('blocks candidate maximum loss beyond the account-wide risk cap', () => {
  const result = evaluate({}, {
    candidate: { ...candidate, max_loss_usd: 150 }
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('COMBINED_OPEN_MAX_LOSS_EXCEEDS_OR_CANNOT_VERIFY_RISK_CAP'));
});

test('counts existing Futures stop-loss risk and blocks a missing/unverified stop', () => {
  const futuresPositions = [{
    symbol: 'BTCUSD', product_id: 10, side: 'BUY', qty: 2,
    entry_price: 100, sl_price: 90
  }];
  const dbFuturesPositions = [{
    symbol: 'BTCUSD', product_id: 10, side: 'BUY', qty: 2,
    entry_price: 100, sl_price: 90, strategy: 'MOMENTUM'
  }];
  const futuresProducts = [{
    id: 10, symbol: 'BTCUSD', contract_value: 1, tick_size: 0.5,
    settling_asset: { symbol: 'USD' }
  }];
  const snapshot = { futuresPositions, dbFuturesPositions, futuresProducts };
  const result = evaluate(snapshot);
  assert.equal(result.allowed, true);
  assert.equal(result.currentOpenRisk, 20);
  assert.equal(result.projectedOpenRisk, 50);

  const missingStop = evaluate({
    ...snapshot,
    futuresPositions: futuresPositions.map(row => ({ ...row, sl_price: null }))
  });
  assert.equal(missingStop.allowed, false);
  assert.ok(missingStop.reasons.some(reason => reason.startsWith('FUTURES_POSITION_RISK_OR_PROTECTION_UNVERIFIED')));
});

test('blocks cross-settlement Futures exposure instead of applying an FX conversion', () => {
  const result = evaluate({
    futuresPositions: [{
      symbol: 'BTCUSD', product_id: 10, side: 'BUY', qty: 1,
      entry_price: 100, sl_price: 90
    }],
    dbFuturesPositions: [{
      symbol: 'BTCUSD', product_id: 10, side: 'BUY', qty: 1,
      entry_price: 100, sl_price: 90, strategy: 'MOMENTUM'
    }],
    futuresProducts: [{
      id: 10, symbol: 'BTCUSD', contract_value: 1, tick_size: 0.5,
      settling_asset: { symbol: 'INR' }
    }]
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('CROSS_SETTLEMENT_EXPOSURE_NOT_NETTABLE:BTCUSD:INR'));
});

test('blocks untracked Futures positions and pending non-reduce-only Futures orders', () => {
  const position = {
    symbol: 'BTCUSD', product_id: 10, side: 'BUY', qty: 1,
    entry_price: 100, sl_price: 90
  };
  const product = {
    id: 10, symbol: 'BTCUSD', contract_value: 1, tick_size: 0.5,
    settling_asset: { symbol: 'USD' }
  };
  const untracked = evaluate({
    futuresPositions: [position],
    dbFuturesPositions: [],
    futuresProducts: [product]
  });
  assert.ok(untracked.reasons.includes('FUTURES_EXCHANGE_DATABASE_POSITION_MISMATCH'));

  const pendingEntry = evaluate({
    futuresOrders: [{ product_symbol: 'BTCUSD', reduce_only: false }],
    futuresProducts: [product]
  });
  assert.ok(pendingEntry.reasons.includes('FUTURES_NON_REDUCE_ONLY_ORDER_PENDING:BTCUSD'));
});

test('checks Grid state against exchange/DB exposure without double-counting Grid risk', () => {
  const position = {
    symbol: 'ETHUSD', product_id: 20, side: 'BUY', qty: 2,
    entry_price: 100, sl_price: 90
  };
  const dbRow = { ...position, strategy: 'GRID' };
  const product = {
    id: 20, symbol: 'ETHUSD', contract_value: 1, tick_size: 0.5,
    settling_asset: { symbol: 'USD' }, taker_commission_rate: 0, maker_commission_rate: 0
  };
  const mismatch = evaluate({
    futuresPositions: [position],
    dbFuturesPositions: [dbRow],
    futuresProducts: [product],
    gridState: { positions: [{ symbol: 'ETHUSD', qty: 2, riskUsd: 20.08 }], openRiskUsd: 19 }
  });
  assert.ok(mismatch.reasons.includes('GRID_STATE_AND_EXCHANGE_RISK_MISMATCH'));

  const matched = evaluate({
    futuresPositions: [position],
    dbFuturesPositions: [dbRow],
    futuresProducts: [product],
    gridState: { positions: [{ symbol: 'ETHUSD', qty: 2, riskUsd: 20.08 }], openRiskUsd: 20.08 }
  });
  assert.equal(matched.currentOpenRisk, 20);
  assert.equal(matched.allowed, true);
});

test('blocks orphan Options exposure, open orders, and pending ledger attempts', () => {
  const optionPosition = {
    symbol: 'C-BTC-90000-311026', product_id: 30, side: 'BUY', qty: 1
  };
  const orphan = evaluate({ optionsPositions: [optionPosition] });
  assert.ok(orphan.reasons.includes('ORPHAN_OPTIONS_EXCHANGE_OR_LEDGER_EXPOSURE'));

  const activeGroup = {
    id: 'group-123', client_group_id: 'existing-group-123',
    state: 'OPEN', settlement_asset: 'USD',
    max_loss_usd: 10, reserved_margin_usd: 12
  };
  const leg = {
    symbol: optionPosition.symbol, product_id: 30, side: 'BUY',
    filled_qty: 1, exit_filled_qty: 0
  };
  const product = {
    id: 30, symbol: optionPosition.symbol,
    settling_asset: { symbol: 'USD' }
  };
  const openOrder = evaluate({
    activeOptionsGroup: activeGroup,
    activeOptionsLegs: [leg],
    activeOptionsOrders: [{ order_state: 'FILLED' }],
    optionProducts: [product],
    optionsPositions: [optionPosition],
    optionsOpenOrders: [{ client_order_id: 'pending' }],
    optionsWalletReconciliation: 'RECONCILED'
  }, { phase: 'ORDER', groupId: 'group-123', candidate: { ...candidate, client_group_id: 'existing-group-123' } });
  assert.ok(openOrder.reasons.includes('OPTIONS_ORDER_PENDING_REQUIRES_RECONCILIATION'));
});

test('allows a same-group ENTRY recheck only after options positions and durable ledger reconcile', () => {
  const optionPosition = {
    symbol: 'C-BTC-90000-311026', product_id: 30, side: 'BUY', qty: 1
  };
  const result = evaluate({
    activeOptionsGroup: {
      id: 'group-123', client_group_id: 'existing-group-123',
      state: 'OPEN', settlement_asset: 'USD',
      max_loss_usd: 10, reserved_margin_usd: 12
    },
    activeOptionsLegs: [{
      symbol: optionPosition.symbol, product_id: 30, side: 'BUY',
      filled_qty: 1, exit_filled_qty: 0
    }],
    activeOptionsOrders: [{ order_state: 'FILLED' }],
    optionProducts: [{
      id: 30, symbol: optionPosition.symbol,
      settling_asset: { symbol: 'USD' }
    }],
    optionsPositions: [optionPosition],
    optionsWalletReconciliation: 'RECONCILED'
  }, {
    phase: 'ORDER',
    groupId: 'group-123',
    candidate: { ...candidate, client_group_id: 'existing-group-123' }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.currentOpenRisk, 10);
});
