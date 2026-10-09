import { CONFIG } from './config.js';

export async function publicGet(path, params) {
  const url = new URL(CONFIG.restBase + path);
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