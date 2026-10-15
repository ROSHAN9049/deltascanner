'use strict';

/**
 * Register read-only ledger observability routes.
 *
 * These endpoints report ledger counts and an optional comparison with
 * Tradetron's read-only snapshot. They never mutate positions, update cached
 * metadata, change trading settings, or influence/block an entry gate.
 */
module.exports = function registerLedgerStatusRoute(app, deps) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('registerLedgerStatusRoute requires an app with get()');
  }

  const { positionLedger, tradetronAPI, logger } = deps || {};

  if (!positionLedger || typeof positionLedger.getGlobalCount !== 'function') {
    throw new TypeError('registerLedgerStatusRoute requires positionLedger.getGlobalCount()');
  }
  if (!tradetronAPI || typeof tradetronAPI.getSnapshot !== 'function') {
    throw new TypeError('registerLedgerStatusRoute requires tradetronAPI.getSnapshot()');
  }
  if (!logger || typeof logger.error !== 'function') {
    throw new TypeError('registerLedgerStatusRoute requires a logger with error()');
  }

  app.get('/api/ledger/status', async function ledgerStatusHandler(req, res) {
    let ledgerCount;

    try {
      // getGlobalCount() performs a fresh DB query. It never reads from the
      // system_meta cache, which is observability only and can be stale.
      ledgerCount = await positionLedger.getGlobalCount();
    } catch (ledgerError) {
      logger.error('Failed to read ledger count', {
        error: ledgerError.message,
      });

      return res.status(500).json({
        error: 'Ledger count unavailable',
        detail: ledgerError.message,
      });
    }

    let snapshot = null;
    let snapshotError = null;

    // Snapshot failure must NOT fail the request. The dashboard needs to
    // render even when Tradetron's read-only API is unreachable.
    try {
      const raw = await tradetronAPI.getSnapshot();
      // Reconciliation expects normalized { symbol, side } snapshot entries.
      snapshot = Array.isArray(raw) ? raw : [];
    } catch (err) {
      snapshotError = err.message || 'Snapshot unavailable';
      if (typeof logger.warn === 'function') {
        logger.warn('Tradetron snapshot fetch failed', {
          error: snapshotError,
        });
      }
    }

    let diff = null;

    if (snapshot !== null) {
      try {
        diff = await positionLedger.reconcileWithSnapshot(snapshot);
      } catch (reconcileError) {
        logger.error('Reconciliation failed', {
          error: reconcileError.message,
        });
        // Keep returning useful count information even if reconciliation fails.
        diff = null;
      }
    }

    const response = {
      ledgerCount: ledgerCount,
      snapshotCount: snapshot !== null ? snapshot.length : null,
      diff: diff,
      generatedAt: new Date().toISOString(),
    };

    if (snapshotError) {
      response.snapshotError = snapshotError;
    }

    if (diff === null && snapshot !== null) {
      response.reconcileError = 'Reconciliation failed';
    }

    // isSynced === null means sync could not be confirmed (snapshot unavailable
    // or reconciliation failed), not that the ledger and snapshot are synced.
    // The dashboard should show a warning banner when isSynced === false,
    // and a softer warning when isSynced === null (snapshot unavailable).
    response.isSynced = diff ? diff.isSynced : null;

    return res.status(200).json(response);
  });

  // Optional health probe. This reads the fresh ledger count only and does
  // not call Tradetron or mutate state.
  app.get('/api/ledger/health', async function ledgerHealthHandler(req, res) {
    try {
      const count = await positionLedger.getGlobalCount();
      return res.status(200).json({ ok: true, ledgerCount: count });
    } catch (err) {
      logger.error('Ledger health check failed', { error: err.message });
      return res.status(503).json({ ok: false, error: err.message });
    }
  });
};
