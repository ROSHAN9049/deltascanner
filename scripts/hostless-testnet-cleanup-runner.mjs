#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runForceClose } from './force-close-testnet-positions.mjs';

/**
 * Temporary Hostless command for a single, explicit Testnet cleanup attempt.
 *
 * Run this by intentionally changing the Hostless worker command to:
 *   node scripts/hostless-testnet-cleanup-runner.mjs
 *
 * Unlike invoking the one-shot cleanup script directly as a long-running
 * worker command, this wrapper starts the normal scanner afterward so the
 * platform does not restart a completed cleanup process in a loop.
 * Restore the worker command to "node worker/index.mjs" as soon as the
 * cleanup summary is visible in Hostless logs.
 */
export async function runCleanupThenStartWorker({
  runCleanup = runForceClose,
  startWorker = () => import('../worker/index.mjs'),
  log = console.log,
  warn = console.warn
} = {}) {
  log('[HostlessForceClose] Temporary one-time Testnet cleanup runner started.');

  try {
    const result = await runCleanup({ argv: ['--confirm'] });
    const summary = {
      initialOpenPositions: result?.initialOpenPositions ?? null,
      closeOrdersSubmitted: result?.closeOrdersSubmitted ?? null,
      failures: Array.isArray(result?.failures) ? result.failures.length : null,
      remainingPositions: Array.isArray(result?.remainingPositions)
        ? result.remainingPositions.length
        : null,
      verifiedFlat: result?.verifiedFlat === true
    };
    log('[HostlessForceClose] Cleanup summary: ' + JSON.stringify(summary));
    if (!summary.verifiedFlat || summary.failures > 0) {
      warn('[HostlessForceClose] Cleanup is NOT verified flat; inspect the preceding logs before considering the task complete.');
    }
  } catch (error) {
    warn('[HostlessForceClose] Cleanup attempt failed safely: ' + String(error?.message || error));
  }

  // Keep Hostless running a long-lived worker even if cleanup fails; never
  // let the one-shot action become an automatic restart/retry loop.
  log('[HostlessForceClose] Starting the normal DeltaScanner worker now.');
  await startWorker();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  void runCleanupThenStartWorker().catch(error => {
    console.error('[HostlessForceClose] Normal worker failed to start:', String(error?.message || error));
    process.exitCode = 1;
  });
}
