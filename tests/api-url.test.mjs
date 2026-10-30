import test from 'node:test';
import assert from 'node:assert/strict';
import { joinApiUrl } from '../src/api-url.js';

test('joins API paths to the configured Hostless App origin', () => {
  assert.equal(joinApiUrl('/api/health', 'https://api.example/'), 'https://api.example/api/health');
  assert.equal(joinApiUrl('/api/market?type=tickers', 'https://api.example'), 'https://api.example/api/market?type=tickers');
});

test('keeps local development same-origin when no API base is configured', () => {
  assert.equal(joinApiUrl('/api/engine/state', ''), '/api/engine/state');
});

test('rejects non-API paths and API base URLs that contain paths', () => {
  assert.throws(() => joinApiUrl('/dashboard', 'https://api.example'), /must start with \/api\//);
  assert.throws(() => joinApiUrl('/api/health', 'https://api.example/backend'), /without a path/);
});
