import express from 'express';
import { pathToFileURL } from 'node:url';
import { db, closePool, testConnection } from '../ledger/pg-adapter.mjs';
import { PositionLedger } from '../ledger/index.mjs';
import registerTradetronWebhook from '../webhooks/index.mjs';
import registerLedgerStatusRoute from '../routes/index.mjs';
import { tradetronAPI } from '../adapters/tradetron-snapshot-adapter.mjs';

// Temporary logger for this optional standalone process. Replace with the
// project's real logger if one is introduced; never log secrets or env values.
const defaultLogger = {
  info(message, meta = {}) { console.info(new Date().toISOString(), message, meta); },
  warn(message, meta = {}) { console.warn(new Date().toISOString(), message, meta); },
  error(message, meta = {}) { console.error(new Date().toISOString(), message, meta); }
};

/**
 * Compose the optional ledger HTTP app without starting a listener or
 * making a database connection. Dependencies may be injected for tests.
 */
export function createApp(deps = {}) {
  const app = deps.app || express();
  const appDb = deps.db || db;
  const logger = deps.logger || defaultLogger;
  const positionLedger = deps.positionLedger || new PositionLedger(appDb, { logger });
  const api = deps.tradetronAPI || tradetronAPI;

  (deps.registerTradetronWebhook || registerTradetronWebhook)(app, {
    db: appDb,
    positionLedger,
    logger
  });
  (deps.registerLedgerStatusRoute || registerLedgerStatusRoute)(app, {
    positionLedger,
    tradetronAPI: api,
    logger
  });

  return app;
}

/**
 * Start the optional standalone ledger process. This is only invoked
 * automatically when this module is executed as the entry-point script.
 */
export async function main(deps = {}) {
  const logger = deps.logger || defaultLogger;
  const connectionCheck = deps.testConnection || testConnection;
  const poolCloser = deps.closePool || closePool;
  const port = Number(deps.port ?? process.env.LEDGER_SERVER_PORT ?? 4100);
  const app = createApp(deps);

  try {
    await connectionCheck();
  } catch (error) {
    // The adapter intentionally returns a sanitized error. Keep logging to a
    // safe code only so connection strings or credentials cannot leak here.
    logger.error('Ledger server startup database check failed', {
      code: error && error.code ? error.code : undefined
    });
    process.exitCode = 1;
    return null;
  }

  const server = app.listen(port, () => {
    logger.info('Optional ledger server listening', { port });
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Ledger server shutting down', { signal });
    server.close(async error => {
      if (error) logger.error('HTTP server close failed', { error: error.message });
      try {
        await poolCloser();
        process.exit(error ? 1 : 0);
      } catch (poolError) {
        logger.error('PostgreSQL pool close failed', { error: poolError.message });
        process.exit(1);
      }
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Avoid printing arbitrary startup exception content that could contain
    // credentials supplied by a database driver or remote service.
    console.error('Optional ledger server failed to start; details suppressed.');
    process.exitCode = 1;
  });
}
