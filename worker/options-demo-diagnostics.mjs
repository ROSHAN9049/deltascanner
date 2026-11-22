import crypto from 'node:crypto';

export const DELTA_DEMO_DIAGNOSTIC_REST_BASE = 'https://cdn-ind.testnet.deltaex.org';

const clean = value => String(value ?? '').trim();

async function readResponseBody(response) {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    try {
      const value = await response.json();
      return { value, raw: '' };
    } catch {
      return { value: null, raw: '' };
    }
  }
  if (!raw) return { value: null, raw };
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    return { value: null, raw };
  }
}

function withTimeoutSignal(timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
}

async function lookupOutboundIp(fetchImpl) {
  const timeout = withTimeoutSignal();
  try {
    const response = await fetchImpl('https://api.ipify.org?format=json', {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'DealDost-Delta-Demo-Diagnostic/1.0' },
      signal: timeout.signal
    });
    const { value } = await readResponseBody(response);
    const ip = clean(value?.ip);
    return response.ok && ip ? ip : null;
  } catch {
    return null;
  } finally {
    timeout.clear();
  }
}

/**
 * Runs one non-mutating authenticated Demo/Testnet wallet read on Worker
 * startup. It never logs credentials, signatures, request headers or bodies.
 */
export async function runOptionsDemoCredentialDiagnostic({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  logger = async () => {},
  now = () => Date.now()
} = {}) {
  const mode = clean(env.OPTIONS_EXECUTION_MODE).toLowerCase();
  if (mode !== 'demo') return { skipped: true, reason: 'OPTIONS_EXECUTION_MODE is not demo' };

  const rawKey = String(env.DELTA_DEMO_API_KEY ?? '');
  const rawSecret = String(env.DELTA_DEMO_API_SECRET ?? '');
  const apiKey = rawKey.trim();
  const apiSecret = rawSecret.trim();
  const apiKeyConfigured = apiKey.length > 0;
  const apiSecretConfigured = apiSecret.length > 0;
  // Delta documents randomly generated credentials but does not publish a
  // fixed token regex. This basic check detects empty, whitespace-padded,
  // control-character or non-ASCII values without guessing a token format.
  const keyBasicFormatValid = apiKeyConfigured && rawKey === apiKey && /^[\x21-\x7E]+$/.test(apiKey);
  const secretBasicFormatValid = apiSecretConfigured && rawSecret === apiSecret && /^[\x21-\x7E]+$/.test(apiSecret);
  const restBase = clean(env.DELTA_TESTNET_REST_BASE || DELTA_DEMO_DIAGNOSTIC_REST_BASE).replace(/\/+$/, '');
  const restBaseMatched = restBase === DELTA_DEMO_DIAGNOSTIC_REST_BASE;
  const testnetProfileMatched =
    clean(env.DELTA_EXECUTION_MODE).toLowerCase() === 'testnet' &&
    clean(env.DELTA_ENVIRONMENT).toUpperCase() === 'TESTNET' &&
    restBaseMatched;

  const report = {
    environment: 'DELTA_DEMO',
    keyEnvName: 'DELTA_DEMO_API_KEY',
    secretEnvName: 'DELTA_DEMO_API_SECRET',
    demoApiKeyConfigured: apiKeyConfigured,
    demoApiSecretConfigured: apiSecretConfigured,
    demoCredentialsConfigured: apiKeyConfigured && apiSecretConfigured,
    keyLength: apiKey.length,
    secretLength: apiSecret.length,
    keyBasicFormatValid,
    secretBasicFormatValid,
    keyWhitespaceOrControlDetected: apiKeyConfigured && !keyBasicFormatValid,
    secretWhitespaceOrControlDetected: apiSecretConfigured && !secretBasicFormatValid,
    testnetProfileMatched,
    restBaseMatched,
    restBase: restBaseMatched ? DELTA_DEMO_DIAGNOSTIC_REST_BASE : '[NOT_TESTNET_BASE]',
    outboundIp: await lookupOutboundIp(fetchImpl),
    signedAuthHttpStatus: null,
    deltaErrorCode: null,
    deltaErrorMessage: null,
    signedAuthPassed: false
  };

  if (!apiKeyConfigured || !apiSecretConfigured) {
    report.deltaErrorCode = 'demo_credentials_missing';
  } else if (!testnetProfileMatched) {
    report.deltaErrorCode = 'demo_testnet_profile_mismatch';
  } else {
    const method = 'GET';
    const path = '/v2/wallet/balances';
    const query = '';
    const payload = '';
    const timestamp = String(Math.floor(now() / 1000));
    const signature = crypto.createHmac('sha256', apiSecret)
      .update(method + timestamp + path + query + payload, 'utf8')
      .digest('hex');
    const timeout = withTimeoutSignal(7000);
    try {
      const response = await fetchImpl(DELTA_DEMO_DIAGNOSTIC_REST_BASE + path, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'DealDost-Delta-Demo-Diagnostic/1.0',
          'api-key': apiKey,
          signature,
          timestamp
        },
        signal: timeout.signal
      });
      const { value, raw } = await readResponseBody(response);
      report.signedAuthHttpStatus = Number(response.status) || null;
      report.deltaErrorCode = clean(value?.error?.code || value?.error?.name) || null;
      const errorMessage = clean(value?.error?.message || value?.message);
      report.deltaErrorMessage = errorMessage
        ? errorMessage.split(apiKey).join('[REDACTED]')
          .split(apiSecret).join('[REDACTED]').slice(0, 240)
        : (!value && raw ? 'non_json_response' : null);
      report.signedAuthPassed = Boolean(response.ok && value?.success !== false);
      if (report.signedAuthPassed) report.deltaErrorCode = null;
      else if (!report.deltaErrorCode) {
        report.deltaErrorCode = response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden'
            : response.status >= 500
              ? 'exchange_server_error'
              : 'signed_auth_failed';
      }
    } catch (error) {
      report.deltaErrorCode = clean(error?.name) === 'AbortError' ? 'diagnostic_request_timeout' : 'diagnostic_network_error';
      report.deltaErrorMessage = clean(error?.message).split(apiKey).join('[REDACTED]')
        .split(apiSecret).join('[REDACTED]').slice(0, 240) || null;
    } finally {
      timeout.clear();
    }
  }

  await logger(
    report.signedAuthPassed ? 'INFO' : 'WARN',
    '[OptionsDemoDiagnostics] Startup credential and signed-auth diagnostic',
    report
  );
  return report;
}
