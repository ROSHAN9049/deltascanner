import test from 'node:test';
import assert from 'node:assert/strict';
import { runOptionsDemoCredentialDiagnostic } from '../worker/options-demo-diagnostics.mjs';

const DEMO_ENV = {
  OPTIONS_EXECUTION_MODE: 'demo',
  DELTA_EXECUTION_MODE: 'testnet',
  DELTA_ENVIRONMENT: 'TESTNET',
  DELTA_TESTNET_REST_BASE: 'https://cdn-ind.testnet.deltaex.org',
  DELTA_DEMO_API_KEY: 'demo-key-1234567890',
  DELTA_DEMO_API_SECRET: 'demo-secret-1234567890'
};

test('Demo credential diagnostic records only non-secret metadata and verifies signed auth', async () => {
  const requests = [];
  const logs = [];
  const result = await runOptionsDemoCredentialDiagnostic({
    env: DEMO_ENV,
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (String(url).includes('api.ipify.org')) {
        return { ok: true, status: 200, async text() { return JSON.stringify({ ip: '203.0.113.10' }); } };
      }
      return { ok: true, status: 200, async text() { return JSON.stringify({ success: true, result: [] }); } };
    },
    logger: async (...args) => logs.push(args)
  });

  assert.equal(result.demoApiKeyConfigured, true);
  assert.equal(result.demoApiSecretConfigured, true);
  assert.equal(result.keyBasicFormatValid, true);
  assert.equal(result.secretBasicFormatValid, true);
  assert.equal(result.outboundIp, '203.0.113.10');
  assert.equal(result.signedAuthHttpStatus, 200);
  assert.equal(result.signedAuthPassed, true);
  assert.equal(result.deltaErrorCode, null);
  assert.equal(requests.length, 2);
  assert.ok(requests.some(row => row.url === 'https://cdn-ind.testnet.deltaex.org/v2/wallet/balances'));
  const logText = JSON.stringify(logs);
  assert.equal(logText.includes(DEMO_ENV.DELTA_DEMO_API_KEY), false);
  assert.equal(logText.includes(DEMO_ENV.DELTA_DEMO_API_SECRET), false);
  assert.equal(logText.includes('signature'), false);
});

test('Demo credential diagnostic reports exact Delta error code and HTTP status', async () => {
  const result = await runOptionsDemoCredentialDiagnostic({
    env: DEMO_ENV,
    fetchImpl: async url => String(url).includes('api.ipify.org')
      ? { ok: true, status: 200, async text() { return '{"ip":"203.0.113.10"}'; } }
      : { ok: false, status: 403, async text() { return JSON.stringify({ success: false, error: { code: 'ip_not_whitelisted_for_api_key', message: 'IP is not whitelisted' } }); } },
    logger: async () => {}
  });
  assert.equal(result.signedAuthHttpStatus, 403);
  assert.equal(result.deltaErrorCode, 'ip_not_whitelisted_for_api_key');
  assert.equal(result.signedAuthPassed, false);
  assert.equal(result.outboundIp, '203.0.113.10');
});

test('Demo credential diagnostic flags missing or whitespace-padded values without exposing them', async () => {
  const logs = [];
  const result = await runOptionsDemoCredentialDiagnostic({
    env: { ...DEMO_ENV, DELTA_DEMO_API_KEY: '   ', DELTA_DEMO_API_SECRET: 'secret\n' },
    fetchImpl: async url => ({ ok: true, status: 200, async text() { return String(url).includes('api.ipify.org') ? '{"ip":"203.0.113.10"}' : '{"success":true}'; } }),
    logger: async (...args) => logs.push(args)
  });
  assert.equal(result.demoApiKeyConfigured, false);
  assert.equal(result.demoApiSecretConfigured, true);
  assert.equal(result.secretBasicFormatValid, false);
  assert.equal(result.deltaErrorCode, 'demo_credentials_missing');
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});
