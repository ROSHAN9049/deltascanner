# Deploy the Delta scanner worker on Hostless Cloud

This guide runs the existing standalone Node.js scanner worker as a **Hostless Worker resource**. It does not deploy the dashboard as the worker, and it does not change the scanner's signal calculations.

## 1. Connect the repository

In Hostless, create a **Worker** resource and connect GitHub repository `ROSHAN9049/deltascanner`, branch `main` (or the reviewed branch containing the deployment script). Use the repository root as the working directory.

- Install/build command: `npm ci`
- Start command: `npm run worker:start`
- Replicas: **1** initially. Do not run two scanner replicas until singleton/lease and duplicate-routing behavior have been explicitly verified.
- Allocate enough CPU and memory for the continuous market scan; start with Hostless defaults and increase only if logs/metrics show resource pressure.

The `worker:start` script runs `node worker/index.mjs`. This is a long-running background process, not a public HTTP server.

## 2. Add environment variables in Hostless

Add these in the Worker's secret/environment-variable UI. Do not commit secret values to GitHub or share them in chat.

### Required

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `WORKER_ID` | `delta-hostless-worker-1` (unique identifier) |
| `DELTA_ENVIRONMENT` | `SIGNAL_ONLY` |
| `DELTA_EXECUTION_MODE` | `testnet` only when ready to enable Demo/Testnet order routing |
| `DELTA_TESTNET_API_KEY` | API key created in the **Delta India Demo/Testnet account** |
| `DELTA_TESTNET_API_SECRET` | Secret belonging to that same Demo/Testnet key |
| `DELTA_TESTNET_REST_BASE` | `https://cdn-ind.testnet.deltaex.org` |
| `DELTA_TESTNET_WS_URL` | `wss://socket-ind.testnet.deltaex.org` |
| `SUPABASE_URL` | URL of the existing Delta Scanner Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for that same Supabase project |
| `ENGINE_SECRET` | Existing long random engine secret |

The REST and WebSocket endpoint values must match exactly. The code rejects any attempt to point the Testnet executor at the production trading API. `DELTA_ENVIRONMENT=SIGNAL_ONLY` must stay set for the public-market scanner even when the separate execution mode is Testnet.

### PostgreSQL retention and disk monitoring

Set `DATABASE_URL` to the existing Supabase PostgreSQL **Transaction Pooler** connection string (with SSL enabled). Without `DATABASE_URL` or `SUPABASE_DB_URL`, the worker's PostgreSQL retention and disk monitor are disabled. Keep these safeguards enabled:

- `RETENTION_ENABLED=true`
- `RETENTION_DAYS=1`
- `RETENTION_BATCH_SIZE=5000`
- `DISK_WARN_ROWS=250000`
- `DISK_CRITICAL_ROWS=500000`
- `RETENTION_OLD_ROWS_TRIGGER=50000`

### Routing safety

For a direct Delta Demo/Testnet trial, set `TRADETRON_BRIDGE_ENABLED=false` and `TRADETRON_DYNAMIC_BRIDGE_ENABLED=false` so the same signal is not also sent through Tradetron. Do not add Tradetron credentials unless the Tradetron route is deliberately being used.

**Execution caution:** `DELTA_EXECUTION_MODE=testnet` permits orders against the Delta Demo/Testnet account when confirmed signals and all safety checks pass. Entering these variables is an explicit decision to run Demo/Testnet execution. Do not use production-account Delta credentials. `live` mode is blocked in code.

## 3. Confirm the database migration

The migration `db/migrations/20261024100000_delta_testnet_positions.sql` has already been applied to the existing Supabase project for this deployment. Do not create a second position table or point this worker to another database.

## 4. Start and verify

After saving variables, start/redeploy the Hostless Worker and inspect its logs. Expected startup checks include:

- Supabase connectivity OK.
- Delta India public market API OK.
- Authenticated Delta TESTNET API OK, with verified account equity and open-position count.
- Private WebSocket authenticated and subscribed to `orders` and `positions`.
- Scanner worker entering engine loop with execution mode `testnet`.

Stop and investigate if preflight fails, the WebSocket cannot authenticate, or the account equity/position snapshot is unavailable. Safety checks are designed to fail closed. Check the **Delta Testnet Positions** dashboard separately from Tradetron positions.

## 5. Cutover safety

Do not enable a second live scanner instance or move the dashboard here as part of this worker setup. The current Railway service should remain stopped/unused during Hostless validation; do not run both platforms concurrently. First verify startup, retention, signal sampling, order reservation, bracket/close, Emergency Stop, and daily-loss protections using the Demo/Testnet account. Production/live trading is outside this deployment and remains blocked in code.
