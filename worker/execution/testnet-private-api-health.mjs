export const DELTA_TESTNET_PRIVATE_API_RETRY_MS = 5 * 60 * 1000;

export function canExecuteDeltaTestnetOrders(mode, privateExecutionAvailable) {
  return String(mode || '').toLowerCase() !== 'testnet' || privateExecutionAvailable === true;
}

export function isPrivateApiConnectivityError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  const message = String(error?.message || error || '');
  return status === 401 || status === 403 || status >= 500 ||
    /ip_not_whitelisted_for_api_key|unauthori[sz]ed|forbidden|fetch failed|network error|ECONN(?:RESET|REFUSED|UNREACHABLE)|ETIMEDOUT|EHOSTUNREACH|socket hang up|timed out|failed \((?:401|403|5\d\d)\)/i.test(message);
}

export async function checkDeltaTestnetPrivateApi(executor) {
  if (!executor || typeof executor.getAccountSnapshot !== 'function' ||
      typeof executor.getOpenPositions !== 'function') {
    throw new Error('Delta Testnet private API probe is not configured');
  }

  const [account, positions] = await Promise.all([
    executor.getAccountSnapshot(),
    executor.getOpenPositions()
  ]);

  if (!account || !Number.isFinite(Number(account.equity)) || Number(account.equity) <= 0) {
    throw new Error('Delta Testnet wallet/equity snapshot is unavailable');
  }
  if (!Array.isArray(positions)) {
    throw new Error('Delta Testnet positions snapshot is unavailable');
  }

  return { account, positions };
}
