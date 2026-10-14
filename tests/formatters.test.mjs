import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeNum,
  fmtMultiplier,
  fmtRsi,
  fmtPrice,
  fmtMoney,
  assessDeltaRange
} from '../src/formatters.js';

test('safeNum distinguishes missing values from real zero', () => {
  assert.equal(safeNum(null), null);
  assert.equal(safeNum(undefined), null);
  assert.equal(safeNum(''), null);
  assert.equal(safeNum('   '), null);
  assert.equal(safeNum('not a number'), null);
  assert.equal(safeNum(0), 0);
  assert.equal(safeNum('0'), 0);
  assert.equal(safeNum(0.042), 0.042);
});

test('multiplier and RSI formatters preserve missing values', () => {
  assert.equal(fmtMultiplier(null), '—');
  assert.equal(fmtMultiplier(undefined), '—');
  assert.equal(fmtMultiplier(''), '—');
  assert.equal(fmtMultiplier(0), '0.00x');
  assert.equal(fmtMultiplier('1.5'), '1.50x');
  assert.equal(fmtRsi(null), '—');
  assert.equal(fmtRsi(0), '0.0');
  assert.equal(fmtRsi(51.25), '51.3');
  assert.equal(fmtPrice(null), '—');
});

test('unverified financial data has no assumed currency', () => {
  const result = fmtMoney(1234.56, null, 'TRADETRON_WEBHOOK', false);
  assert.equal(result.verified, false);
  assert.equal(result.currency, 'UNIT UNVERIFIED');
  assert.equal(result.source, 'TRADETRON_WEBHOOK');
  assert.equal(result.amount, 1234.56);
  assert.match(result.text, /unit unverified/);
});

test('Delta assessment distinguishes missing, invalid, zero and out-of-range values', () => {
  assert.equal(assessDeltaRange(null, 0.45, 0.65).status, 'MISSING');
  assert.equal(assessDeltaRange('bad', 0.45, 0.65).status, 'INVALID');
  assert.equal(assessDeltaRange(0, 0.45, 0.65).status, 'OUTSIDE_RANGE');
  assert.equal(assessDeltaRange(-0.5, 0.45, 0.65).status, 'IN_RANGE');
  assert.equal(assessDeltaRange(0.7, 0.45, 0.65).status, 'OUTSIDE_RANGE');
});
