export const DELTA_INDIA_LIVE_PUBLIC_REST = 'https://api.india.delta.exchange';
export const DELTA_INDIA_LIVE_PUBLIC_WS = 'wss://public-socket.india.delta.exchange';
export const DELTA_INDIA_TESTNET_REST = 'https://cdn-ind.testnet.deltaex.org';

/**
 * Resolve a Delta request in Hybrid Mode.
 * - Public market data: anonymous GET only, production India endpoint.
 * - Execution/account requests: authenticated and Testnet endpoint only.
 * - Testnet product metadata: anonymous GET only, used solely to resolve
 *   Demo product IDs and trading constraints.
 */
export function resolveHybridDeltaRequest({
  method = 'GET',
  authenticated = false,
  executionMetadata = false,
  testnetBase = DELTA_INDIA_TESTNET_REST
} = {}) {
  const verb = String(method || 'GET').trim().toUpperCase();
  if (authenticated) {
    if (testnetBase !== DELTA_INDIA_TESTNET_REST) {
      throw new Error('Authenticated Delta requests are restricted to India Testnet');
    }
    return { base: DELTA_INDIA_TESTNET_REST, purpose: 'DEMO_EXECUTION_OR_ACCOUNT' };
  }
  if (verb !== 'GET') {
    throw new Error('Unauthenticated Delta requests must be read-only GET requests');
  }
  if (executionMetadata) {
    if (testnetBase !== DELTA_INDIA_TESTNET_REST) {
      throw new Error('Testnet execution metadata host is invalid');
    }
    return { base: DELTA_INDIA_TESTNET_REST, purpose: 'DEMO_EXECUTION_METADATA' };
  }
  return { base: DELTA_INDIA_LIVE_PUBLIC_REST, purpose: 'LIVE_PUBLIC_MARKET_DATA' };
}
