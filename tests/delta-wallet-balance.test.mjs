import test from 'node:test';
import assert from 'node:assert/strict';
import { accountEquity, accountAvailable, accountAvailableVerified } from '../worker/execution/delta-wallet-balance.mjs';

test('Delta wallet envelope reads net equity and USD perpetual available balance', () => {
  const wallet = {
    success: true,
    meta: { net_equity: '40729.85' },
    result: [
      { asset_symbol: 'USD', balance: '1000.00', available_balance: '842.51' },
      { asset_symbol: 'USDT', balance: '39887.34', available_balance: '39887.34' }
    ]
  };
  assert.equal(accountEquity(wallet), 40729.85);
  assert.equal(accountAvailable(wallet), 842.51);
  assert.equal(accountAvailableVerified(wallet), 842.51);
});

test('wallet parser accepts an unwrapped result array and excludes non-USD spot assets from futures margin', () => {
  const wallet = [
    { asset_symbol: 'USD', balance: '1200', available_balance: '842.51' },
    { asset_symbol: 'USDT', balance: '39887.34', available_balance: '39887.34' }
  ];
  assert.equal(accountEquity(wallet), 1200);
  assert.equal(accountAvailable(wallet), 842.51);
});

test('missing USD wallet does not fall back to total account equity as available margin', () => {
  const wallet = { meta: { net_equity: '40729.85' }, result: [
    { asset_symbol: 'USDT', balance: '39887.34', available_balance: '39887.34' }
  ] };
  assert.equal(accountEquity(wallet), 40729.85);
  assert.equal(accountAvailable(wallet), null);
  assert.equal(accountAvailableVerified(wallet), null);
});

test('zero or malformed USD wallet values remain unavailable', () => {
  const wallet = { result: [{ asset_symbol: 'USD', balance: '0', available_balance: null }] };
  assert.equal(accountEquity(wallet), null);
  assert.equal(accountAvailable(wallet), null);
});
