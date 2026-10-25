import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('worker exposes a minimal HTTP health port before private API preflight', async () => {
  const index = await read('../worker/index.mjs');
  assert.match(index, /import \{ createServer \} from 'node:http'/);
  assert.match(index, /Number\(process\.env\.PORT \|\| 8000\)/);
  assert.match(index, /keepAliveServer\.listen\(HTTP_PORT, '0\.0\.0\.0'/);
  assert.match(index, /response\.statusCode = 200/);
  assert.ok(index.includes("application/json; charset=utf-8"));
  assert.ok(index.includes("status: workerHalted"));
  assert.ok(index.includes("uptime: Number(process.uptime().toFixed(1))"));
  assert.ok(index.indexOf('keepAliveServer.listen') < index.indexOf('const preflightOk = await startupPreflightWithRetry()'));
});

test('worker logs exact unhandled rejection and uncaught exception details', async () => {
  const index = await read('../worker/index.mjs');
  assert.match(index, /process\.on\('unhandledRejection'/);
  assert.match(index, /process\.on\('uncaughtException'/);
  assert.match(index, /processErrorDetails\(error\)/);
  assert.match(index, /details\.stack/);
  assert.match(index, /origin,/);
  assert.match(index, /pid: process\.pid/);
  assert.match(index, /Unhandled promise rejection; exact rejection captured/);
  assert.match(index, /Uncaught exception; exact stack captured before fail-closed exit of scanner loop; process remains alive/);
});

test('uncaught exceptions park the scanner fail-closed without terminating the process', async () => {
  const index = await read('../worker/index.mjs');
  const handlerStart = index.indexOf("process.on('uncaughtException', (error, origin) => {");
  const handlerEnd = index.indexOf("const preflightOk = await startupPreflightWithRetry();", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = index.slice(handlerStart, handlerEnd);
  assert.match(handler, /workerHalted = true/);
  assert.match(handler, /engine\.privateExecutionAvailable = false/);
  assert.match(handler, /await engine\.stop\(\)/);
  assert.match(handler, /HTTP health listener remains available/);
  assert.doesNotMatch(handler, /process\.exit\s*\(/);
});

test('transient startup and engine failures retry without process exit; lease conflicts skip cycles', async () => {
  const index = await read('../worker/index.mjs');
  const engine = await read('../worker/engine.mjs');
  const leaseStart = engine.indexOf('  async acquireLease() {');
  const leaseEnd = engine.indexOf('  async releaseLease()', leaseStart);
  assert.ok(leaseStart >= 0 && leaseEnd > leaseStart);
  assert.doesNotMatch(engine.slice(leaseStart, leaseEnd), /process\.exit\s*\(/);
  const runStart = engine.indexOf('  async run() {');
  const stopStart = engine.indexOf('  async stop() {', runStart);
  assert.ok(runStart >= 0 && stopStart > runStart);
  assert.doesNotMatch(engine.slice(runStart, stopStart), /process\.exit\s*\(/);
  assert.match(engine, /DUPLICATE WORKER DETECTED/);
  assert.match(engine, /Worker cycle skipped safely: trading lease is held by another worker/);
  assert.match(index, /async function startupPreflightWithRetry\(\)/);
  assert.match(index, /Startup preflight retry scheduled/);
  assert.match(index, /async function runEngineWithRecovery\(\)/);
  assert.match(index, /Engine loop failed; retry scheduled without process exit/);
  const startupStart = index.indexOf('const preflightOk = await startupPreflightWithRetry();');
  const engineLaunch = index.indexOf('void runEngineWithRecovery();', startupStart);
  assert.ok(startupStart >= 0 && engineLaunch > startupStart);
  assert.doesNotMatch(index.slice(startupStart, engineLaunch), /process\.exit\s*\(/);
  assert.match(index, /Graceful shutdown finished; exitCode=0/);
  assert.match(index, /Process exit event/);
});

test('worker process.exit calls are restricted to explicit signal shutdown', async () => {
  const workerRoot = fileURLToPath(new URL('../worker/', import.meta.url));
  async function collectJsFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const groups = await Promise.all(entries.map(async entry => {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) return collectJsFiles(fullPath);
      return entry.name.endsWith('.mjs') || entry.name.endsWith('.js') || entry.name.endsWith('.cjs') ? [fullPath] : [];
    }));
    return groups.flat();
  }
  const files = await collectJsFiles(workerRoot);
  const calls = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    content.split('\n').forEach((line, index) => {
      if (line.includes('process.exit(')) {
        calls.push({ file: relative(workerRoot, file).split(sep).join('/'), line: index + 1 });
      }
    });
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.file === 'index.mjs'));
  const index = await read('../worker/index.mjs');
  const shutdownStart = index.indexOf('async function shutdownWorker(signal)');
  const shutdownEnd = index.indexOf("process.on('unhandledRejection'", shutdownStart);
  assert.ok(shutdownStart >= 0 && shutdownEnd > shutdownStart);
  assert.equal(index.slice(0, shutdownStart).includes('process.exit('), false);
  assert.equal(index.slice(shutdownEnd).includes('process.exit('), false);
});

test('public and private websocket outbound callbacks catch send failures and reconnect', async () => {
  const engine = await read('../worker/engine.mjs');
  const tracker = await read('../worker/execution/delta-tracker.mjs');
  assert.match(engine, /handleMarketWebSocketCallbackFailure\(ws, error, 'open\/subscription'\)/);
  assert.match(engine, /WebSocket callback failed safely; reconnect scheduled/);
  assert.match(tracker, /private WebSocket subscription failed; reconnect scheduled/);
  assert.match(tracker, /cleanupWebSocketListeners\(socket\)/);
});

test('SIGTERM logs uptime and health-server state before an intentional graceful exit', async () => {
  const index = await read('../worker/index.mjs');
  assert.match(index, /process\.on\('SIGTERM'/);
  assert.match(index, /httpHealthServerListening: keepAliveServer\.listening/);
  assert.match(index, /uptimeSeconds: Number\(process\.uptime\(\)\.toFixed\(1\)\)/);
  assert.match(index, /process\.exit\(0\)/);
});
