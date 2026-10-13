# DealDost Delta India Scanner

Production-market signal-only perpetual futures scanner and Node worker using Delta Exchange India's documented v2 API. The scanner reads live Delta India market data and sends signals to Tradetron; it never places direct Delta production orders.

## Required environment
DELTA_ENVIRONMENT=SIGNAL_ONLY
ENGINE_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
WORKER_ID (optional)

Tradetron bridge execution additionally requires:
TRADETRON_BRIDGE_ENABLED=true
TRADETRON_AUTH_TOKEN

The production Delta public market API is the only market-data endpoint used in SIGNAL_ONLY mode. Private Delta execution is structurally disabled.

## Database
Run db/schema.sql against a dedicated Supabase/Postgres trading database. Do not reuse an unrelated website database.

## Railway worker
Use the repository as the Railway service, Node 22+, start command:
node worker/index.mjs

The browser is monitor/control only. Production market-data calls are server-side in the worker and protected by the database lease. Tradetron owns any simulated/live execution.

## Official Delta details verified
Production REST base: https://api.india.delta.exchange
Production public WebSocket: wss://public-socket.india.delta.exchange

Authentication uses HMAC-SHA256 over HTTP method + Unix timestamp + request path + query string + JSON body. client_order_id is limited to 32 characters. Products expose contract_value, tick_size, leverage/notional limits and maker/taker commission rates. Wallet balances are available at /v2/wallet/balances, positions at /v2/positions and /v2/positions/margined, fills at /v2/fills, orders at /v2/orders, and bracket protection at /v2/orders/bracket.

## Strategy
Two closed-candle engines: MOMENTUM and SCALPING. Both use trend/RSI/volume/ATR/anti-chase/BTC-regime/spread/cost gates and enforce a hard minimum score of 80 for CONFIRMED. A confirmed futures signal is not marked READY unless its symbol maps to a configured Tradetron route. Quantity is integer contracts sized from equity risk and product contract_value, capped by configured 3x notional.

Scanner-wide, per-engine, Options and total open-position caps are disabled. The scanner also has no daily trade-count quota or daily P&L stop. Technical quality, live-data freshness, route availability, per-trade risk sizing, fees/spread, margin and same-symbol duplicate protection remain. When Continuous Mode is OFF, the existing symbol cooldown and strategy-expectancy throttles may still apply; they are not a daily trade quota.

## Important assumption
Delta documents size as an integer number of contracts. The current docs consulted do not expose a separate minimum-order-size or size-increment field for perpetuals. Therefore this build uses whole contracts and lets the exchange enforce any additional product-specific minimum. Non-vanilla notional types are skipped by the sizing engine.

An 80% win rate cannot be guaranteed. The implementation is intentionally selective; actual win rate must be measured from real Demo fills after sufficient sample size.

## Tradetron Signal Bridge

Tradetron integration is production-market / signal-only. The scanner never places direct Delta production orders. Tradetron Live Offline is the intended forward-test execution layer. When enabled, confirmed scanner entries are sent to the deployed Tradetron API-controlled Signal Bridge instead of placing a direct Delta order from the worker. This prevents dual execution paths.

Bridge mode also removes the worker's dependency on Delta private API credentials: the worker reads public Delta market data, while Tradetron owns authenticated execution. This is intended to avoid Delta API IP-whitelist coupling on a cloud worker whose outbound IP may change. See `docs/tradetron-dynamic-bridge.md` for the runtime contract and validation sequence.

Required variables when enabling the futures bridge:
- `TRADETRON_BRIDGE_ENABLED=true`
- `TRADETRON_AUTH_TOKEN=<fresh Tradetron API auth token>`
- `TRADETRON_SUPPORTED_SYMBOLS=<comma-separated symbols configured in the linked strategy>`
- `TRADETRON_CAPITAL_USD=51.5` for the project's INR 5,000 planning capital (the sizing value is USD, not INR). Change it only by converting the intended INR capital to USD; a fresh exchange rate may be used whenever capital is recalibrated.

The fallback supported-symbol allowlist matches the reported 34-symbol strategy: AAPLXUSD, ADAUSD, ALGOUSD, AMDBUSD, AMZNXUSD, ATOMUSD, AVAXUSD, BCHUSD, BNBUSD, BTCUSD, CBRSBUSD, COINXUSD, CRCLXUSD, DOGEUSD, DRAMBUSD, ETHUSD, EWYBUSD, GOOGLXUSD, INTCBUSD, LINKUSD, LITEBUSD, LTCUSD, MATICUSD, METAXUSD, MSTRBUSD, MUBUSD, NBISBUSD, NEARUSD, PAXGUSD, SNDKBUSD, SOXLBUSD, SPCXXUSD, WDCBUSD and WIFUSD. An explicit environment value overrides this fallback. This variable only allows symbols already configured in Tradetron; it does not add strategy legs. Signals for symbols outside the active allowlist are blocked rather than reported as sent.

For multiple static baskets, set `TRADETRON_BRIDGES_JSON` to a validated JSON array containing each bridge's unique `id`, `symbols` list and unique `authToken`. When set, it fully replaces single-token symbol routing, and entries and exits are sent through the mapped bridge. Configure it only after each Tradetron strategy and its token are created/verified; never put actual tokens in source control or chat. See `docs/tradetron-dynamic-bridge.md` for the format.

Optional:
- `TRADETRON_BASE_URL=https://api.tradetron.tech`
- `TRADETRON_TIMEOUT_MS=10000`

A separate Options route is disabled by default. The Options scanner is hard-limited to BTC, ETH and Gold (Delta underlying symbol XAUT); it never scans/options-routes the full perpetual-futures universe. Only after creating and verifying a dedicated Options strategy in Tradetron, configure:
- `TRADETRON_OPTIONS_BRIDGE_ENABLED=true`
- `TRADETRON_OPTIONS_AUTH_TOKEN=<token linked to that separate Options strategy>`

The futures bridge writes the legacy `<SYMBOL>_q` quantity read by the inspected strategy, plus `<SYMBOL>_qty` for compatibility, entry/exit metadata, the symbol-specific `_el/_es` entry trigger, and `api_buy/api_sell`. On verified webhook-linked Momentum/Scalping futures positions, the scanner can request `_xl/_xs` exits when fresh market marks cross stop/target or max-hold rules. This exit monitor requires Tradetron outbound activity to be configured and the simulated position to be synced back into `dd_positions`; it is not proof of an exchange-side bracket. The auth token is never printed in logs.

In SIGNAL_ONLY mode, recent unconfirmed Tradetron entry signals reserve their symbol temporarily. A `PENDING` or `SIGNAL_SENT` reservation older than 15 minutes is marked `EXPIRED` and stops blocking the scanner if no authenticated activity confirmation arrives. Expiry means only that the confirmation window elapsed; it is not evidence of a fill, close, or loss. Authenticated activity events are still required to sync actual Tradetron positions into `dd_positions`. Reservations do not impose a global position cap; same-symbol duplicate protection remains active during the 15-minute confirmation window. This does not make a signal an executed trade.

Keep the Tradetron deployment in **Live Offline** while validating the bridge. Do not switch to Live Auto until the end-to-end signal, symbol routing, quantity, and exit behavior have been verified. Tradetron outbound activity can be posted to `/api/tradetron/webhook` so the scanner can display received fills/events.

### Inbound Tradetron activity endpoint

The scanner has an inbound endpoint for activity events, if a supported sender/relay is configured:

`/api/tradetron/webhook`

Set `TRADETRON_WEBHOOK_SECRET` as a **sensitive Production environment variable in the Vercel `deltascanner` project** (this path is a Vercel serverless function, not a Railway worker endpoint), then redeploy the Vercel project. Configure the sender to provide the same secret as `Authorization: Bearer <secret>` or `x-tradetron-webhook-secret: <secret>`; the `?secret=<secret>` fallback should only be used if the sender cannot set headers. Never put the secret in source control.

Tradetron's current public integrations page advertises outbound webhooks for fills, errors, and kill-switch events to HTTPS endpoints. That confirms the platform advertises an outbound-webhook capability, but the account-specific configuration and payload fields still need a Live Offline test. Confirm that the chosen event type can call `/api/tradetron/webhook` with the configured authentication header. **TT SIGNALS** means the scanner sent a signal to Tradetron; it does not prove a fill occurred. **TT EVENTS** only increases after an authenticated event is received. Keep the Tradetron deployment in **Live Offline** until the signal → execution → event → dashboard round-trip is verified.

The parser accepts JSON and form-encoded payloads and normalizes common event/side field shapes.


## Read-only Tradetron Developer API position snapshot

The worker can optionally poll Tradetron's documented read-only Developer API. This is separate from the existing signal bridge token and from the authenticated outbound webhook.

1. Create a read-only key in Tradetron → Developer API. Enable only the permissions needed to read your deployments, their positions/P&L, and optionally notifications.
2. In the Railway worker service, add the sensitive variable `TRADETRON_DEVELOPER_API_KEY`. Never add this key to Vercel browser variables, React code, Git, logs, or chat.
3. Keep `TRADETRON_DEVELOPER_API_BASE_URL` at `https://tradetron.tech/api/v1` unless Tradetron documents a different URL for your account. The separate `TRADETRON_BASE_URL` used for signal submission is not the same configuration.
4. Apply `db/migrations/20261012080000_tradetron_developer_api_sync.sql` in the Supabase SQL editor before relying on the snapshot panel. The tables have RLS enabled and direct anon/authenticated access revoked; the worker writes them using the server-side service key.
5. The single leased Railway worker polls no more than once per minute and reads deployment summaries plus each deployment's positions endpoint. The sync limits a cycle to eight deployments and two deployment-list pages. This keeps the normal single-deployment account far below Tradetron's documented per-key rate limit; a partial result is visibly marked.
6. The dashboard displays the API's position records separately from webhook-ingested `dd_positions`. It does not manufacture `dd_positions` or pretend an accepted signal was filled. Tradetron's position record schema needs a non-empty real sample before any automatic mapping into the webhook position ledger can responsibly be enabled. For privacy, these account snapshots are returned by the dashboard API only with a valid `ENGINE_SECRET`; configure that existing control secret in Vercel and enter it in the dashboard Settings panel to view the private snapshots. Keep `TRADETRON_DEVELOPER_API_KEY` exclusively on the Railway worker.
7. If `positions_hidden` is true, an empty array is not treated as a zero-position confirmation. If Tradetron returns an empty array with `positions_hidden:false`, the panel reports no records returned.
8. For the market table, only the frontend's visible rows are limited to 40 by turnover ranking. The API and worker universe remain untrimmed; Momentum/Scalping analysis continues across all products with the existing candle-warm-up schedule. The worker batches actionable signal-history inserts once per full analysis instead of making hundreds of serial HTTP insert calls.
9. Keep the scanner in SIGNAL_ONLY and Options execution locked. Grid entries/exits may use the existing Tradetron futures bridge only for a configured BTCUSD/ETHUSD route; the bridge has one net position/exit flag per symbol, so Grid is restricted to one open position and must remain in Tradetron Live Offline for simulated validation. Non-bottom Grid entries use the next lower rung as their protective stop and the next higher rung as target; the default per-trade risk is 0.30%, matching Momentum/Scalping; the bottom rung remains blocked when its range-break stop makes reward/risk unattractive. The read-only Developer API integration does not enable order placement.

The account's Developer API interface showed Bearer authentication and these tested endpoints: `GET /api/v1/me/deployments`, `GET /api/v1/me/deployments/{id}/positions`, and `GET /api/v1/me/notifications`. The positions response tested during setup had `positions_hidden:false` and an empty `positions[]`; no position rows could therefore be schema-mapped or used as a fill test yet.
