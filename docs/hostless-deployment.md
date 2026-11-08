# Deploy DealDost entirely on Hostless

The runtime is split by workload:

- **Hostless Site** serves the Vite frontend from the CDN.
- **Hostless App** serves the JSON API routes over HTTPS.
- **Hostless Worker** runs the continuous market scanner and Delta India Testnet execution loop.
- **Supabase** remains the existing PostgreSQL data store. Do not migrate or recreate its tables as part of this hosting change.

A Hostless Worker is for background processing and does not receive web requests. Do not move the dashboard API into the worker process.

## 1. Create the API App

In the same Hostless project, create an **App** named `deltascanner-api-v2` from GitHub repository `ROSHAN9049/deltascanner`, branch `main`.

Configure:

- Build command: `npm ci && npm run build`
- Start command: `node server/hostless-api.mjs`
- Health-check path: `/healthz`
- Runtime: Node.js 22 or newer
- Listen address/port: binds to `0.0.0.0` and reads Hostless `PORT`.

The App serves dashboard APIs and authenticated, manual Options Testnet endpoints. It must not start another scanner or route Futures orders. Options execution remains independently disabled unless its private environment flag is deliberately enabled.

## 2. API App environment

Set these as **private runtime variables on the Hostless App**:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DELTA_ENVIRONMENT` | `TESTNET` |
| `DELTA_EXECUTION_MODE` | `testnet` |
| `DELTA_TESTNET_API_KEY` | Private Delta India Testnet API key |
| `DELTA_TESTNET_API_SECRET` | Private Delta India Testnet API secret |
| `DELTA_TESTNET_REST_BASE` | `https://cdn-ind.testnet.deltaex.org` |
| `DELTA_TESTNET_WS_URL` | `wss://socket-ind.testnet.deltaex.org` |
| `OPTIONS_EXECUTION_ALLOWED` | `false` (or absent) until API and Site verification is complete |
| `SUPABASE_URL` | Same project URL used by the Hostless Worker |
| `SUPABASE_SERVICE_ROLE_KEY` | Same private server-side key used by the Hostless Worker |
| `ENGINE_SECRET` | Same private engine session secret used by the Hostless Worker |
| `APP_ALLOWED_ORIGINS` | Exact HTTPS origin of the Hostless Site, without a path or trailing slash |

The API App needs the Delta India **Testnet-only** API key and secret because the authenticated manual Options preview/execution handlers resolve Testnet products, refresh quotes, and sign orders. The Worker retains its existing private Testnet credentials for its current execution responsibilities. Use Testnet credentials only; production/live credentials are not supported. Keep the Options flag false or absent during deployment verification.

For the optional Trailing Grid capability, set `GRID_TRAILING_ENABLED=true` on **both** the Hostless API App and the Hostless Worker after the database migration has been applied. The default is false; the dashboard's separate **Trailing Grid (Auto-Shift on Breakout)** setting must also be enabled. Do not add this flag to the Site. With either runtime flag absent/false, automatic shifts remain unavailable and the existing range-break halt behavior is retained. The environment variable does not change the existing 2% daily-loss, 5% strategy drawdown, Testnet-only, exchange-bracket, E-STOP, or position-size limits.

Never put `SUPABASE_SERVICE_ROLE_KEY`, `ENGINE_SECRET`, or Delta API credentials in Site variables or Vite build variables.

## 3. Connect the Site to the API App

After the API App has a stable HTTPS domain, add this **public build-time variable** to the Hostless Site:

`VITE_API_BASE_URL=https://<your-api-app-domain>`

Do not add a trailing path. It must be only the API App origin. Trigger a new Site deployment after saving the variable.

The frontend uses this value for every `/api/*` request and sends session cookies with credentialed requests. The API App accepts browser traffic only from the exact origin in `APP_ALLOWED_ORIGINS`.

If the Site domain changes, update `APP_ALLOWED_ORIGINS` on the App and redeploy it. If the API App domain changes, update `VITE_API_BASE_URL` on the Site and rebuild the Site.

## 4. Verify before enabling any entries

1. `https://<your-api-app-domain>/healthz` returns JSON with `success: true`.
2. `https://<your-api-app-domain>/api/health` returns JSON with a recent heartbeat, fresh tick, and an active worker lease.
3. `https://<your-api-app-domain>/api/market` returns a non-empty `result` array.
4. `https://<your-api-app-domain>/api/engine/state` returns JSON and reports worker execution mode `testnet` after a recent heartbeat is available.
5. The Site dashboard shows the market universe and no HTML/JSON parse error.
6. Unlock the private dashboard session and verify private Testnet positions are visible. Do not release E-STOP or change auto-trading settings as part of hosting verification.

Unknown routes and errors return JSON rather than falling through to the Site's `index.html`.

## 5. Keep the existing Worker intact

Keep the existing Hostless Worker start command:

`node worker/index.mjs`

Keep all existing private Worker environment variables and its current Delta India Testnet-only configuration. The Worker must retain `DELTA_EXECUTION_MODE=testnet`, `DELTA_ENVIRONMENT=TESTNET`, and `OPTIONS_EXECUTION_ALLOWED=false` (or absent) until the dashboard/API deployment has been verified. Do not remove the Worker, rotate credentials, restart it solely for this migration, or change Supabase settings.

## Rollback

If the API App or Site deployment fails, roll back only the affected Hostless App or Site deployment. Do not alter the Worker or Supabase state. Keep Vercel paused; this migration must not rely on Vercel functions.

## 6. Deploy the Options execution code (keep it locked)

After the reviewed Options PR is merged to `main`, deploy the same merged revision to the existing resources only:

1. **Worker `deltascanner-api`** — keep start command `node worker/index.mjs`; select the merged `main` revision and retain its current Supabase, engine-secret and Delta India Testnet variables. Set `DELTA_EXECUTION_MODE=testnet`, `DELTA_ENVIRONMENT=TESTNET`, and `OPTIONS_EXECUTION_ALLOWED=false` (or leave the flag absent). Do not change Auto Trade, E-STOP, Futures sizing, risk settings or existing positions.
2. **API App `deltascanner-api-v2`** — select the same merged `main` revision; build with `npm ci && npm run build`; start with `node server/hostless-api.mjs`; health check `/healthz`; use Node.js 22+. Add the same private Supabase URL/service key and `ENGINE_SECRET`, exact `APP_ALLOWED_ORIGINS`, the Delta India Testnet API key/secret and the exact Testnet REST/WS URLs above. Set `DELTA_EXECUTION_MODE=testnet`, `DELTA_ENVIRONMENT=TESTNET`, and `OPTIONS_EXECUTION_ALLOWED=false` (or absent). The API App must receive Testnet credentials because the authenticated Options order endpoint uses the Testnet signer. Never use Live credentials.
3. **Site `deltascanner-dashboard`** — select the same merged `main` revision; build `npm run build`; output directory `dist`; set only the public `VITE_API_BASE_URL=https://<API-App-domain>` value needed to point the dashboard to the API App. Do not place `OPTIONS_EXECUTION_ALLOWED`, Delta credentials, `ENGINE_SECRET` or Supabase service keys on the Site.

### Verification before enabling Options

- Confirm API `/healthz` and `/api/health` return JSON, the Worker heartbeat/tick are fresh, and the dashboard has no HTML-as-JSON error.
- Unlock the private dashboard session and verify account/Testnet positions. Keep E-STOP in its existing state; do not alter Futures controls or positions as part of this verification.
- In the Options tab, request a preview only. Confirm the exact Testnet product IDs, premium, fee allowance, maximum loss, current equity, and any protective BUY symbol. The final order button must remain disabled while `OPTIONS_EXECUTION_ALLOWED=false` or absent.
- Do not change the flag to true as part of deployment. Enabling it is a separate deliberate action after the deployed API and dashboard have been verified and a fresh Options preview is understood. The flag must be false/absent on both Worker and API App until that verification is complete.

If any Testnet product metadata, account balance, quote, confirmation token, position snapshot or worker tick is missing or stale, do not enable the flag and do not submit an order.
