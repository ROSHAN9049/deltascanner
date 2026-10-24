# Deploy the Delta scanner worker on Hostless Cloud

This guide runs the existing standalone Node.js scanner worker as a **Hostless Worker resource**. It does not deploy the dashboard as the worker, and it does not change the scanner's signal calculations.

## 1. Connect the repository

In Hostless, create a **Worker** resource and connect GitHub repository `ROSHAN9049/deltascanner`, branch `main` after the deployment PR is merged (or the review branch before that). Use the repository root as the working directory.

- Install/build command: `npm ci`
- Start command: `npm run worker:start`
- Replicas: **1** initially. Do not run two scanner replicas until singleton/lease and duplicate-routing behavior have been explicitly verified.
- Allocate enough CPU and memory for the continuous market scan; start with Hostless defaults and increase only if logs/metrics show resource pressure.

The `worker:start` script runs `node worker/index.mjs`. This is a long-running background process, not a public HTTP server.

## 2. Add environment variables in Hostless

Add these in the Worker's secret/environment-variable UI. Do not commit secret values to GitHub or share them in chat.

### Required for the safe first boot

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `WORKER_ID` | `delta-hostless-worker-1` (unique identifier) |
| `DELTA_ENVIRONMENT` | `SIGNAL_ONLY` |
| `DELTA_EXECUTION_MODE` | `disabled` for the initial scan-only validation |
| `TRADETRON_BRIDGE_ENABLED` | `true` for startup compatibility during scan-only validation |
| `TRADETRON_DYNAMIC_BRIDGE_ENABLED` | `false` |
| `TRADETRON_AUTH_TOKEN` | Leave blank during scan-only validation, so the Tradetron bridge remains unconfigured |
| `SUPABASE_URL` | URL of the existing Delta Scanner Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for that same Supabase project |
| `ENGINE_SECRET` | Existing long random engine secret |

This initial configuration scans public market data and connects to Supabase, but has no configured external order route. The direct Delta executor remains disabled.

### Only when explicitly ready to test Demo/Testnet order routing

| Variable | Value |
| --- | --- |
| `DELTA_EXECUTION_MODE` | `testnet` |
| `DELTA_TESTNET_API_KEY` | API key created in the **Delta India Demo/Testnet account** |
| `DELTA_TESTNET_API_SECRET` | Secret belonging to that same Demo/Testnet key |
| `DELTA_TESTNET_REST_BASE` | `https://cdn-ind.testnet.deltaex.org` |
| `DELTA_TESTNET_WS_URL` | `wss://socket-ind.testnet.deltaex.org` |
| `TRADETRON_BRIDGE_ENABLED` | `false` |
| `TRADETRON_DYNAMIC_BRIDGE_ENABLED` | `false` |

The REST and WebSocket endpoint values must match exactly. The code rejects any attempt to point the Testnet executor at the production trading API. Keep `DELTA_ENVIRONMENT=SIGNAL_ONLY` for the public-market scanner even when the separate execution mode is Testnet. When `DELTA_EXECUTION_MODE=testnet` is selected, the worker may place Demo/Testnet orders after confirmed signals and all safety checks pass. Do not use production-account Delta credentials. `live` mode is blocked in code.

## 3. PostgreSQL retention and disk monitoring

Set `DATABASE_URL` to the existing Supabase PostgreSQL **Transaction Pooler** connection string (with SSL enabled). Without `DATABASE_URL` or `SUPABASE_DB_URL`, the worker's PostgreSQL retention and disk monitor are disabled. Keep these safeguards enabled:

- `RETENTION_ENABLED=true`
- `RETENTION_DAYS=1`
- `RETENTION_BATCH_SIZE=5000`
- `DISK_WARN_ROWS=250000`
- `DISK_CRITICAL_ROWS=500000`
- `RETENTION_OLD_ROWS_TRIGGER=50000`

## 4. Confirm the database migration

The migration `db/migrations/20261024100000_delta_testnet_positions.sql` has already been applied to the existing Supabase project for this deployment. Do not create a second position table or point this worker to another database.

## 5. Start and verify

Start/redeploy the Hostless Worker with the **safe first-boot** settings and inspect its logs. Confirm Supabase connectivity, public market API health, retention scheduling, and that the engine loop starts. The Tradetron bridge may log that its auth token is missing; that is expected during scan-only validation.

Do not switch to Testnet mode until scan stability, signal sampling, retention, and database health have been verified. When the Testnet variables are added, expected logs include authenticated Delta TESTNET API status with verified equity/open positions and private WebSocket authentication/subscriptions for `orders` and `positions`. Investigate any preflight failure or unavailable account/position snapshot before proceeding. Check the **Delta Testnet Positions** dashboard separately from Tradetron positions.

## 6. Cutover safety

Do not move the dashboard here as part of this worker setup. Keep the current Railway service stopped/unused during Hostless validation; do not run both platforms concurrently. Verify the worker first in scan-only mode, then separately verify order reservation, bracket/close, Emergency Stop, and daily-loss protections using the Demo/Testnet account. Production/live trading is outside this deployment and remains blocked in code.
