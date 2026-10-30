import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLongOptionSizing,
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

test('parses XAUT option expiry using Gold settlement time', () => {
  const parsed = parseDeltaOptionSymbol('P-XAUT-4000-311026', 'XAUT', NOW);
  assert.equal(parsed.expiryMs, Date.UTC(2026, 9, 31, 16, 0, 0));
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
    ask: 100,
    contractValue: 0.1,
    takerFeeRate: 0.001,
    riskPct: 0.30
  });
  assert.equal(sized.qty, 0);
  assert.equal(sized.maxLossPerContract, 10.02);
  assert.equal(sized.reason, 'Full-premium risk budget is below one option contract');
});

test('allows one unit when full premium risk is inside 0.30% budget', () => {
  const sized = calculateLongOptionSizing({
    equity: 10000,
    available: 1000,
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
