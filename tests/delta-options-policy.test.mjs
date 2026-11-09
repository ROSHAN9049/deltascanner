import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseOption } from '../worker/strategy.mjs';
import {
  calculateLongOptionSizing,
  normalizeDeltaOptionTicker,
  parseDeltaOptionSymbol,
  selectOptionContractsForScan
} from '../worker/execution/delta-options-policy.mjs';

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);

test('parses Delta BTC option expiry and settlement time', () => {
  const parsed = parseDeltaOptionSymbol('C-BTC-90000-311026', 'BTC', NOW);
  assert.ok(parsed);
  assert.equal(parsed.optionType, 'CALL');
  assert.equal(parsed.strike, 90000);
  assert.equal(parsed.expiryMs, Date.UTC(2026, 9, 31, 12, 0, 0));
  assert.equal(parsed.dte, 26 / 24);
});

test('rejects unsupported non-BTC/ETH underlyings for Delta India options', () => {
  assert.equal(parseDeltaOptionSymbol('P-XAUT-4000-311026', 'XAUT', NOW), null);
  assert.equal(parseDeltaOptionSymbol('C-SOL-100-311026', 'SOL', NOW), null);
});

test('rejects malformed option symbols, wrong underlyings and invalid calendar dates', () => {
  assert.equal(parseDeltaOptionSymbol('C-BTC-90000-321026', 'BTC', NOW), null);
  assert.equal(parseDeltaOptionSymbol('C-ETH-3000-311026', 'BTC', NOW), null);
  assert.equal(parseDeltaOptionSymbol('BTC-90000-311026', 'BTC', NOW), null);
});

test('bounds the scan chain, balances CALL/PUT contracts and filters DTE/moneyness', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const strike = 90000 + i * 500;
    rows.push({
      symbol: 'C-BTC-' + strike + '-051126',
      mark_price: 100,
      quotes: { best_bid: 99, best_ask: 101 },
      greeks: { delta: 0.55 },
      open_interest: 1000 - i,
      volume: 100
    });
    rows.push({
      symbol: 'P-BTC-' + strike + '-051126',
      mark_price: 100,
      quotes: { best_bid: 99, best_ask: 101 },
      greeks: { delta: -0.55 },
      open_interest: 1000 - i,
      volume: 100
    });
  }
  rows.push({
    symbol: 'C-BTC-90000-011126',
    mark_price: 100,
    quotes: { best_bid: 99, best_ask: 101 }
  });
  rows.push({
    symbol: 'P-BTC-150000-051126',
    mark_price: 100,
    quotes: { best_bid: 99, best_ask: 101 }
  });

  const selected = selectOptionContractsForScan({
    rows,
    underlying: 'BTC',
    spotPrice: 90000,
    now: NOW,
    minDays: 2,
    maxDays: 14,
    maxContracts: 10,
    maxMoneynessPct: 20
  });
  assert.equal(selected.length, 10);
  assert.equal(selected.filter(x => x.symbol.startsWith('C-')).length, 5);
  assert.equal(selected.filter(x => x.symbol.startsWith('P-')).length, 5);
  assert.ok(selected.every(x => x.dte >= 2 && x.dte <= 14));
});

test('sizes long options to whole premium plus fee allowance', () => {
  const sized = calculateLongOptionSizing({
    equity: 10000,
    available: 1000,
    ask: 300,
    contractValue: 0.1,
    takerFeeRate: 0.001,
    riskPct: 0.30
  });
  assert.equal(sized.qty, 0);
  assert.equal(sized.maxLossPerContract, 30.06);
  assert.equal(sized.reason, 'Full-premium risk budget is below one option contract');
});

test('allows one unit when full premium risk is inside 0.30% budget', () => {
  const sized = calculateLongOptionSizing({
    equity: 10000,
    available: 2.01,
    ask: 20,
    contractValue: 0.1,
    takerFeeRate: 0.001,
    riskPct: 0.30
  });
  assert.equal(sized.qty, 1);
  assert.equal(sized.premiumNotional, 2);
  assert.equal(sized.totalRisk, 2.004);
});

test('fails closed when contract value, fee, balance or risk cap is unknown', () => {
  for (const overrides of [
    { contractValue: 0 },
    { takerFeeRate: undefined },
    { available: 0 },
    { riskPct: 0.5 }
  ]) {
    const sized = calculateLongOptionSizing({
      equity: 10000,
      available: 1000,
      ask: 20,
      contractValue: 0.1,
      takerFeeRate: 0.001,
      riskPct: 0.30,
      ...overrides
    });
    assert.equal(sized.qty, 0);
    assert.ok(sized.reason);
  }
});


test('normalizes Delta ticker contract counts and separate USD liquidity values', () => {
  const market = normalizeDeltaOptionTicker({
    oi: '10035',
    oi_value_usd: '750220',
    oi_value_symbol: 'USD',
    volume: '10447',
    turnover_usd: '781640',
    turnover_symbol: 'USD'
  });
  assert.equal(market.oi, 10035);
  assert.equal(market.open_interest, 10035);
  assert.equal(market.volume, 10447);
  assert.equal(market.oi_value_usd, 750220);
  assert.equal(market.turnover_usd, 781640);
});

test('a zero legacy OI field does not mask a positive Delta oi alias', () => {
  const market = normalizeDeltaOptionTicker({
    open_interest: 0,
    oi: '10035',
    volume: 0,
    turnover_usd: '781640'
  });
  assert.equal(market.oi, 10035);
  assert.equal(market.volume, 0);
  assert.equal(market.turnover_usd, 781640);
});

test('sub-day expiry contracts can be retained for cache diagnostics without changing execution DTE settings', () => {
  const rows = [{
    symbol: 'C-BTC-90000-301026',
    mark_price: 100,
    quotes: { best_bid: 99, best_ask: 101 },
    greeks: { delta: 0.55 },
    oi: '100',
    oi_value_usd: '750220',
    volume: '10',
    turnover_usd: '781640'
  }];
  const selected = selectOptionContractsForScan({
    rows,
    underlying: 'BTC',
    spotPrice: 90000,
    now: NOW,
    minDays: 0,
    maxDays: 14,
    maxContracts: 10,
    maxMoneynessPct: 20
  });
  assert.equal(selected.length, 1);
  assert.ok(selected[0].dte > 0 && selected[0].dte < 1);
  // The production execution rule remains a separate >=2 DTE analysis gate.
  assert.ok(selected[0].dte < 2);
});


test('sub-day expiry rows remain blocked by the configured two-day execution minimum', () => {
  const expiryDate = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const dd = String(expiryDate.getUTCDate()).padStart(2, '0');
  const mm = String(expiryDate.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(expiryDate.getUTCFullYear()).slice(-2);
  const ticker = {
    symbol: 'C-BTC-90000-' + dd + mm + yy,
    contract_type: 'call_options',
    mark_price: 100,
    quotes: { best_bid: 99, best_ask: 101 },
    oi: '100',
    oi_value_usd: '750220',
    volume: '10',
    turnover_usd: '781640',
    greeks: { delta: '0.55' }
  };
  const underlying = {
    symbol: 'BTCUSD',
    side: 'BUY',
    stage: 'CONFIRMED',
    score: 90,
    normalizedScore: 90,
    change: 0
  };
  const signal = analyseOption(ticker, underlying, 'OPTIONS_BUY', {
    minDays: 2,
    maxDays: 14,
    minOi: 50,
    minVolume: 1,
    maxSpreadPct: 1.5,
    buyMinDelta: 0.45,
    buyMaxDelta: 0.65,
    scoreMin: 80
  });
  assert.ok(signal.dte > 0 && signal.dte < 1);
  assert.ok(signal.blocked.includes('Expiry outside configured DTE'));
  assert.ok(signal.blocked.includes('Expiry below 0.5 days; gamma risk'));
  assert.equal(signal.ready, false);
  assert.notEqual(signal.stage, 'CONFIRMED');
});
