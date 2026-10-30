# Deploy DealDost entirely on Hostless

The runtime is split by workload:

- **Hostless Site** serves the Vite frontend from the CDN.
- **Hostless App** serves the JSON API routes over HTTPS.
- **Hostless Worker** runs the continuous market scanner and Delta India Testnet execution loop.
- **Supabase** remains the existing PostgreSQL data store. Do not migrate or recreate its tables as part of this hosting change.

A Hostless Worker is for background processing and does not receive web requests. Do not move the dashboard API into the worker process.

## 1. Create the API App

In the same Hostless project, create an **App** named `deltascanner-api` from GitHub repository `ROSHAN9049/deltascanner`, branch `main`.

Configure:

- Build command: `npm ci && npm run build`
- Start command: `node server/hostless-api.mjs`
- Health-check path: `/healthz`
- Runtime: Node.js 22 or newer
- Listen address/port: binds to `0.0.0.0` and reads Hostless `PORT`.

The App serves dashboard APIs only. It must not start another scanner or place orders.

## 2. API App environment

Set these as **private runtime variables on the Hostless App**:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DELTA_ENVIRONMENT` | `SIGNAL_ONLY` |
| `DELTA_EXECUTION_MODE` | `testnet` |
| `SUPABASE_URL` | Same project URL used by the Hostless Worker |
| `SUPABASE_SERVICE_ROLE_KEY` | Same private server-side key used by the Hostless Worker |
| `ENGINE_SECRET` | Same private engine session secret used by the Hostless Worker |
| `APP_ALLOWED_ORIGINS` | Exact HTTPS origin of the Hostless Site, without a path or trailing slash |

The API App does **not** need Delta API key/secret credentials. The scanner Worker remains the only process that owns Delta Testnet private API credentials.

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

Keep all existing private Worker environment variables and its current Delta India Testnet-only configuration. Do not remove the Worker, rotate credentials, restart it solely for this migration, or change Supabase settings.

## Rollback

If the API App or Site deployment fails, roll back only the affected Hostless App or Site deployment. Do not alter the Worker or Supabase state. Keep Vercel paused; this migration must not rely on Vercel functions.
