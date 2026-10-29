import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('engine bounds candle cache, diagnostics, and analysis universe to turnover leaders', async () => {
  const engine = await read('../worker/engine.mjs');
  assert.match(engine, /CANDLE_CACHE_MAX_SYMBOLS/);
  assert.match(engine, /selectTopCandleSymbols/);
  assert.match(engine, /pruneCandleCacheState/);
  assert.match(engine, /this\.candleCacheSymbols\.has\(normalizedSymbol\)/);
  assert.match(engine, /this\.candleCacheSymbols\.has\(String\(symbol\)\.toUpperCase\(\)\)/);
  assert.match(engine, /const tickers = \[\.\.\.this\.tickerMap\.values\(\)\]\.filter/);
  assert.match(engine, /candleCacheLimit: this\.candleCacheLimit/);
});

test('public WebSocket subscribes to selected candle symbols, not all-market candle feeds', async () => {
  const engine = await read('../worker/engine.mjs');
  const connectStart = engine.indexOf('  connectWs() {');
  const connectEnd = engine.indexOf('  getTradetronBridgeForSymbol(', connectStart);
  assert.ok(connectStart >= 0 && connectEnd > connectStart);
  const connect = engine.slice(connectStart, connectEnd);
  assert.match(connect, /this\.syncCandleWebSocketSubscription\(ws\)/);
  assert.match(connect, /name: 'ticker', symbols: \['perpetual_futures'\]/);
  assert.doesNotMatch(connect, /name: 'candlestick_1m', symbols: \['perpetual_futures'\]/);
  assert.match(connect, /cleanupWebSocketListeners\(ws\)/);
});

test('worker logs memory at startup, every five minutes, and in the heartbeat', async () => {
  const engine = await read('../worker/engine.mjs');
  const monitor = await read('../worker/memory-monitor.mjs');
  assert.match(monitor, /MEMORY_LOG_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(engine, /process\.memoryUsage\(\)/);
  assert.match(engine, /this\.startMemoryMonitor\(\)/);
  assert.match(engine, /this\.recordMemoryUsage\('startup'\)/);
  assert.match(engine, /setInterval\([\s\S]*?MEMORY_LOG_INTERVAL_MS\)/);
  assert.match(engine, /Worker heartbeat scan ' \+ formatMemoryLog\(heartbeatMemory\)/);
  assert.match(engine, /cachedCandles: heartbeatCandleCount/);
});

test('both public and private WebSockets detach listeners on teardown', async () => {
  const engine = await read('../worker/engine.mjs');
  const tracker = await read('../worker/execution/delta-tracker.mjs');
  assert.match(engine, /cleanupWebSocketListeners\(ws\)/);
  assert.match(engine, /cleanupWebSocketListeners\(socket\)/);
  assert.match(tracker, /cleanupWebSocketListeners\(socket\)/);
});

test('lease contention is logged and stops the scan loop fail-closed', async () => {
  const engine = await read('../worker/engine.mjs');
  const runStart = engine.indexOf('  async run() {');
  const runEnd = engine.indexOf('  async stop()', runStart);
  assert.ok(runStart >= 0 && runEnd > runStart, 'worker run loop should be present');
  const run = engine.slice(runStart, runEnd);
  assert.ok(run.includes("if (message.includes('Trading lease is held by another worker'))"),
    'lease contention must be explicitly handled');
  assert.ok(run.includes("await this.log('WARN', 'Worker cycle skipped safely: trading lease is held by another worker'"),
    'lease skips must be visible at WARN level');
  const leaseBranchStart = run.indexOf("if (message.includes('Trading lease is held by another worker'))");
  const leaseBranchEnd = run.indexOf("} else {", leaseBranchStart);
  assert.ok(leaseBranchStart >= 0 && leaseBranchEnd > leaseBranchStart, 'lease branch should be bounded');
  const leaseBranch = run.slice(leaseBranchStart, leaseBranchEnd);
  assert.match(leaseBranch, /this\\.running = false;/,
    'lease contention must stop the scan loop so no further cycle can route entries');
  assert.doesNotMatch(leaseBranch, /\\bthrow\\b/,
    'the lease branch must be handled without throwing out of the scan loop');
  assert.ok(run.includes("await this.releaseLease();"),
    'the worker must release its lifetime lease during shutdown');
});
