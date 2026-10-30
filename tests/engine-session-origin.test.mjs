import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from '../server/engine-session.js';

test('session mutations allow only an explicitly configured Hostless Site origin', () => {
  const previous = process.env.APP_ALLOWED_ORIGINS;
  process.env.APP_ALLOWED_ORIGINS = 'https://dashboard.hostless.example';
  try {
    assert.equal(isSameOriginRequest({ headers: { origin: 'https://dashboard.hostless.example', host: 'dealdost-api.hostless.example' } }), true);
    assert.equal(isSameOriginRequest({ headers: { origin: 'https://attacker.example', host: 'dealdost-api.hostless.example' } }), false);
  } finally {
    if (previous === undefined) delete process.env.APP_ALLOWED_ORIGINS;
    else process.env.APP_ALLOWED_ORIGINS = previous;
  }
});
