import test from 'node:test';
import assert from 'node:assert/strict';
import { indiaDateKey, isSameIndiaDate } from '../src/date-utils.js';

test('India date key follows Asia/Kolkata across UTC midnight', () => {
  assert.equal(indiaDateKey('2026-10-13T20:00:00.000Z'), '2026-10-14');
  assert.equal(indiaDateKey('2026-10-14T00:00:00.000Z'), '2026-10-14');
  assert.equal(indiaDateKey('2026-10-14T18:30:00.000Z'), '2026-10-15');
});

test('invalid timestamps remain unknown instead of becoming a date', () => {
  assert.equal(indiaDateKey('not-a-date'), null);
  assert.equal(isSameIndiaDate('not-a-date', '2026-10-14T00:00:00Z'), false);
});

test('same-day comparisons use the India calendar day', () => {
  assert.equal(isSameIndiaDate('2026-10-13T20:00:00.000Z', '2026-10-14T03:00:00.000Z'), true);
  assert.equal(isSameIndiaDate('2026-10-13T18:29:59.000Z', '2026-10-14T03:00:00.000Z'), false);
});
