import { CONFIG } from './config.js';

async function requestPublic(base, path, params) {
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { cache: 'no-store' });
  const text = await response.text();
  if (!response.ok) throw new Error('Delta public ' + response.status + ': ' + text.slice(0, 300));
  const data = JSON.parse(text);
  if (data.success === false) throw new Error('Delta public API error');
  return { result: data.result, meta: data.meta || {}, date: response.headers.get('date') };
}

export function publicGet(path, params) {
  return requestPublic(CONFIG.restBase, path, params);
}

// Daily candles are public production market data in both SIGNAL_ONLY and
// Testnet execution profiles; never route chart data through the Testnet host.
export function publicMarketDataGet(path, params) {
  return requestPublic(CONFIG.marketDataRestBase, path, params);
}