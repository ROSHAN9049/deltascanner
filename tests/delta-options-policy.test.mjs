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


test('bounded option scan retains long, short-leg and protective-wing delta buckets', () => {
  const rows = [];
  for (const optionType of ['C', 'P']) {
    for (const [delta, strike] of [[0.55, 90000], [0.27, 91000], [0.10, 92000]]) {
      rows.push({
        symbol: optionType + '-BTC-' + strike + '-051126',
        mark_price: 100,
        quotes: { best_bid: 99, best_ask: 101 },
        greeks: { delta: optionType === 'C' ? delta : -delta },
        open_interest: 1000,
        volume: 100
      });
    }
  }

  const selected = selectOptionContractsForScan({
    rows,
    underlying: 'BTC',
    spotPrice: 90000,
    now: NOW,
    minDays: 2,
    maxDays: 14,
    maxContracts: 6,
    maxMoneynessPct: 20
  });
  assert.equal(selected.length, 6);
  for (const optionType of ['C', 'P']) {
    const deltas = selected
      .filter(row => row.symbol.startsWith(optionType + '-'))
      .map(row => Math.abs(Number(row.greeks.delta)))
      .sort((a, b) => a - b);
    assert.deepEqual(deltas, [0.10, 0.27, 0.55]);
  }
});

test('sizes a defined-risk credit spread using both multipliers and fee reserves', () => {
  const sized = calculateCreditSpreadSizing({
    equity: 10000,
    available: 5000,
    shortBid: 240,
    hedgeAsk: 80,
    shortStrike: 90000,
    hedgeStrike: 88000,
    shortContractValue: 0.001,
    hedgeContractValue: 0.001,
    shortTakerFeeRate: 0.001,
    hedgeTakerFeeRate: 0.001,
    riskPct: 0.30
  });
  assert.equal(sized.qty, 16);
  assert.equal(sized.netCreditPerContract, 0.16);
  assert.equal(sized.spreadWidthPerContract, 2);
  assert.ok(sized.maxLossPerContract > 1.84);
  assert.equal(sized.totalRisk, sized.qty * sized.maxLossPerContract);
  assert.equal(sized.totalMarginReserve, sized.qty * sized.marginReservePerContract);
});

test('credit spread sizing fails closed for mismatched multipliers, unknown fees, no credit or excess risk', () => {
  const base = {
    equity: 10000,
    available: 5000,
    shortBid: 240,
    hedgeAsk: 80,
    shortStrike: 90000,
    hedgeStrike: 88000,
    shortContractValue: 0.001,
    hedgeContractValue: 0.001,
    shortTakerFeeRate: 0.001,
    hedgeTakerFeeRate: 0.001,
    riskPct: 0.30
  };
  for (const overrides of [
    { hedgeContractValue: 0.01 },
    { hedgeTakerFeeRate: undefined },
    { shortBid: 70 },
    { riskPct: 0.5 },
    { available: 0 }
  ]) {
    const sized = calculateCreditSpreadSizing({ ...base, ...overrides });
    assert.equal(sized.qty, 0);
    assert.ok(sized.reason);
  }
});

test('credit spread size is limited by the full-width available-balance reserve', () => {
  const sized = calculateCreditSpreadSizing({
    equity: 10000,
    available: 2,
    shortBid: 240,
    hedgeAsk: 80,
    shortStrike: 90000,
    hedgeStrike: 88000,
    shortContractValue: 0.001,
    hedgeContractValue: 0.001,
    shortTakerFeeRate: 0.001,
    hedgeTakerFeeRate: 0.001,
    riskPct: 0.30
  });
  assert.equal(sized.qty, 0);
  assert.match(sized.reason, /full-width credit-spread reserve/);
});
