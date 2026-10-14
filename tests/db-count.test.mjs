import test from 'node:test';
import assert from 'node:assert/strict';
import { exactCountFromResponse } from '../server/db.js';

test('reads an exact total from Supabase Content-Range', () => {
  assert.equal(exactCountFromResponse('0-0/0'), 0);
  assert.equal(exactCountFromResponse('*/0'), 0);
  assert.equal(exactCountFromResponse('0-0/1'), 1);
  assert.equal(exactCountFromResponse('0-0/200'), 200);
});

test('unknown or malformed Content-Range remains unknown', () => {
  assert.equal(exactCountFromResponse(null), null);
  assert.equal(exactCountFromResponse(''), null);
  assert.equal(exactCountFromResponse('0-0/*'), null);
  assert.equal(exactCountFromResponse('*/12'), null);
  assert.equal(exactCountFromResponse('0-0/1.5'), null);
  assert.equal(exactCountFromResponse('0-0/-1'), null);
  assert.equal(exactCountFromResponse('0-0/NaN'), null);
});
