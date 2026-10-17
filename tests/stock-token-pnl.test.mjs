import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_TOKEN_SYMBOLS,
  contractValueForSymbol,
  stockTokenPnlTooltip,
  stockTokenOpenPnlTooltip
} from '../src/stock-token-pnl.js';

test('the approved stock-token symbol allowlist contains SNDKBUSD and other listed equity tokens', () => {
  assert.equal(STOCK_TOKEN_SYMBOLS.has('SNDKBUSD'), true);
  assert.equal(STOCK_TOKEN_SYMBOLS.has('AMDBUSD'), true);
  assert.equal(STOCK_TOKEN_SYMBOLS.has('KORUBUSD'), true);
  assert.equal(STOCK_TOKEN_SYMBOLS.has('BTCUSD'), false);
});

test('looks up contract_value by case-insensitive symbol without mutating displayed P&L', () => {
  const marketCache = [
    { symbol: 'SNDKBUSD', contract_value: '0.01' },
    { symbol: 'BTCUSD', contract_value: '0.001' }
  ];
  assert.equal(contractValueForSymbol(marketCache, 'sndkbusd'), 0.01);
  assert.equal(contractValueForSymbol(marketCache, 'missing'), null);

  const rawPnl = 3884.64;
  const tooltip = stockTokenPnlTooltip('SNDKBUSD', rawPnl, contractValueForSymbol(marketCache, 'SNDKBUSD'));
  assert.match(tooltip, /Raw API field: 3884\.64 USD/);
  assert.match(tooltip, /Delta contract_value: 0\.01/);
  assert.match(tooltip, /Possible adjusted value: \$38\.85/);
  assert.match(tooltip, /HYPOTHESIS/);
  assert.equal(rawPnl, 3884.64);
});

test('does not add the stock-token hypothesis tooltip to unrelated symbols', () => {
  assert.equal(stockTokenPnlTooltip('BTCUSD', 12, 0.001), null);
});

test('states when a stock-token contract_value is unavailable instead of fabricating an adjusted value', () => {
  const tooltip = stockTokenPnlTooltip('SNDKBUSD', 100, null);
  assert.match(tooltip, /contract_value: unavailable/);
  assert.match(tooltip, /cannot be calculated/);
  assert.match(tooltip, /HYPOTHESIS/);
});

test('aggregate tooltip keeps raw open P&L unchanged and computes a separate stock-token-only hypothesis', () => {
  const rawRows = [
    { symbol: 'SNDKBUSD', pnl: 100 },
    { symbol: 'AMDBUSD', pnl: -50 },
    { symbol: 'BTCUSD', pnl: 20 }
  ];
  const marketCache = [
    { symbol: 'SNDKBUSD', contract_value: 0.01 },
    { symbol: 'AMDBUSD', contract_value: 0.01 },
    { symbol: 'BTCUSD', contract_value: 0.001 }
  ];
  const tooltip = stockTokenOpenPnlTooltip(rawRows, marketCache, 70);
  assert.match(tooltip, /remains 70 and is not changed/);
  assert.match(tooltip, /Possible stock-token adjusted subtotal: \$0\.50/);
  assert.match(tooltip, /HYPOTHESIS only/);
});
