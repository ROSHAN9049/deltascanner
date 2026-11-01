import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ENGINE_SECRET = 'session-test-secret';
process.env.VERCEL_ENV = 'production';

const { default: handler } = await import('../api/engine/session.js?engine-session-test');
const { ENGINE_SESSION_TTL_SECONDS, createEngineSessionCookie, isEngineSessionValid } = await import('../server/engine-session.js');

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; }
  };
}

const sameOriginHeaders = { origin: 'https://scanner.test', host: 'scanner.test' };

test('session endpoint establishes an HttpOnly, secure, expiring cookie without returning the secret', async () => {
  const res = makeResponse();
  await handler({
    method: 'POST',
    headers: sameOriginHeaders,
    body: { secret: 'session-test-secret' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.authenticated, true);
  assert.equal(JSON.stringify(res.payload).includes('session-test-secret'), false);
  const cookie = res.headers['set-cookie'];
  assert.match(cookie, /^dd_engine_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Max-Age=604800/);
  assert.equal(cookie.includes('session-test-secret'), false);

  const req = { headers: { cookie: cookie.split(';')[0] } };
  assert.equal(isEngineSessionValid(req, 'session-test-secret'), true);
  assert.equal(isEngineSessionValid(req, 'different-secret'), false);
});

test('invalid secrets and cross-origin session creation are rejected', async () => {
  const invalidSecret = makeResponse();
  await handler({
    method: 'POST',
    headers: sameOriginHeaders,
    body: { secret: 'wrong-secret' }
  }, invalidSecret);
  assert.equal(invalidSecret.statusCode, 401);
  assert.equal(invalidSecret.payload.success, false);
  assert.equal('set-cookie' in invalidSecret.headers, false);

  const crossOrigin = makeResponse();
  await handler({
    method: 'POST',
    headers: { origin: 'https://attacker.test', host: 'scanner.test' },
    body: { secret: 'session-test-secret' }
  }, crossOrigin);
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal('set-cookie' in crossOrigin.headers, false);
});


test('allows session creation from the exact configured Hostless Site origin', async () => {
  const previous = process.env.APP_ALLOWED_ORIGINS;
  process.env.APP_ALLOWED_ORIGINS = 'https://deltascanner-dashboard.hostless.site';

  try {
    const res = makeResponse();
    await handler({
      method: 'POST',
      headers: {
        origin: 'https://deltascanner-dashboard.hostless.site',
        host: 'deltascanner-api-v2.hostless.app'
      },
      body: { secret: 'session-test-secret' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.match(res.headers['set-cookie'], /SameSite=None/);
    assert.match(res.headers['set-cookie'], /Secure/);
  } finally {
    if (previous === undefined) {
      delete process.env.APP_ALLOWED_ORIGINS;
    } else {
      process.env.APP_ALLOWED_ORIGINS = previous;
    }
  }
});

test('session status and logout do not reveal the original secret', async () => {
  const login = makeResponse();
  await handler({
    method: 'POST',
    headers: sameOriginHeaders,
    body: { secret: 'session-test-secret' }
  }, login);
  const cookie = login.headers['set-cookie'].split(';')[0];

  const status = makeResponse();
  await handler({ method: 'GET', headers: { cookie } }, status);
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.authenticated, true);
  assert.equal(JSON.stringify(status.payload).includes('session-test-secret'), false);

  const logout = makeResponse();
  await handler({ method: 'DELETE', headers: { ...sameOriginHeaders, cookie } }, logout);
  assert.equal(logout.statusCode, 200);
  assert.equal(logout.payload.authenticated, false);
  assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  assert.match(logout.headers['set-cookie'], /SameSite=None/);
  assert.match(logout.headers['set-cookie'], /Secure/);

  const afterLogout = makeResponse();
  await handler({ method: 'GET', headers: { cookie: logout.headers['set-cookie'].split(';')[0] } }, afterLogout);
  assert.equal(afterLogout.payload.authenticated, false);
});

test('malformed, expired, and tampered session cookies fail closed', () => {
  assert.equal(isEngineSessionValid({ headers: { cookie: 'dd_engine_session=malformed' } }, 'session-test-secret'), false);
  const expiredCookie = createEngineSessionCookie('session-test-secret', {
    now: Date.now() - (ENGINE_SESSION_TTL_SECONDS + 60) * 1000,
    production: false
  }).split(';')[0];
  assert.equal(isEngineSessionValid({ headers: { cookie: expiredCookie } }, 'session-test-secret'), false);

  const future = Math.floor(Date.now() / 1000) + 60;
  assert.equal(isEngineSessionValid({
    headers: { cookie: 'dd_engine_session=' + future + '.not-a-valid-signature' }
  }, 'session-test-secret'), false);
});
