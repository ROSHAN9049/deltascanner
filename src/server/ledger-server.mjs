import express from 'express';
import { db, closePool, testConnection } from '../ledger/pg-adapter.mjs';
import { PositionLedger } from '../ledger/index.mjs';
import registerTradetronWebhook from '../webhooks/index.mjs';
import registerLedgerStatusRoute from '../routes/index.mjs';
import { tradetronAPI } from '../adapters/tradetron-snapshot-adapter.mjs';

// Temporary logger for this optional standalone process. Replace with the
// project's real logger if one is introduced; never log secrets or env values.
const logger = {
  info(message, meta = {}) { console.info(new Date().toISOString(), message, meta); },
  warn(message, meta = {}) { console.warn(new Date().toISOString(), message, meta); },
  error(message, meta = {}) { console.error(new Date().toISOString(), message, meta); }
};

const app = express();
const positionLedger = new PositionLedger(db, { logger });

registerTradetronWebhook(app, { db, positionLedger, logger });
registerLedgerStatusRoute(app, { positionLedger, tradetronAPI, logger });

const PORT = Number(process.env.LEDGER_SERVER_PORT || 4100);

async function start() {
  try {
    await testConnection();
  } catch (error) {
    logger.error('Ledger server startup database check failed', {
      error: error.message,
      code: error.code
    });
    process.exit(1);
    return;
  }

  const server = app.listen(PORT, () => {
    logger.info('Optional ledger server listening', { port: PORT });
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Ledger server shutting down', { signal });
    server.close(async error => {
      if (error) logger.error('HTTP server close failed', { error: error.message });
      try {
        await closePool();
        process.exit(error ? 1 : 0);
      } catch (poolError) {
        logger.error('PostgreSQL pool close failed', { error: poolError.message });
        process.exit(1);
      }
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
