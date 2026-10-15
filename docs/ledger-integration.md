# PositionLedger Integration Guide

PositionLedger is a separate ledger intended to record positions from authenticated Tradetron fill webhooks. It is designed to provide a position count independent of potentially stale or incomplete read-only snapshots. This guide documents a parallel observability/ingestion path only. It does **not** enable live trading, modify the existing entry gate, or automatically switch the position-cap source.

**CRITICAL — architecture:** The repository uses ESM, a Supabase REST wrapper, and worker/serverless handlers. The ledger runs in an optional, separate Express process using a direct PostgreSQL `pg.Pool` connection. It does not replace the worker or modify its entry gate.

## Prerequisites

- A PostgreSQL database with `src/ledger/migrations/001_position_ledger.sql` applied. The migration is not applied by committing it to GitHub.
- The server-side environment variable `TRADETRON_WEBHOOK_SECRET` configured wherever the new webhook handler will actually run.
- Node.js, Express, and `pg` installed from `package.json` dependencies.
- `DATABASE_URL` set in the optional ledger server's environment (preferred); `SUPABASE_DB_URL` is accepted as a fallback. Never print either variable.
- Supabase PostgreSQL direct connection is reachable over SSL. The configured Transaction Pooler host may be IPv6-first; if the deployment is IPv4-only, enable the Supabase IPv4 add-on or use a compatible Session Pooler connection string.
- The optional ledger server performs `SELECT 1` before listening and exits with status 1 if the startup database check fails.
- The existing snapshot-based position cap MUST remain active. Do not remove or bypass it.
- A database adapter compatible with the ledger's expected `db.query(sql, params)` contract. The existing `server/db.js` is a Supabase PostgREST wrapper exposing functions such as `select`, `insert`, and `update`; it does not expose `query`.
- A logger object with `info`, `warn`, and `error` methods. No standalone logger module was found; the worker currently uses console methods and `server/db.js` exports a database-backed `log` helper.

The CommonJS implementations use `.cjs` extensions so they remain CommonJS under `"type": "module"`. ESM wrappers in `src/ledger/index.mjs`, `src/webhooks/index.mjs`, and `src/routes/index.mjs` expose them to the ESM server.

## Step 1 — Run the Migration

Apply `src/ledger/migrations/001_position_ledger.sql` to the intended PostgreSQL database. From the repository root, run:

```bash
psql -h <host> -U <user> -d <db> -f src/ledger/migrations/001_position_ledger.sql
```

Then connect to the same database and verify that the three tables exist:

```sql
\dt position_ledger
\dt webhook_events
\dt system_meta
```

**WARNING:** Do not run this migration twice. It uses `BEGIN`/`COMMIT` and `CREATE TABLE` without `IF NOT EXISTS`; a second run will fail because the tables already exist. If rerun-safe behavior is required, wrap the migration in the database migration runner and track applied migrations.

The current `server/db.js` remains REST-based and unchanged. The separate `src/ledger/pg-adapter.mjs` connects directly to PostgreSQL using `DATABASE_URL` (or fallback `SUPABASE_DB_URL`), with SSL enabled and a pool size of five. Apply the migration to the same Supabase database referenced by that connection string.

## Step 2 — Configure Environment Variable

Set a unique, high-entropy secret shared only with the eventual webhook sender:

```dotenv
TRADETRON_WEBHOOK_SECRET=<value-from-tradetron-dashboard>
```

- **WARNING:** Never commit the actual secret.
- Add it to the host's encrypted/sensitive environment-variable store. For local development, use a local `.env` file only if your local runner loads it.
- Keep `.env` out of source control; the repository's `.gitignore` already ignores `.env`.
- Rotate the secret immediately if it is leaked.
- The repository's `server/config.js` already reads `TRADETRON_WEBHOOK_SECRET` for the existing `/api/tradetron/webhook` receiver, but that existing route uses a bearer/custom-secret scheme. The new `src/webhooks/tradetron-handler.cjs` uses an HMAC signature header, `x-tradetron-signature`; these are distinct endpoint contracts.
- If the new handler's `verifySignature()` cannot run because the secret is missing, its route catches the error and returns HTTP 500. The error does not, by itself, crash the server.

**Important:** A secret only authenticates inbound requests. It does not configure Tradetron to send webhooks. The repository documentation records that Tradetron support said outbound webhook delivery is unavailable for this account; a verified event source or separately reviewed relay is still required.

## Step 3 — Wire the PositionLedger Instance

The current repository does not have a root `app.js`, `server.js`, or `index.js` Express entry point. The worker entry point is `worker/index.mjs`; deployed API endpoints are Vercel serverless functions. Do not mount Express routes into `worker/index.mjs`, which is a background worker rather than an Express app.

The following is the requested composition pattern for a **future compatible HTTP host**. It is not runnable unchanged against the current `server/db.js` wrapper.

```javascript
// In a compatible HTTP host (TODO: choose/add the host and module format):
const { PositionLedger } = require('./src/ledger/PositionLedger');

import { db } from './src/ledger/pg-adapter.mjs';

// The optional server defines a temporary timestamped console logger.

const positionLedger = new PositionLedger(db, { logger });

// This instance does not replace any existing position tracking.
// It runs parallel to the current snapshot-based guard.
```

**TODO:** Do not substitute the current `server/db.js` exports for `db` without implementing and testing the required `query` contract. Do not change the position-cap guard as part of this setup.

## Step 4 — Register the Webhook Route

In the same compatible Express host, after creating `app`, the database adapter, the logger, and the `positionLedger` instance:

```javascript
const registerTradetronWebhook = require('./src/webhooks/tradetron-handler');

registerTradetronWebhook(app, {
  db,
  positionLedger,
  logger
});
```

This registers `POST /webhook/tradetron`.

- `express.raw({ type: 'application/json', limit: '1mb' })` is applied to this route only. The exact body bytes are required for HMAC-SHA256 verification.
- Invalid signatures return HTTP 401.
- Missing `TRADETRON_WEBHOOK_SECRET` returns HTTP 500 for signature verification.
- A successfully processed event or duplicate returns HTTP 200.
- Processing failures return HTTP 500, allowing a sender that retries 5xx responses to retry.
- Every audited payload must be valid JSON because the database column is JSONB.

**Do not confuse endpoints:** The existing Vercel route is `/api/tradetron/webhook` in `api/tradetron/webhook.js`. The new CommonJS Express module registers `/webhook/tradetron`. This documentation does not change, replace, or mount over the existing route.

## Step 5 — Register the Ledger Status Route

The standalone server already registers these routes. For reference, the intended ESM pattern is:

```javascript
const registerLedgerStatusRoute = require('./src/routes/ledger-status');

import { tradetronAPI } from './src/adapters/tradetron-snapshot-adapter.mjs';

registerLedgerStatusRoute(app, {
  positionLedger,
  tradetronAPI,
  logger
});
```

This registers:

- `GET /api/ledger/status` — a fresh ledger count plus best-effort snapshot reconciliation.
- `GET /api/ledger/health` — a fresh ledger count without calling Tradetron.

Both routes are read-only. The dashboard can poll `/api/ledger/status` to detect a mismatch. Snapshot or reconciliation failure is represented as partial response data rather than failing the whole status request; failure of the ledger count itself returns HTTP 500.

**Adapter note:** `src/adapters/tradetron-snapshot-adapter.mjs` wraps `TradetronDeveloperApi.fetchSnapshot()` and flattens nested deployment `positions` into `{ symbol, side }` rows. It logs a warning and skips rows with unexpected shapes. Verify side and signed-quantity semantics against live API samples before relying on reconciliation; snapshots are not authenticated fill events.

## Step 6 — What Is NOT Changed (CRITICAL)

The following remain **UNCHANGED** by this integration:

1. The existing entry gate still uses its current position-count and safety inputs. It is not switched to `PositionLedger`.
2. The snapshot-based safety guard remains active and fail-closed when its state is untrusted.
3. Global position-cap enforcement remains driven by the existing settings, read-only Developer API snapshot, and unexpired signal reservations—not by `getGlobalCount()`.
4. Trading settings, symbol allowlists, and order routing are unchanged.
5. Live signal generation and existing order/trigger logic are unchanged.

The current cap check is in `server/tradetron.js`, in `TradetronBridge.checkGlobalPositionCap()` and the final check in `TradetronBridge.emitEntry()`. The existing code checks the cap before it can emit the Tradetron entry trigger:

```javascript
// UNCHANGED — do not replace with positionLedger.getGlobalCount()
// until webhook delivery is verified end-to-end.
const capCheck = await this.checkGlobalPositionCap({
  symbol: selected,
  executionId: execution
});
if (capCheck.blocked) {
  if (Date.now() - this.lastPositionCapWarningAt >= 60_000) {
    this.lastPositionCapWarningAt = Date.now();
    await db.log('WARN', 'Tradetron entry blocked by final position-cap safety guard', {
      symbol: selected,
      executionId: execution,
      reason: capCheck.reason,
      currentOpenPositionSymbols: capCheck.openPositionSymbols,
      configuredMaxOpenPositions: capCheck.maxOpenPositions,
      globalPositionCapBlocked: capCheck.globalPositionCapBlocked === true,
      note: 'No Tradetron entry trigger was sent; existing positions are not closed by this guard'
    });
  }
  return {
    ok: false,
    skipped: true,
    positionSafetyBlocked: true,
    globalPositionCapBlocked: capCheck.globalPositionCapBlocked === true,
    symbol: selected,
    executionId: execution,
    reason: capCheck.reason
  };
}
```

**CRITICAL:** Keep this check in place. An empty PositionLedger currently returns a fresh count of zero; that means “zero positions in this new ledger,” not “zero open positions in Tradetron.” The ledger remains parallel and non-authoritative until webhook delivery and coverage have been proven.

## Step 7 — Verification Checklist

Run these checks only after the database migration and a compatible host/adapter have been configured and deployed.

1. Apply the migration and confirm all three tables exist.
2. Set `TRADETRON_WEBHOOK_SECRET` in the deployment's secure environment.
3. Restart/redeploy the new HTTP host with the reviewed wiring. Do not change the live entry gate.
4. Call `curl -i https://<your-host>/api/ledger/health`. Expected when the ledger is empty and the database is reachable: HTTP 200 with `{"ok":true,"ledgerCount":0}`.
5. Call `curl -i https://<your-host>/api/ledger/status`. If the adapter successfully returns normalized open positions and Tradetron has real open positions while the ledger is empty, expect `isSynced: false`. If snapshot retrieval fails, `isSynced: null` is expected instead; it means sync was not confirmed.
6. In staging, send a synthetic test webhook signed over the exact raw JSON body using the configured secret. Expected: HTTP 200 for a valid event and a corresponding row in `position_ledger` for a valid `ENTRY_FILLED`. A locally signed synthetic test proves the receiver can verify a signature; it does **not** prove that Tradetron is delivering real production events.
7. In staging, send the same valid-shaped test payload with an invalid signature. Expected: HTTP 401 and an audit row in `webhook_events` with status `SIGNATURE_FAILED`.

**Current limitation:** The optional server is separate and is not automatically started by the worker. Tradetron outbound webhook delivery has been reported unavailable for this account; do not treat the checklist as complete until an event sender/relay is configured and verified.

## Step 8 — Rollback

If the new host wiring causes problems:

1. Stop the optional ledger process and revert the specific ledger-server or wiring commit(s) using `git revert <SHA>`.
2. Do not change or restart the existing worker as part of this rollback; the optional server is a separate process.
3. The PositionLedger tables can remain in place; they are inert without a consumer writing to them.
4. If removal is explicitly approved and the audit history is no longer needed, drop the tables:

```sql
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS position_ledger;
DROP TABLE IF EXISTS system_meta;
```

**WARNING:** Dropping these tables permanently loses webhook audit history and any position records in the new ledger. Do not drop them as a routine rollback step. This rollback does not require changing or resetting existing trading settings.

## Step 9 — Go-Live Prerequisites (Before Switching the Gate)

**HARD REQUIREMENT:** Do not switch the live entry gate to `getGlobalCount()` until every item below is complete and evidenced:

- [ ] **HARD REQUIREMENT:** Tradetron outbound webhook delivery is configured and verified, or an independently verified relay delivers authenticated per-trade events.
- [ ] **HARD REQUIREMENT:** At least 7 days of continuous webhook receipt have been observed without unexplained gaps.
- [ ] **HARD REQUIREMENT:** Reconciliation shows `isSynced: true` consistently against normalized, sufficiently complete position data.
- [ ] **HARD REQUIREMENT:** Partial-fill handling has been validated using real, independently verified events.
- [ ] **HARD REQUIREMENT:** Exit idempotency has been validated using real exit/retry events.
- [ ] **HARD REQUIREMENT:** Server restart, duplicate delivery, failed processing, and sender retry behavior have been tested.
- [ ] **HARD REQUIREMENT:** The rollback plan has been rehearsed on staging.

**Current go-live blocker:** Repository documentation records that Tradetron support reported direct outbound webhook delivery unavailable for this account. Do not switch the gate based on the presence of the receiver, an empty ledger, accepted signals, notification text, or snapshot P&L. A supported source/relay and end-to-end event evidence are required first.

## Appendix — File Reference

| File | Purpose |
|------|---------|
| `src/ledger/migrations/001_position_ledger.sql` | Database schema for positions, webhook audit events, and observability metadata |
| `src/ledger/PositionLedger.cjs` | CommonJS ledger class, signature verification, count queries, and snapshot reconciliation |
| `src/ledger/index.mjs` | ESM wrapper for PositionLedger |
| `src/ledger/pg-adapter.mjs` | Direct PostgreSQL pool and `query(sql, params)` adapter |
| `src/webhooks/tradetron-handler.cjs` | Express webhook handler with raw-body HMAC verification |
| `src/webhooks/index.mjs` | ESM wrapper for webhook registration |
| `src/routes/ledger-status.cjs` | Read-only dashboard status and health endpoints |
| `src/routes/index.mjs` | ESM wrapper for status route registration |
| `src/adapters/tradetron-snapshot-adapter.mjs` | Normalizes read-only Tradetron snapshots |
| `src/server/ledger-server.mjs` | Optional, separate Express server for ledger routes |
| `docs/ledger-integration.md` | This integration guide |

## Running Tests

The project uses Node.js's built-in `node:test` runner; no Jest, Mocha, or Vitest dependency is required.

From the repository root:

```bash
npm test
npm run test:smoke
```

- `npm test` runs the `*.test.mjs` tests in the top-level `tests/` directory, including the ledger, webhook, status-route, and smoke tests.
- `npm run test:smoke` runs the lightweight module-load smoke test. It does not issue database queries or call the Tradetron snapshot endpoint.
- `npm run smoke:ledger` is a **manual integration smoke test** and is not part of `npm test`. It requires `DATABASE_URL`, an applied migration, database network access, and the appropriate Tradetron Developer API configuration for snapshot retrieval. Run it only when intentionally checking the configured database and read-only snapshot API.

The manual script prints counts and a final summary only. It does not print database connection strings, credentials, or snapshot rows. It verifies the required tables and current ledger counts; it does not insert, update, close, or reset any position.

## Refactor Note: ledger-server.mjs

`src/server/ledger-server.mjs` exports `createApp(deps)` to compose the optional Express routes without starting a listener, and `main(deps)` to perform the startup connection check, listen, and install graceful-shutdown handlers.

The module only invokes `main()` automatically when executed directly with `node src/server/ledger-server.mjs`. Importing it from tests or another module no longer starts the HTTP server. The optional standalone process remains separate from `worker/index.mjs`; the existing live gate, trading configuration, and execution behavior are not changed.

