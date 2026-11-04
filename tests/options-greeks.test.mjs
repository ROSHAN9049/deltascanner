import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasOptionDelta,
  hydrateOptionTickersWithGreeks,
  optionGreeksFromTicker
} from '../worker/options-greeks.mjs';

test('reads nested Delta Greeks and preserves signed values and zero', () => {
  assert.deepEqual(optionGreeksFromTicker({
    greeks: { delta: '-0.55', gamma: '0.01', theta: '-0.2', vega: '3.5', rho: 0 }
  }), {
    delta: -0.55, gamma: 0.01, theta: -0.2, vega: 3.5, rho: 0
  });
  assert.equal(hasOptionDelta({ greeks: { delta: 0 } }), true);
});

test('parses serialized Greeks and falls back to top-level Delta only when needed', () => {
  assert.equal(optionGreeksFromTicker({
    greeks: JSON.stringify({ delta: '0.48' })
  }).delta, 0.48);
  assert.equal(optionGreeksFromTicker({ delta: '-0.25' }).delta, -0.25);
  assert.equal(hasOptionDelta({ greeks: '{}' }), false);
});

test('hydrates only missing Greeks using the exact-symbol ticker and preserves Testnet product metadata', async () => {
  const rows = [
    { symbol: 'C-BTC-80000-311226', product_id: 181001, greeks: null },
    { symbol: 'P-BTC-75000-311226', product_id: 181002, greeks: { delta: '-0.22' } }
  ];
  const calls = [];
  const result = await hydrateOptionTickersWithGreeks(rows, async symbol => {
    calls.push(symbol);
    return {
      symbol,
      product_id: 999999,
      greeks: JSON.stringify({ delta: '0.55', gamma: '0.02' })
    };
  }, 2);

  assert.deepEqual(calls, ['C-BTC-80000-311226']);
  assert.equal(result.attempted, 1);
  assert.equal(result.enriched, 1);
  assert.deepEqual(result.missingSymbols, []);
  assert.equal(result.rows[0].product_id, 181001);
  assert.equal(result.rows[0].greeks.delta, 0.55);
  assert.equal(result.rows[0].greeks.gamma, 0.02);
  assert.equal(optionGreeksFromTicker(result.rows[1]).delta, -0.22);
});

test('does not attach Greeks from a mismatched single-contract response', async () => {
  const result = await hydrateOptionTickersWithGreeks([
    { symbol: 'C-ETH-3000-311226', product_id: 182001 }
  ], async () => ({
    symbol: 'C-ETH-3100-311226',
    greeks: { delta: '0.50' }
  }));

  assert.deepEqual(result.missingSymbols, ['C-ETH-3000-311226']);
  assert.equal(result.enriched, 0);
  assert.equal(result.errors.length, 1);
});
