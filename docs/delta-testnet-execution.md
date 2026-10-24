# Delta Demo/Testnet Execution (Railway)

This phase runs authenticated orders only against Delta India's Demo/Testnet API. Keep `DELTA_ENVIRONMENT=SIGNAL_ONLY` for the public scanner feed; `DELTA_EXECUTION_MODE` controls a separate private execution path. `live` is rejected by configuration, and the executor also requires `testnet` at every order boundary.

## Before enabling

1. Create API keys inside the **Delta Demo account**. Delta documents that India production-account keys are valid only on production APIs, while Demo-account keys are valid only on Testnet APIs. Never put keys in GitHub, the dashboard, screenshots, or chat.
2. Apply `db/migrations/20261024100000_delta_testnet_positions.sql` in the Supabase SQL editor before enabling execution. It creates a private table separate from Tradetron's `dd_positions`.
3. In Railway, open the worker service → Variables and add: `DELTA_EXECUTION_MODE`, `DELTA_TESTNET_API_KEY`, `DELTA_TESTNET_API_SECRET`, `DELTA_TESTNET_REST_BASE`, and `DELTA_TESTNET_WS_URL`. Existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ENGINE_SECRET` remain required.
4. Set `DELTA_TESTNET_REST_BASE` to `https://cdn-ind.testnet.deltaex.org`. The REST host is hardcoded in the executor; a mismatched configured value causes startup/config failure rather than switching hosts.
5. Set `DELTA_TESTNET_WS_URL` to `wss://socket-ind.testnet.deltaex.org`. The `socket-ind-pub` URL is the **public** WebSocket and cannot supply authenticated private orders/positions updates. The tracker signs `GET + timestamp + /live`, authenticates with `key-auth`, then subscribes to private `orders` and `positions` channels.
6. Restart/redeploy the Railway worker after setting variables. Keep Demo keys restricted to the permissions necessary for Testnet checks. Do not set `DELTA_EXECUTION_MODE=live`; the code rejects it.

## Routing and controls

- `DELTA_EXECUTION_MODE=testnet`: confirmed MOMENTUM/SCALPING entries use the Delta Testnet executor. Existing Tradetron bridge code remains available for rollback when mode is `disabled`; indicator and signal-quality calculations are unchanged.
- In this phase Grid **new entries are held** in Testnet mode. Existing Tradetron Grid exit monitoring is left intact for any legacy bridged Grid position; Grid execution is not silently recreated against a different venue.
- `DELTA_EXECUTION_MODE=disabled`: direct execution methods refuse orders, and the existing Tradetron bridge route is retained.
- Every entry is rejected if DB Emergency Stop is active/unreadable, same-symbol positions/orders/reservations exist, 20 open/reserved symbols are already present, account equity cannot be verified, daily P&L data cannot be trusted, or daily P&L is at/below -5% of current equity. Risk-reducing exit requests bypass entry cap/daily-loss limits but still require Testnet mode and Emergency Stop to be off.
- REST position reconciliation runs alongside authenticated WebSocket updates. The dashboard labels these rows separately as **Delta Testnet Positions**; they are not merged into Tradetron `dd_positions` or its P&L ledger.
- Supabase migration must be applied before entry guards can read the Testnet position ledger; missing DB state fails closed.

## Verification

After the PR is reviewed/merged and the worker is deployed, confirm the startup log says authenticated Delta Testnet API is ready, the private WebSocket reports successful auth/subscriptions, and the dashboard shows **Delta Testnet Positions**. Verify entry, bracket, fill, close, Emergency Stop and daily-loss behavior with Demo funds. Live execution is out of scope and remains blocked in code.
